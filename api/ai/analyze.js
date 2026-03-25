import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth, decryptToken } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  if (req.method !== 'POST') return error('Method not allowed', 405);

  const { message_id, type = 'summary' } = await req.json();
  // type: 'summary' | 'deep' | 'thread'

  // Get the message
  const { data: msg, error: msgErr } = await supabaseAdmin
    .from('messages').select('*').eq('id', message_id).eq('user_id', user.id).single();
  if (msgErr) return error('Message not found', 404);

  // Get user's Claude key
  const { data: settings } = await supabaseAdmin
    .from('user_settings').select('claude_key_encrypted').eq('user_id', user.id).single();

  const apiKey = settings?.claude_key_encrypted
    ? await decryptToken(settings.claude_key_encrypted)
    : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return error('No Claude API key configured', 400);

  const { data: profile } = await supabaseAdmin
    .from('profiles').select('model').eq('id', user.id).single();
  const model = profile?.model || 'claude-sonnet-4-20250514';

  const client = new Anthropic({ apiKey });
  const bodyText = msg.body?.replace(/<[^>]+>/g, '') || msg.preview || '';

  const prompts = {
    summary: `Analyze this ${msg.type} from ${msg.source} in 1-2 sentences. What is it about and what action is needed?

Platform: ${msg.source} ${msg.channel ? '(channel: ' + msg.channel + ')' : ''}
From: ${msg.sender}
Subject: ${msg.subject}
Content: ${bodyText}`,

    deep: `Perform a detailed analysis:
1. Main purpose/ask
2. Urgency and why
3. Key context or risks
4. Recommended action and timing

Platform: ${msg.source}
From: ${msg.sender}
Content: ${bodyText}`,

    thread: `Summarize this message thread in one sentence, then list any open questions or unresolved items.
From: ${msg.sender}
Content: ${bodyText}`
  };

  const message = await client.messages.create({
    model,
    max_tokens: 500,
    system: 'You are an AI communication analyst. Be concise, specific, and actionable. Plain text only — no markdown symbols.',
    messages: [{ role: 'user', content: prompts[type] || prompts.summary }]
  });

  return json({ analysis: message.content[0].text, type });
});

