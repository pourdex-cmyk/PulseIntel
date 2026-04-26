// api/messages/draft.js  [nodejs runtime]
import Anthropic from '@anthropic-ai/sdk';
import { verifyJWT } from '../_lib/auth.js';
import { createSupabaseClient } from '../_lib/supabase.js';
import { SYSTEM_PROMPT } from '../_lib/systemPrompt.js';
import { buildEmailPrompt } from '../_lib/emailPrompts.js';

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
    user_role:   settings?.role  || 'standard',
    reply_style: settings?.tone  || 'professional',
    signoff:     settings?.signoff || '',
  };

  const msgPayload = [{
    id:           msg.id,
    subject:      msg.subject,
    from_name:    msg.from_name || msg.sender,
    from_email:   msg.from_email || msg.handle,
    body_preview: msg.body_preview || msg.preview || msg.body || '',
    source:       msg.source,
  }];

  const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt   = buildEmailPrompt('draft_reply', msgPayload, ctx);

  let draft;
  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    });
    draft = response.content[0]?.text || '';
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Save draft to message record
  await supabase.from('messages').update({ draft_reply: draft }).eq('id', message_id);

  return res.status(200).json({ ok: true, draft });
}
