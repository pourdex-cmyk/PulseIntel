import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error } from '../../lib/middleware.js';

export const config = { runtime: 'nodejs' };

function scorePriority(content) {
  let score = 35;
  const text = (content || '').toLowerCase();
  if (/urgent|asap|important|action required|critical/i.test(text)) score += 35;
  if (/today|eod|by \d|deadline|asap/i.test(text)) score += 20;
  if (/\?/.test(text)) score += 10;
  if (/fyi|heads up|just so you know/i.test(text)) score -= 20;
  return Math.min(100, Math.max(1, score));
}

function categorize(content) {
  const text = (content || '').toLowerCase();
  if (/urgent|action required|please|can you|need you|review|approve/i.test(text)) return 'action';
  if (/meeting|zoom|call|sync|standup|join/i.test(text)) return 'meeting';
  if (/fyi|heads up|reminder|deployed|completed/i.test(text)) return 'fyi';
  return 'fyi';
}

export default async function handler(req) {
  const url = new URL(req.url);

  // Microsoft Graph validation token on subscription creation
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, { headers: { 'Content-Type': 'text/plain' } });
  }

  if (req.method !== 'POST') return error('Method not allowed', 405);

  const payload = await req.json();
  const uid     = url.searchParams.get('uid');
  if (!uid) return json({ ok: true });

  const { data: settings } = await supabaseAdmin
    .from('user_settings').select('user_id').eq('teams_uid', uid).single();
  if (!settings) return json({ ok: true });

  const expectedState = process.env.TEAMS_CLIENT_STATE;
  for (const notification of (payload.value || [])) {
    if (expectedState && notification.clientState !== expectedState) continue;
    if (notification.changeType !== 'created') continue;

    const resource = notification.resourceData || {};
    const content  = resource.body?.content || resource.content || '';
    const from     = resource.from?.user || resource.from || {};
    const channel  = resource.channelIdentity?.channelId || null;

    const plainContent = content.replace(/<[^>]+>/g, '').trim();
    const priority = scorePriority(plainContent);
    const category = categorize(plainContent);
    const isChat   = !channel; // no channelId = DM

    await supabaseAdmin.from('messages').insert({
      user_id:     settings.user_id,
      source:      'teams',
      type:        isChat ? 'message' : 'channel',
      sender:      from.displayName || from.name || 'Unknown',
      handle:      from.email || from.userPrincipalName || '',
      subject:     plainContent.substring(0, 80) || 'Teams message',
      preview:     plainContent.substring(0, 120),
      body:        `<p>${plainContent.replace(/\n/g, '</p><p>')}</p>`,
      tags:        [category],
      category,
      priority,
      channel:     channel ? `#${channel}` : null,
      unread:      true,
      received_at: resource.createdDateTime || new Date().toISOString(),
    });
  }

  return json({ ok: true });
}
