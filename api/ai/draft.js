import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth, decryptToken } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  if (req.method !== 'POST') return error('Method not allowed', 405);

  const { message_id } = await req.json();

  const [msgResult, profileResult, settingsResult] = await Promise.all([
    supabaseAdmin.from('messages').select('*').eq('id', message_id).eq('user_id', user.id).single(),
    supabaseAdmin.from('profiles').select('*').eq('id', user.id).single(),
    supabaseAdmin.from('user_settings').select('claude_key_encrypted').eq('user_id', user.id).single(),
  ]);

  if (msgResult.error) return error('Message not found', 404);

  const msg     = msgResult.data;
  const profile = profileResult.data || {};
  const apiKey  = settingsResult.data?.claude_key_encrypted
    ? await decryptToken(settingsResult.data.claude_key_encrypted)
    : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return error('No Claude API key configured', 400);

  const client = new Anthropic({ apiKey });
  const model  = profile.model || 'claude-sonnet-4-20250514';

  const userName    = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
  const hasProfile  = !!profile.first_name;
  const isChat      = msg.source === 'slack' || msg.source === 'teams';
  const tone        = profile.tone || 'professional';
  const draftLength = profile.draft_length || 'medium';

  const lengthMap = {
    short:  '2-3 sentences max.',
    medium: '3-5 sentences.',
    long:   'A thorough reply covering all points.'
  };

  const toneMap = {
    professional: 'Professional and warm. First-name basis is fine.',
    friendly:     'Conversational and friendly. Natural phrasing.',
    direct:       'Direct and brief. No pleasantries.',
    formal:       'Formal. Complete sentences. Polished language.'
  };

  const platformGuide = isChat
    ? `This is a ${msg.source} ${msg.type === 'channel' ? 'channel message' : 'DM'}. Skip greetings. Jump straight to the reply.`
    : `This is an email. Open with a greeting using their first name (${msg.sender.split(' ')[0]}). ${profile.signoff ? `Close with: "${profile.signoff}"` : 'End naturally.'}`;

  const identityLine = hasProfile
    ? `You are writing a reply on behalf of ${userName}${profile.title ? ', ' + profile.title : ''}${profile.company ? ' at ' + profile.company : ''}.`
    : 'You are writing a reply on behalf of the user. No profile set — write generically, do not sign.';

  const bodyText = msg.body?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || '';

  const prompt = `${identityLine}
${hasProfile && profile.style_notes ? `Their communication style: ${profile.style_notes}` : ''}

TONE: ${toneMap[tone]}
LENGTH: ${lengthMap[draftLength]}
PLATFORM: ${platformGuide}

NEVER USE: "Hope this helps", "Best regards", "I wanted to reach out", "Please let me know if you have any questions", "Going forward", "Circling back", "As per my last email"

Write a SPECIFIC reply referencing actual content — amounts, names, dates, tasks from the message.

MESSAGE:
Platform: ${msg.source}${msg.channel ? ' in ' + msg.channel : ''}
From: ${msg.sender} (${msg.handle})
Subject: ${msg.subject}
Message: ${bodyText}

Write only the reply. No preamble.`;

  const sysPrompt = hasProfile
    ? `You are ${userName}. Write in their voice. ${isChat ? 'Conversational for chat.' : 'Professional but human for email.'} Plain text only.`
    : `Write a professional reply. ${isChat ? 'Conversational.' : 'Professional but human.'} Plain text only.`;

  const message = await client.messages.create({
    model, max_tokens: 600,
    system: sysPrompt,
    messages: [{ role: 'user', content: prompt }]
  });

  return json({ draft: message.content[0].text.trim() });
});

