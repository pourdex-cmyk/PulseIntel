// api/messages/triage.js  [nodejs runtime]
import Anthropic from '@anthropic-ai/sdk';
import { verifyJWT } from '../_lib/auth.js';
import { createSupabaseClient } from '../_lib/supabase.js';
import { SYSTEM_PROMPT } from '../_lib/systemPrompt.js';
import { buildEmailPrompt } from '../_lib/emailPrompts.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const user = await verifyJWT(req).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createSupabaseClient();
  const { data: settings } = await supabase
    .from('user_settings').select('*').eq('user_id', user.userId).single();

  const { data: messages } = await supabase
    .from('messages')
    .select('id,subject,from_name,from_email,sender,handle,body_preview,preview,source,received_at')
    .eq('user_id', user.userId)
    .is('ai_priority', null)
    .order('received_at', { ascending: false })
    .limit(40);

  if (!messages?.length) return res.status(200).json({ ok: true, triaged: 0 });

  const ctx = {
    user_name:     settings?.display_name || settings?.first_name || 'User',
    user_role:     settings?.role         || 'professional',
    inbox_count:   2,
    security_mode: 'high',
    reply_style:   settings?.tone         || 'professional',
  };

  const msgPayload = messages.map(m => ({
    id:           m.id,
    subject:      m.subject,
    from_name:    m.from_name || m.sender,
    from_email:   m.from_email || m.handle,
    body_preview: m.body_preview || m.preview || '',
    source:       m.source,
    received_at:  m.received_at,
  }));

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildEmailPrompt('triage', msgPayload, ctx);

  let raw;
  try {
    const response = await client.messages.create({
      model:      'claude-opus-4-7',
      max_tokens: 16000,
      thinking: {
        type:         'enabled',
        budget_tokens: 10000,
      },
      system:   SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    // Extended thinking returns multiple content blocks — find the text block
    const textBlock = response.content.find(b => b.type === 'text');
    raw = textBlock?.text || '[]';
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: 'Rate limit — retry in 60s' });
    if (err.status === 529) return res.status(503).json({ error: 'AI overloaded — retry in 30s' });
    return res.status(500).json({ error: err.message });
  }

  let triageResults;
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    triageResults = JSON.parse(cleaned);
  } catch {
    return res.status(500).json({ error: 'AI returned invalid JSON', raw });
  }

  const PRIORITY_MAP = { URGENT: 95, HIGH: 75, NORMAL: 50, LOW: 25, NOISE: 10 };
  let triaged = 0;
  for (const result of triageResults) {
    const { error: updateErr } = await supabase.from('messages').update({
      ai_priority:    result.priority,
      ai_category:    result.category,
      ai_summary:     result.summary,
      ai_action:      result.suggested_action,
      phishing_flags: result.phishing_signals || [],
      priority:       PRIORITY_MAP[result.priority] ?? 50,
      category:       result.category === 'action_required' ? 'action'
                    : result.category === 'phishing_risk'   ? 'action'
                    : result.category === 'spam'            ? 'noise'
                    : 'fyi',
      tags:           result.phishing_signals?.length ? ['security'] : [],
      triaged_at:     new Date().toISOString(),
    }).eq('id', result.id).eq('user_id', user.userId);
    if (!updateErr) triaged++;
  }

  return res.status(200).json({ ok: true, triaged, total: messages.length });
}
