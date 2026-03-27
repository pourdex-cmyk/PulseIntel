import { supabaseAdmin } from '../../../lib/supabase.js';
import { encryptGoogleToken, setupGmailWatch, gmailGet, calendarGet, parseGmailHeaders } from '../../../lib/googleApi.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

async function decryptState(state, secret) {
  const raw   = atob(state);
  const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
  const key   = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')), { name: 'AES-GCM' }, false, ['decrypt']);
  const dec   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(dec));
}

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

// ── Initial sync helpers ──────────────────────────────────────────────────────

async function syncGmailMessages(userId, accessToken) {
  try {
    const listRes = await gmailGet('/messages?labelIds=INBOX&maxResults=25', accessToken);
    const msgIds  = (listRes.messages || []).map(m => m.id);

    const rows = [];
    for (const msgId of msgIds) {
      try {
        const msg = await gmailGet(
          `/messages/${msgId}?format=metadata&metadataHeaders=Subject,From,Date`,
          accessToken
        );
        if ((msg.labelIds || []).includes('SENT')) continue;

        const { subject, senderName, senderEmail, date, snippet } = parseGmailHeaders(msg);
        const text = `${subject} ${snippet}`;

        rows.push({
          user_id:     userId,
          source:      'gmail',
          type:        'email',
          sender:      senderName,
          handle:      senderEmail,
          subject,
          preview:     snippet.substring(0, 120),
          body:        `<p>${snippet}</p>`,
          tags:        [categorize(text)],
          category:    categorize(text),
          priority:    scorePriority(text),
          channel:     null,
          unread:      (msg.labelIds || []).includes('UNREAD'),
          received_at: date ? new Date(date).toISOString() : new Date().toISOString(),
        });
      } catch { continue; }
    }

    if (rows.length) {
      await supabaseAdmin.from('messages').delete().eq('user_id', userId).eq('source', 'gmail');
      await supabaseAdmin.from('messages').insert(rows);
    }
  } catch (e) {
    console.warn('Gmail initial sync:', e.message);
  }
}

async function syncGoogleCalendar(userId, accessToken) {
  try {
    const start = new Date().toISOString();
    const end   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const res = await calendarGet(
      `/calendars/primary/events?timeMin=${start}&timeMax=${end}&maxResults=50&singleEvents=true&orderBy=startTime` +
      `&fields=items(summary,start,end,attendees,hangoutLink,location,description)`,
      accessToken
    );

    // Clear existing synced meetings before re-inserting to prevent duplicates
    await supabaseAdmin.from('meetings').delete().eq('user_id', userId);

    const rows = [];
    for (const event of (res.items || [])) {
      // Read date/time directly from ISO string to avoid UTC timezone shift
      const startRaw = event.start?.dateTime || event.start?.date || '';
      const endRaw   = event.end?.dateTime   || event.end?.date   || '';
      const date     = startRaw.substring(0, 10);
      const time     = startRaw.length > 10 ? startRaw.substring(11, 16) : '00:00';

      const startMs    = startRaw ? new Date(startRaw).getTime() : Date.now();
      const endMs      = endRaw   ? new Date(endRaw).getTime()   : startMs + 3600000;
      const durationMin = Math.round((endMs - startMs) / 60000);
      const duration    = durationMin >= 60 ? `${Math.round(durationMin / 60)} hr` : `${durationMin} min`;

      const joinUrl  = event.hangoutLink || null;
      let   platform = 'inperson';
      if (joinUrl?.includes('meet.google.com'))      platform = 'gmeet';
      else if (joinUrl?.includes('zoom.us'))         platform = 'zoom';
      else if (joinUrl?.includes('teams.microsoft')) platform = 'teams';
      else if (joinUrl)                              platform = 'gmeet';

      const attendees = (event.attendees || []).map(a => ({
        name:  a.displayName || a.email || '',
        email: a.email || '',
      }));

      rows.push({
        user_id:   userId,
        title:     event.summary || 'Untitled meeting',
        platform,  date, time, duration,
        link:      joinUrl,
        attendees: JSON.stringify(attendees),
        agenda:    JSON.stringify([]),
        notes:     event.description || '',
        ai_prep:   '',
      });
    }
    if (rows.length) await supabaseAdmin.from('meetings').insert(rows);
  } catch (e) {
    console.warn('Google Calendar sync:', e.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  const url      = new URL(req.url);
  const code     = url.searchParams.get('code');
  const state    = url.searchParams.get('state');
  const gError   = url.searchParams.get('error');
  const appUrl   = process.env.APP_URL || 'https://acgpulseintel.com';
  const secret   = process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!';

  if (gError) {
    console.error('Google OAuth denied:', gError);
    return Response.redirect(`${appUrl}/app?error=google_denied`, 302);
  }
  if (!code || !state) return Response.redirect(`${appUrl}/app?error=google_bad_request`, 302);

  let stateData;
  try { stateData = await decryptState(state, secret); }
  catch { return Response.redirect(`${appUrl}/app?error=google_invalid_state`, 302); }

  if (Date.now() - stateData.ts > 15 * 60 * 1000)
    return Response.redirect(`${appUrl}/app?error=google_expired`, 302);

  const userId       = stateData.uid;
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = `${appUrl}/api/auth/google/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });

  if (!tokenRes.ok) {
    console.error('Google token exchange failed:', await tokenRes.text());
    return Response.redirect(`${appUrl}/app?error=google_token_failed`, 302);
  }

  const { access_token, refresh_token, expires_in } = await tokenRes.json();

  // Get user's Gmail address for webhook lookup
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const profile    = profileRes.ok ? await profileRes.json() : {};
  const gmailEmail = profile.email || null;

  // Encrypt and store token
  const encToken = await encryptGoogleToken({
    at:  access_token,
    rt:  refresh_token || null,
    exp: Date.now() + (expires_in || 3600) * 1000,
  });

  await supabaseAdmin.from('user_settings').upsert({
    user_id:     userId,
    gmail_token: encToken,
    gmail_uid:   gmailEmail, // repurpose gmail_uid to store email for webhook lookup
    updated_at:  new Date().toISOString(),
  });

  // Set up Gmail push notifications via Pub/Sub
  const topicName = process.env.GOOGLE_PUBSUB_TOPIC;
  if (topicName) {
    await setupGmailWatch(access_token, topicName).catch(e =>
      console.warn('Gmail watch setup failed:', e.message)
    );
  }

  // Initial data sync (errors caught internally per function)
  await Promise.allSettled([
    syncGmailMessages(userId, access_token),
    syncGoogleCalendar(userId, access_token),
  ]);

  return Response.redirect(`${appUrl}/app?connected=google`, 302);
}
