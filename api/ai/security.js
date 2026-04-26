// api/ai/security.js  [nodejs runtime]
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

  const supabase = createSupabaseClient();

  // Scan last 50 unscanned emails
  const { data: messages } = await supabase
    .from('messages')
    .select('id,subject,from_name,from_email,sender,handle,body_preview,preview,source,received_at')
    .eq('user_id', user.userId)
    .in('source', ['outlook', 'gmail'])
    .or('phishing_flags.eq.[],phishing_flags.is.null')
    .order('received_at', { ascending: false })
    .limit(50);

  if (!messages?.length) return res.status(200).json({ ok: true, scanned: 0, flags: [] });

  const ctx = {
    user_name:     'User',
    security_mode: 'high',
  };

  const msgPayload = messages.map(m => ({
    id:           m.id,
    subject:      m.subject,
    from_name:    m.from_name || m.sender,
    from_email:   m.from_email || m.handle,
    body_preview: m.body_preview || m.preview || '',
    source:       m.source,
  }));

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildEmailPrompt('security_scan', msgPayload, ctx);

  let raw;
  try {
    const response = await client.messages.create({
      model:      'claude-opus-4-7',
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    });
    raw = response.content[0]?.text || '[]';
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  let scanResults;
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    scanResults = JSON.parse(cleaned);
  } catch {
    return res.status(500).json({ error: 'AI returned invalid JSON', raw });
  }

  const flags = [];
  for (const result of scanResults) {
    await supabase.from('messages').update({
      phishing_flags: result.signals || [],
      tags: result.risk_level === 'HIGH' || result.risk_level === 'MEDIUM'
        ? ['security']
        : [],
    }).eq('id', result.id).eq('user_id', user.userId);
    if (result.risk_level !== 'NONE') flags.push(result);
  }

  return res.status(200).json({ ok: true, scanned: messages.length, flags });
}
