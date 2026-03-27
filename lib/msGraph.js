// Microsoft Graph helper — token management + API calls
// Works in both Edge and Node.js runtimes

const _secret = () => (process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!').slice(0, 32).padEnd(32, '0');

export async function decryptMsToken(encoded) {
  try {
    const raw   = atob(encoded);
    const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
    const key   = await crypto.subtle.importKey('raw', new TextEncoder().encode(_secret()), { name: 'AES-GCM' }, false, ['decrypt']);
    const dec   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(dec)); // { at, rt, exp }
  } catch { return null; }
}

async function _encrypt(text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(_secret()), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(enc)));
}

// Returns a valid access token for a user, auto-refreshing if expired.
// Pass supabaseAdmin so this file stays import-free of other lib files.
export async function getMsAccessToken(supabase, userId) {
  const { data } = await supabase
    .from('user_settings').select('teams_token').eq('user_id', userId).single();
  if (!data?.teams_token) return null;

  const tokenData = await decryptMsToken(data.teams_token);
  if (!tokenData) return null;
  const { at, rt, exp } = tokenData;

  // Still valid (5-min buffer)
  if (exp && Date.now() < exp - 5 * 60 * 1000) return at;

  // Expired — try to refresh
  if (!rt) return null;
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: rt,
      grant_type:    'refresh_token',
      scope:         'offline_access Mail.ReadWrite Mail.Send Chat.ReadWrite Calendars.ReadWrite User.Read',
    }),
  });
  if (!res.ok) return null;

  const { access_token, refresh_token: new_rt, expires_in } = await res.json();
  const newBlob = JSON.stringify({ at: access_token, rt: new_rt || rt, exp: Date.now() + (expires_in || 3600) * 1000 });
  const enc     = await _encrypt(newBlob);
  await supabase.from('user_settings')
    .update({ teams_token: enc, outlook_token: enc, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  return access_token;
}

// Graph API GET
export async function graphGet(path, accessToken) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Graph GET ${path} → ${res.status}`);
  return res.json();
}

// Graph API POST (create)
export async function graphPost(path, accessToken, body) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph POST ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Graph API PATCH (update)
export async function graphPatch(path, accessToken, body) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph PATCH ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Graph API DELETE
export async function graphDelete(path, accessToken) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Graph DELETE ${path} → ${res.status}`);
  return null;
}

// ── High-level write helpers ──────────────────────────────────────────────────

// Send an Outlook email reply or new message
export async function sendMail(accessToken, { to, subject, body, replyToId = null }) {
  const message = {
    subject,
    body:       { contentType: 'HTML', content: body },
    toRecipients: to.map(addr => ({ emailAddress: { address: addr } })),
  };
  if (replyToId) {
    return graphPost(`/me/messages/${replyToId}/reply`, accessToken, { message });
  }
  return graphPost('/me/sendMail', accessToken, { message, saveToSentItems: true });
}

// Send a Teams chat message
export async function sendTeamsMessage(accessToken, chatId, content) {
  return graphPost(`/me/chats/${chatId}/messages`, accessToken, {
    body: { contentType: 'html', content },
  });
}

// Create a calendar event
export async function createCalendarEvent(accessToken, { title, start, end, attendees = [], joinUrl = null, body = '' }) {
  const event = {
    subject: title,
    start:   { dateTime: start, timeZone: 'UTC' },
    end:     { dateTime: end,   timeZone: 'UTC' },
    body:    { contentType: 'HTML', content: body },
    attendees: attendees.map(email => ({
      emailAddress: { address: email },
      type: 'required',
    })),
  };
  if (joinUrl) event.location = { displayName: joinUrl };
  return graphPost('/me/events', accessToken, event);
}

// Mark an Outlook message as read
export async function markMailRead(accessToken, messageId) {
  return graphPatch(`/me/messages/${messageId}`, accessToken, { isRead: true });
}

// Move an Outlook message to trash
export async function deleteMail(accessToken, messageId) {
  return graphDelete(`/me/messages/${messageId}`, accessToken);
}

// Priority/category helpers shared by sync and webhooks
export function scorePriority(text) {
  let s = 40;
  const t = (text || '').toLowerCase();
  if (/urgent|asap|action required|critical/i.test(t)) s += 35;
  if (/today|eod|by \d|deadline/i.test(t))              s += 20;
  if (/\?/.test(t))                                      s += 10;
  if (/fyi|heads up|just so you know/i.test(t))          s -= 20;
  if (/unsubscribe|no-reply|noreply|newsletter/i.test(t)) s -= 35;
  return Math.min(100, Math.max(1, s));
}

export function categorize(text) {
  const t = (text || '').toLowerCase();
  if (/urgent|action required|please|can you|need you|review|approve/i.test(t)) return 'action';
  if (/meeting|zoom|call|sync|standup|join|calendar/i.test(t))                  return 'meeting';
  if (/unsubscribe|no-reply|noreply|newsletter|automated/i.test(t))              return 'noise';
  return 'fyi';
}
