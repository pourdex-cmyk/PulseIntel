// Google API helper — token management, Gmail, Calendar
// Works in both Edge and Node.js runtimes

const _secret = () => (process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!').slice(0, 32).padEnd(32, '0');

export async function decryptGoogleToken(encoded) {
  try {
    const raw   = atob(encoded);
    const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
    const key   = await crypto.subtle.importKey('raw', new TextEncoder().encode(_secret()), { name: 'AES-GCM' }, false, ['decrypt']);
    const dec   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(dec)); // { at, rt, exp }
  } catch { return null; }
}

export async function encryptGoogleToken(data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(_secret()), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(enc)));
}

// Returns a valid Google access token, auto-refreshing if expired.
export async function getGoogleAccessToken(supabase, userId) {
  const { data } = await supabase
    .from('user_settings').select('gmail_token').eq('user_id', userId).single();
  if (!data?.gmail_token) return null;

  const tokenData = await decryptGoogleToken(data.gmail_token);
  if (!tokenData) return null;
  const { at, rt, exp } = tokenData;

  // Still valid (5-min buffer)
  if (exp && Date.now() < exp - 5 * 60 * 1000) return at;

  // Expired — refresh
  if (!rt) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: rt,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) return null;

  const { access_token, expires_in } = await res.json();
  const newToken = await encryptGoogleToken({ at: access_token, rt, exp: Date.now() + (expires_in || 3600) * 1000 });
  await supabase.from('user_settings')
    .update({ gmail_token: newToken, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  return access_token;
}

// ── Gmail API helpers ─────────────────────────────────────────────────────────

export async function gmailGet(path, accessToken) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail GET ${path} → ${res.status}`);
  return res.json();
}

export async function gmailPost(path, accessToken, body) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gmail POST ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ── Google Calendar API helpers ───────────────────────────────────────────────

export async function calendarGet(path, accessToken) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Calendar GET ${path} → ${res.status}`);
  return res.json();
}

export async function calendarPost(path, accessToken, body) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Calendar POST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// ── High-level helpers ────────────────────────────────────────────────────────

// Register Gmail push notifications via Pub/Sub
export async function setupGmailWatch(accessToken, topicName) {
  return gmailPost('/watch', accessToken, {
    topicName,
    labelIds:       ['INBOX'],
    labelFilterBehavior: 'INCLUDE',
  });
}

// Send an email via Gmail
export async function sendGmail(accessToken, { to, subject, body, threadId = null }) {
  const mime = [
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const encoded = btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const payload = { raw: encoded };
  if (threadId) payload.threadId = threadId;

  return gmailPost('/messages/send', accessToken, payload);
}

// Mark a Gmail message as read
export async function markGmailRead(accessToken, messageId) {
  return gmailPost(`/messages/${messageId}/modify`, accessToken, {
    removeLabelIds: ['UNREAD'],
  });
}

// Trash a Gmail message
export async function trashGmail(accessToken, messageId) {
  return gmailPost(`/messages/${messageId}/trash`, accessToken, {});
}

// Parse Gmail message headers into a clean object
export function parseGmailHeaders(message) {
  const headers  = message.payload?.headers || [];
  const get      = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  const fromRaw  = get('From');
  const match    = fromRaw.match(/^(.*?)\s*<(.+)>$/) || [null, fromRaw, fromRaw];
  return {
    subject:     get('Subject') || '(No subject)',
    senderName:  match[1]?.trim() || fromRaw,
    senderEmail: match[2]?.trim() || fromRaw,
    date:        get('Date'),
    snippet:     message.snippet || '',
  };
}
