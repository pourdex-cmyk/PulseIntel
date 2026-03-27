import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth, decryptToken } from '../../lib/middleware.js';

export const config = { runtime: 'nodejs' };

const PLATFORM_LABELS = { teams:'Teams', zoom:'Zoom', gmeet:'Google Meet', inperson:'In Person', phone:'Phone' };

export default withAuth(async (req, { user }) => {
  if (req.method !== 'POST') return error('Method not allowed', 405);

  const { meeting_id } = await req.json();

  const [meetResult, profileResult, settingsResult] = await Promise.all([
    supabaseAdmin.from('meetings').select('*').eq('id', meeting_id).eq('user_id', user.id).single(),
    supabaseAdmin.from('profiles').select('*').eq('id', user.id).single(),
    supabaseAdmin.from('user_settings').select('claude_key_encrypted').eq('user_id', user.id).single(),
  ]);

  if (meetResult.error) return error('Meeting not found', 404);

  const meeting = meetResult.data;
  const profile = profileResult.data || {};
  const apiKey  = settingsResult.data?.claude_key_encrypted
    ? await decryptToken(settingsResult.data.claude_key_encrypted)
    : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return error('No Claude API key configured', 400);

  // Fetch related messages
  let relatedMsgs = [];
  if (meeting.related_msg_ids?.length) {
    const { data } = await supabaseAdmin
      .from('messages').select('source,sender,subject,body,priority')
      .in('id', meeting.related_msg_ids).eq('user_id', user.id);
    relatedMsgs = data || [];
  }

  const client = new Anthropic({ apiKey });
  const model  = profile.model || 'claude-sonnet-4-20250514';

  const msgContext = relatedMsgs.length
    ? relatedMsgs.map(m => `- [${m.source}] From ${m.sender}: "${m.subject}" — ${(m.body || '').replace(/<[^>]+>/g,'').substring(0, 200)}`).join('\n')
    : 'No linked messages.';

  const prompt = `Generate a concise pre-meeting briefing.

MEETING: ${meeting.title}
DATE/TIME: ${meeting.date} at ${meeting.time} (${meeting.duration}) via ${PLATFORM_LABELS[meeting.platform] || meeting.platform}
ATTENDEES: ${(meeting.attendees || []).map(a => `${a.name} (${a.role || 'attendee'})`).join(', ') || 'None listed'}
AGENDA:
${(meeting.agenda || []).map((a, i) => `${i+1}. ${a.text} (${a.duration})`).join('\n') || 'No agenda set'}
PREP NEEDED:
${(meeting.needs || []).map(n => `- ${n.text}${n.done ? ' [DONE]' : ''}`).join('\n') || 'None'}
RELATED MESSAGES:
${msgContext}

Write a brief practical briefing:
1. Purpose of this meeting in one sentence
2. Key context from linked messages that matters going in
3. 2-3 specific talking points or questions to raise
4. Any risks or things to watch for

Tight and scannable — this is a quick pre-meeting read. Plain text, no markdown symbols.`;

  const message = await client.messages.create({
    model, max_tokens: 500,
    system: 'You are an AI executive assistant generating pre-meeting briefings. Specific, practical, concise. Plain text only.',
    messages: [{ role: 'user', content: prompt }]
  });

  const prep = message.content[0].text;

  // Save prep back to meeting
  await supabaseAdmin.from('meetings').update({ ai_prep: prep }).eq('id', meeting_id);

  return json({ prep });
});

