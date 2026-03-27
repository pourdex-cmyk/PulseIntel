import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error } from '../../lib/middleware.js';
import { getGoogleAccessToken, gmailGet, parseGmailHeaders } from '../../lib/googleApi.js';

export const config = { runtime: 'nodejs' };

function scorePriority(text) {
  let s = 40;
  const t = (text || '').toLowerCase();
  if (/urgent|asap|action required|critical/i.test(t)) s += 35;
  if (/today|eod|by \d|deadline/i.test(t))              s += 20;
  if (/\?/.test(t))                                      s += 10;
  if (/fyi|heads up/i.test(t))                           s -= 20;
  if (/unsubscribe|no-reply|noreply|newsletter/i.test(t)) s -= 35;
  return Math.min(100, Math.max(1, s));
}

function categorize(text) {
  const t = (text || '').toLowerCase();
  if (/urgent|action required|please|review|approve/i.test(t)) return 'action';
  if (/meeting|calendar|invite|zoom|teams|call|sync/i.test(t)) return 'meeting';
  if (/unsubscribe|no-reply|noreply|newsletter/i.test(t))       return 'noise';
  return 'fyi';
}

export default async function handler(req) {
  if (req.method !== 'POST') return error('Method not allowed', 405);

  const url = new URL(req.url);

  // Verify shared webhook secret
  const expectedToken = process.env.GMAIL_WEBHOOK_SECRET;
  if (expectedToken && url.searchParams.get('token') !== expectedToken) {
    return error('Invalid token', 401);
  }

  // Gmail Pub/Sub wraps the notification in a base64 data field
  const envelope = await req.json();
  let notification;
  try {
    const decoded = atob(envelope.message?.data || '');
    notification  = JSON.parse(decoded);
  } catch {
    return json({ ok: true }); // Ack to prevent Pub/Sub retry storm
  }

  const { emailAddress, historyId } = notification;
  if (!emailAddress || !historyId) return json({ ok: true });

  // Look up user by their stored Gmail address
  const { data: settings } = await supabaseAdmin
    .from('user_settings')
    .select('user_id')
    .eq('gmail_email', emailAddress)
    .single();
  if (!settings) return json({ ok: true });

  const userId      = settings.user_id;
  const accessToken = await getGoogleAccessToken(supabaseAdmin, userId);
  if (!accessToken) return json({ ok: true });

  // Use historyId to fetch only new messages
  let newMsgIds = [];
  try {
    const histRes = await gmailGet(
      `/history?startHistoryId=${historyId}&historyTypes=messageAdded`,
      accessToken
    );
    newMsgIds = (histRes.history || [])
      .flatMap(h => h.messagesAdded || [])
      .map(m => m.message?.id)
      .filter(Boolean);
  } catch (e) {
    console.warn('Gmail history fetch failed:', e.message);
    return json({ ok: true });
  }

  for (const msgId of newMsgIds.slice(0, 10)) {
    try {
      const msg = await gmailGet(
        `/messages/${msgId}?format=full`,
        accessToken
      );

      // Skip sent messages
      if ((msg.labelIds || []).includes('SENT')) continue;

      const { subject, senderName, senderEmail, date, snippet } = parseGmailHeaders(msg);

      // Extract full HTML body if available, fall back to snippet
      let body = `<p>${snippet}</p>`;
      const htmlPart = findBodyPart(msg.payload, 'text/html');
      const textPart = findBodyPart(msg.payload, 'text/plain');
      if (htmlPart) {
        body = Buffer.from(htmlPart, 'base64url').toString('utf-8');
      } else if (textPart) {
        const plain = Buffer.from(textPart, 'base64url').toString('utf-8');
        body = `<p>${plain.replace(/\n/g, '</p><p>')}</p>`;
      }

      const text     = `${subject} ${snippet}`;
      const priority = scorePriority(text);
      const category = categorize(text);

      await supabaseAdmin.from('messages').insert({
        user_id:     userId,
        source:      'gmail',
        type:        'email',
        sender:      senderName,
        handle:      senderEmail,
        subject,
        preview:     snippet.substring(0, 120),
        body,
        tags:        [category],
        category,
        priority,
        channel:     null,
        unread:      (msg.labelIds || []).includes('UNREAD'),
        received_at: date ? new Date(date).toISOString() : new Date().toISOString(),
      });
    } catch { continue; }
  }

  return json({ ok: true });
}

function findBodyPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data) return payload.body.data;
  for (const part of payload.parts || []) {
    const found = findBodyPart(part, mimeType);
    if (found) return found;
  }
  return null;
}
