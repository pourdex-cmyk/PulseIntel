import { createHmac } from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error } from '../../lib/middleware.js';

export const config = { runtime: 'nodejs' };

// Priority scoring heuristics
function scorePriority(msg) {
  let score = 30;
  const text = (msg.text || '').toLowerCase();
  if (/urgent|asap|immediately|critical|blocker/i.test(text)) score += 40;
  if (/today|eod|end of day|by \d/i.test(text)) score += 25;
  if (/\?/.test(text)) score += 10;  // questions need replies
  if (/fyi|heads up|just so you know/i.test(text)) score -= 20;
  if (msg.channel_type === 'im') score += 15;  // DMs are higher priority
  return Math.min(100, Math.max(1, score));
}

function categorize(text) {
  const t = text.toLowerCase();
  if (/urgent|asap|action required|please|can you|could you|need you/i.test(t)) return 'action';
  if (/meeting|zoom|teams|call|sync|standup|invite/i.test(t)) return 'meeting';
  if (/fyi|heads up|just so you know|reminder|newsletter/i.test(t)) return 'fyi';
  if (/unsubscribe|no-reply|noreply|automated/i.test(t)) return 'noise';
  return 'fyi';
}

export default async function handler(req) {
  if (req.method === 'GET') {
    // Slack URL verification challenge
    const url = new URL(req.url);
    const challenge = url.searchParams.get('challenge');
    if (challenge) return new Response(challenge, { headers: { 'Content-Type': 'text/plain' } });
  }

  if (req.method !== 'POST') return error('Method not allowed', 405);

  const rawBody = await req.text();

  // Verify Slack signature
  const timestamp  = req.headers.get('X-Slack-Request-Timestamp') || '';
  const signature  = req.headers.get('X-Slack-Signature') || '';
  const sigBase    = `v0:${timestamp}:${rawBody}`;
  const expected   = 'v0=' + createHmac('sha256', process.env.SLACK_SIGNING_SECRET || '')
    .update(sigBase).digest('hex');

  if (signature !== expected) return error('Invalid signature', 401);

  const payload = JSON.parse(rawBody);

  // Handle URL verification
  if (payload.type === 'url_verification') return json({ challenge: payload.challenge });

  // Handle event callbacks
  if (payload.type === 'event_callback') {
    const event = payload.event;
    if (!event || event.type !== 'message' || event.subtype) return json({ ok: true });
    if (event.bot_id) return json({ ok: true }); // ignore bot messages

    const uid = new URL(req.url).searchParams.get('uid');
    if (!uid) return json({ ok: true });

    // Find user by webhook uid
    const { data: settings } = await supabaseAdmin
      .from('user_settings').select('user_id').eq('slack_uid', uid).single();
    if (!settings) return json({ ok: true });

    const priority = scorePriority(event);
    const text = event.text || '';

    await supabaseAdmin.from('messages').insert({
      user_id:     settings.user_id,
      source:      'slack',
      type:        event.channel_type === 'im' ? 'message' : 'channel',
      sender:      event.username || event.user || 'Unknown',
      handle:      `@${event.user}`,
      subject:     text.substring(0, 80),
      preview:     text.substring(0, 120),
      body:        `<p>${text.replace(/\n/g, '</p><p>')}</p>`,
      tags:        [categorize(text)],
      category:    categorize(text),
      priority,
      channel:     event.channel ? `#${event.channel}` : null,
      unread:      true,
      received_at: new Date(parseInt(event.ts) * 1000).toISOString(),
    });
  }

  return json({ ok: true });
}
