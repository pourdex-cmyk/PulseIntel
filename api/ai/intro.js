// api/ai/intro.js  [nodejs runtime]
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

  const { contact_a, contact_b, context_notes } = req.body || {};
  if (!contact_a || !contact_b) return res.status(400).json({ error: 'contact_a and contact_b required' });

  const supabase = createSupabaseClient();
  const { data: settings } = await supabase
    .from('user_settings').select('*').eq('user_id', user.userId).single();

  const ctx = {
    user_name:   `${settings?.first_name || ''} ${settings?.last_name || ''}`.trim() || 'User',
    user_role:   settings?.role    || 'standard',
    user_company:settings?.company || '',
    reply_style: settings?.tone    || 'professional',
    signoff:     settings?.signoff || '',
  };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildEmailPrompt('intro_email', [{ contact_a, contact_b, context_notes: context_notes || '' }], ctx);

  let email;
  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 600,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    });
    email = response.content[0]?.text || '';
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  return res.status(200).json({ ok: true, email });
}
