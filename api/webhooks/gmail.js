import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, decryptToken } from '../../lib/middleware.js';

export const config = { runtime: 'nodejs' };

function scorePriority(subject, snippet) {
  let score = 40;
  const text = ((subject || '') + ' ' + (snippet || '')).toLowerCase();
  if (/urgent|asap|action required|immediate|critical/i.test(text)) score += 30;
  if (/today|eod|by \d|deadline/i.test(text)) score += 20;
  if (/\?/.test(text)) score += 10;
  if (/unsubscribe|no-reply|noreply|newsletter|notification/i.test(text)) score -= 40;
  if (/fyi|heads up|reminder/i.test(text)) score -= 15;
  return Math.min(100, Math.max(1, score));
}

function categorize(subject, snippet) {
  const text = ((subject || '') + ' ' + (snippet || '')).toLowerCase();
  if (/urgent|action required|please review|approval|decision/i.test(text)) return 'action';
  if (/meeting|calendar|invite|zoom|teams|call|sync/i.test(text)) return 'meeting';
  if (/unsubscribe|no-reply|noreply|newsletter/i.test(text)) return 'noise';
  return 'fyi';
}

export default async function handler(req) {
  if (req.method !== 'POST') return error('Method not allowed', 405);

  // Gmail Pub/Sub wraps the notification in a base64 data field
  const envelope = await req.json();
  const url = new URL(req.url);
  const uid = url.searchParams.get('uid');

  // Verify shared secret appended to push subscription URL as ?token=...
  const expectedToken = process.env.GMAIL_WEBHOOK_SECRET;
  if (expectedToken && url.searchParams.get('token') !== expectedToken) {
    return error('Invalid token', 401);
  }

  let notification;
  try {
    const decoded = atob(envelope.message?.data || '');
    notification  = JSON.parse(decoded);
  } catch {
    return json({ ok: true }); // Ack even if we can't parse — prevents Pub/Sub retry storm
  }

  if (!uid || !notification.emailAddress) return json({ ok: true });

  const { data: settings } = await supabaseAdmin
    .from('user_settings').select('user_id, gmail_token').eq('gmail_uid', uid).single();
  if (!settings?.gmail_token) return json({ ok: true });

  // Decrypt the stored Gmail OAuth token
  const gmailToken = await decryptToken(settings.gmail_token);
  if (!gmailToken) return json({ ok: true });

  // Use historyId to fetch new messages via Gmail API
  const historyId = notification.historyId;

  // Fetch the history to get new message IDs
  const histRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}&historyTypes=messageAdded`,
    { headers: { Authorization: `Bearer ${gmailToken}` } }
  );
  if (!histRes.ok) return json({ ok: true });

  const histData = await histRes.json();
  const newMsgIds = (histData.history || [])
    .flatMap(h => h.messagesAdded || [])
    .map(m => m.message?.id)
    .filter(Boolean);

  for (const msgId of newMsgIds.slice(0, 10)) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject,From,Date`,
        { headers: { Authorization: `Bearer ${gmailToken}` } }
      );
      if (!msgRes.ok) continue;
      const gmailMsg = await msgRes.json();

      const headers  = gmailMsg.payload?.headers || [];
      const subject  = headers.find(h => h.name === 'Subject')?.value || '(No subject)';
      const fromRaw  = headers.find(h => h.name === 'From')?.value || '';
      const dateRaw  = headers.find(h => h.name === 'Date')?.value;
      const snippet  = gmailMsg.snippet || '';

      const fromMatch = fromRaw.match(/^(.*?)\s*<(.+)>$/) || [null, fromRaw, fromRaw];
      const senderName  = fromMatch[1]?.trim() || fromRaw;
      const senderEmail = fromMatch[2]?.trim() || fromRaw;

      // Skip sent messages
      if ((gmailMsg.labelIds || []).includes('SENT')) continue;

      const priority = scorePriority(subject, snippet);
      const category = categorize(subject, snippet);

      await supabaseAdmin.from('messages').insert({
        user_id:     settings.user_id,
        source:      'gmail',
        type:        'email',
        sender:      senderName,
        handle:      senderEmail,
        subject,
        preview:     snippet.substring(0, 120),
        body:        `<p>${snippet}</p>`,
        tags:        [category],
        category,
        priority,
        channel:     null,
        unread:      true,
        received_at: dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString(),
      });
    } catch { continue; }
  }

  return json({ ok: true });
}

