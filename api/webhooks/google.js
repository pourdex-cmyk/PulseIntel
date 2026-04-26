// api/webhooks/google.js  [EDGE RUNTIME]
export const config = { runtime: 'edge' };

import { createSupabaseClient } from '../_lib/supabase.js';
import { decrypt } from '../_lib/crypto.js';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return new Response('', { status: 400 }); }

  const supabase = createSupabaseClient();

  // Pub/Sub push notification format: { message: { data: base64, attributes: { email: '...' } } }
  const message   = body.message || {};
  const emailAddr = message.attributes?.email;
  const historyId = message.attributes?.historyId;

  if (!emailAddr) return new Response('', { status: 200 });

  // Look up user by gmail email stored in gmail_uid column (legacy) or oauth_tokens raw_email
  const { data: settings } = await supabase
    .from('user_settings')
    .select('user_id')
    .eq('gmail_uid', emailAddr)
    .single();

  const userId = settings?.user_id;
  if (!userId) return new Response('', { status: 200 });

  const { data: tokenRow } = await supabase
    .from('oauth_tokens')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .eq('scope', 'gmail')
    .single();

  if (!tokenRow) return new Response('', { status: 200 });

  let accessToken;
  try { accessToken = await decrypt(tokenRow.access_token); } catch { return new Response('', { status: 200 }); }

  // Fetch latest inbox message(s)
  try {
    const listRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&labelIds=INBOX',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) return new Response('', { status: 200 });
    const { messages = [] } = await listRes.json();

    for (const { id } of messages) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
        '&metadataHeaders=From&metadataHeaders=Subject',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!msgRes.ok) continue;
      const msg     = await msgRes.json();
      const headers = Object.fromEntries((msg.payload?.headers || []).map(h => [h.name, h.value]));
      const fromRaw  = headers['From'] || '';
      const fromName = fromRaw.split('<')[0].trim().replace(/^"|"$/g, '');
      const fromEmail = fromRaw.match(/<(.+?)>/)?.[1] || fromRaw;

      await supabase.from('messages').upsert({
        user_id: userId, source: 'gmail', external_id: id,
        subject: headers['Subject'] || '(no subject)',
        sender: fromName, handle: fromEmail,
        from_name: fromName, from_email: fromEmail,
        body: msg.snippet || '', preview: (msg.snippet || '').slice(0, 120),
        body_preview: (msg.snippet || '').slice(0, 1000),
        received_at: new Date(parseInt(msg.internalDate || '0')).toISOString(),
        unread: (msg.labelIds || []).includes('UNREAD'),
        is_read: !(msg.labelIds || []).includes('UNREAD'),
        type: 'email', category: 'fyi', priority: 50, tags: [],
      }, { onConflict: 'user_id,source,external_id' });
    }
  } catch (e) { console.error('Gmail webhook error:', e.message); }

  return new Response('', { status: 200 });
}
