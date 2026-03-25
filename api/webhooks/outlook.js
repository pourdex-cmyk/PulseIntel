import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error } from '../../lib/middleware.js';

export const config = { runtime: 'nodejs' };

function scorePriority(subject, body, importance) {
  let score = 40;
  const text = ((subject || '') + ' ' + (body || '')).toLowerCase();
  if (importance === 'high') score += 30;
  if (/urgent|asap|action required|immediate|critical/i.test(text)) score += 30;
  if (/today|eod|by \d|deadline/i.test(text)) score += 20;
  if (/\?/.test(text)) score += 10;
  if (/unsubscribe|no-reply|noreply|newsletter|notification/i.test(text)) score -= 40;
  if (/fyi|heads up|reminder/i.test(text)) score -= 15;
  return Math.min(100, Math.max(1, score));
}

function categorize(subject, body) {
  const text = ((subject || '') + ' ' + (body || '')).toLowerCase();
  if (/urgent|action required|please review|approval needed|decision/i.test(text)) return 'action';
  if (/meeting|calendar|invite|zoom|teams|call|sync/i.test(text)) return 'meeting';
  if (/unsubscribe|no-reply|noreply|newsletter|automated/i.test(text)) return 'noise';
  if (/fyi|heads up|reminder|for your information/i.test(text)) return 'fyi';
  return 'action';
}

export default async function handler(req) {
  const url = new URL(req.url);

  // Microsoft Graph sends a validation token on subscription creation
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, { headers: { 'Content-Type': 'text/plain' } });
  }

  if (req.method !== 'POST') return error('Method not allowed', 405);

  const payload = await req.json();
  const uid     = url.searchParams.get('uid');
  if (!uid) return json({ ok: true });

  const { data: settings } = await supabaseAdmin
    .from('user_settings').select('user_id, outlook_token').eq('outlook_uid', uid).single();
  if (!settings) return json({ ok: true });

  const expectedState = process.env.OUTLOOK_CLIENT_STATE;
  for (const notification of (payload.value || [])) {
    if (expectedState && notification.clientState !== expectedState) continue;
    if (notification.changeType !== 'created') continue;

    const resource = notification.resourceData || {};
    const subject  = resource.subject || '(No subject)';
    const from     = resource.from?.emailAddress || {};
    const body     = resource.bodyPreview || '';
    const importance = resource.importance || 'normal';

    const priority = scorePriority(subject, body, importance);
    const category = categorize(subject, body);

    await supabaseAdmin.from('messages').insert({
      user_id:     settings.user_id,
      source:      'outlook',
      type:        'email',
      sender:      from.name || from.address || 'Unknown',
      handle:      from.address || '',
      subject,
      preview:     body.substring(0, 120),
      body:        `<p>${body}</p>`,
      tags:        [category],
      category,
      priority,
      channel:     null,
      unread:      true,
      received_at: resource.receivedDateTime || new Date().toISOString(),
    });
  }

  return json({ ok: true });
}
