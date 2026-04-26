// api/messages/draft.js  [nodejs runtime]
import Anthropic from '@anthropic-ai/sdk';
import { verifyJWT } from '../_lib/auth.js';
import { createSupabaseClient } from '../_lib/supabase.js';
import { SYSTEM_PROMPT } from '../_lib/systemPrompt.js';
import { buildEmailPrompt } from '../_lib/emailPrompts.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const user = await verifyJWT(req).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { message_id } = req.body || {};
  if (!message_id) return res.status(400).json({ error: 'message_id required' });

  const supabase = createSupabaseClient();
  const [{ data: msg }, { data: settings }] = await Promise.all([
    supabase.from('messages').select('*').eq('id', message_id).eq('user_id', user.userId).single(),
    supabase.from('user_settings').select('*').eq('user_id', user.userId).single(),
  ]);

  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const ctx = {
    user_name:   `${settings?.first_name || ''} ${settings?.last_name || ''}`.trim() || 'User',
    user_role:   settings?.role    || 'professional',
    reply_style: settings?.tone    || 'professional',
    signoff:     settings?.signoff || settings?.first_name || 'Best',
  };

  const msgPayload = [{
    id:           msg.id,
    subject:      msg.subject,
    from_name:    msg.from_name || msg.sender,
    from_email:   msg.from_email || msg.handle,
    body_preview: msg.body_preview || msg.preview || msg.body || '',
    source:       msg.source,
  }];

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildEmailPrompt('draft_reply', msgPayload, ctx);

  // Stream the response
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let fullText = '';
  try {
    const stream = client.messages.stream({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text;
        res.write(`data: ${JSON.stringify({ t: event.delta.text })}\n\n`);
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
    return;
  }

  // Save draft to message record
  await supabase.from('messages')
    .update({ draft_reply: fullText })
    .eq('id', message_id)
    .eq('user_id', user.userId);

  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
}
