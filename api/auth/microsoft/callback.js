import { supabaseAdmin } from '../../../lib/supabase.js';
import { graphGet, scorePriority, categorize } from '../../../lib/msGraph.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

async function encrypt(text, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(enc)));
}

async function decryptState(state, secret) {
  const raw   = atob(state);
  const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
  const key   = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')), { name: 'AES-GCM' }, false, ['decrypt']);
  const dec   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(dec));
}

// ── Initial data sync helpers ─────────────────────────────────────────────────

async function syncOutlookEmails(userId, accessToken) {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const emailsRes = await graphGet(
      `/me/mailFolders/Inbox/messages?$top=25&$orderby=receivedDateTime desc` +
      `&$select=subject,from,body,bodyPreview,importance,receivedDateTime,isRead` +
      `&$filter=receivedDateTime ge ${since}`,
      accessToken
    );

    const rows = [];
    for (const email of (emailsRes.value || [])) {
      const fromName  = email.from?.emailAddress?.name    || email.from?.emailAddress?.address || 'Unknown';
      const fromEmail = email.from?.emailAddress?.address || '';
      const bodyHtml  = email.body?.content || `<p>${email.bodyPreview || ''}</p>`;
      const bodyText  = bodyHtml.replace(/<[^>]+>/g, '').trim();
      const subject   = email.subject || '(No subject)';
      const baseText  = `${subject} ${bodyText}${email.importance === 'high' ? ' urgent' : ''}`;

      rows.push({
        user_id:     userId,
        source:      'outlook',
        type:        'email',
        sender:      fromName,
        handle:      fromEmail,
        subject,
        preview:     bodyText.substring(0, 120),
        body:        bodyHtml,
        tags:        [categorize(`${subject} ${bodyText}`)],
        category:    categorize(`${subject} ${bodyText}`),
        priority:    scorePriority(baseText),
        channel:     null,
        unread:      !email.isRead,
        received_at: email.receivedDateTime || new Date().toISOString(),
      });
    }
    if (rows.length) {
      // Clear old synced outlook messages then batch insert
      await supabaseAdmin.from('messages').delete().eq('user_id', userId).eq('source', 'outlook');
      await supabaseAdmin.from('messages').insert(rows);
    }
  } catch (e) {
    console.warn('Outlook email sync:', e.message);
  }
}

async function syncTeamsMessages(userId, accessToken) {
  try {
    // Get most-recently-active chats
    const chatsRes = await graphGet('/me/chats?$top=10&$orderby=lastUpdatedDateTime desc', accessToken);
    const chats = chatsRes.value || [];

    const rows = [];
    for (const chat of chats.slice(0, 5)) {
      const msgsRes = await graphGet(
        `/me/chats/${chat.id}/messages?$top=6&$orderby=createdDateTime desc`,
        accessToken
      ).catch(() => ({ value: [] }));

      for (const msg of (msgsRes.value || [])) {
        if (msg.messageType !== 'message' || !msg.body?.content) continue;
        const content = msg.body.content.replace(/<[^>]+>/g, '').trim();
        if (!content) continue;

        const from = msg.from?.user || {};
        rows.push({
          user_id:     userId,
          source:      'teams',
          type:        chat.chatType === 'oneOnOne' ? 'message' : 'channel',
          sender:      from.displayName || 'Unknown',
          handle:      from.userPrincipalName || from.email || '',
          subject:     content.substring(0, 80) || 'Teams message',
          preview:     content.substring(0, 120),
          body:        msg.body.content,
          tags:        [categorize(content)],
          category:    categorize(content),
          priority:    scorePriority(content),
          channel:     chat.chatType !== 'oneOnOne' ? `#${chat.topic || 'chat'}` : null,
          unread:      true,
          received_at: msg.createdDateTime || new Date().toISOString(),
        });
      }
    }
    if (rows.length) {
      await supabaseAdmin.from('messages').delete().eq('user_id', userId).eq('source', 'teams');
      await supabaseAdmin.from('messages').insert(rows);
    }
  } catch (e) {
    console.warn('Teams message sync:', e.message);
  }
}

async function syncCalendarMeetings(userId, accessToken) {
  try {
    const start = new Date().toISOString();
    const end   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const calRes = await graphGet(
      `/me/calendarView?startDateTime=${start}&endDateTime=${end}` +
      `&$select=subject,start,end,organizer,attendees,onlineMeeting,bodyPreview,location` +
      `&$top=50&$orderby=start/dateTime`,
      accessToken
    );

    // Clear existing synced meetings before re-inserting to prevent duplicates
    await supabaseAdmin.from('meetings').delete().eq('user_id', userId);

    const rows = [];
    for (const event of (calRes.value || [])) {
      // Read date/time directly from the ISO string to avoid UTC timezone shift
      const startRaw = event.start?.dateTime || event.start?.date || '';
      const endRaw   = event.end?.dateTime   || event.end?.date   || '';
      const date     = startRaw.substring(0, 10);
      const time     = startRaw.length > 10 ? startRaw.substring(11, 16) : '00:00';

      const startMs    = startRaw ? new Date(startRaw).getTime() : Date.now();
      const endMs      = endRaw   ? new Date(endRaw).getTime()   : startMs + 3600000;
      const durationMin = Math.round((endMs - startMs) / 60000);
      const duration    = durationMin >= 60 ? `${Math.round(durationMin / 60)} hr` : `${durationMin} min`;

      const joinUrl = event.onlineMeeting?.joinUrl || null;
      let platform  = 'inperson';
      if (joinUrl?.includes('teams.microsoft.com')) platform = 'teams';
      else if (joinUrl?.includes('zoom.us'))        platform = 'zoom';
      else if (joinUrl?.includes('meet.google.com'))platform = 'gmeet';
      else if (joinUrl)                             platform = 'teams';

      const attendees = (event.attendees || []).map(a => ({
        name:  a.emailAddress?.name    || a.emailAddress?.address || '',
        email: a.emailAddress?.address || '',
      }));

      rows.push({
        user_id:   userId,
        title:     event.subject || 'Untitled meeting',
        platform,  date, time, duration,
        link:      joinUrl,
        attendees: JSON.stringify(attendees),
        agenda:    JSON.stringify([]),
        notes:     event.bodyPreview || '',
        ai_prep:   '',
      });
    }
    if (rows.length) await supabaseAdmin.from('meetings').insert(rows);
  } catch (e) {
    console.warn('Calendar sync:', e.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  const url     = new URL(req.url);
  const code    = url.searchParams.get('code');
  const state   = url.searchParams.get('state');
  const msError = url.searchParams.get('error');
  const appUrl  = process.env.APP_URL || 'https://your-app.vercel.app';
  const secret  = process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!';

  if (msError) {
    console.error('Microsoft OAuth denied:', msError, url.searchParams.get('error_description'));
    return Response.redirect(`${appUrl}/app?error=ms_denied`, 302);
  }
  if (!code || !state) return Response.redirect(`${appUrl}/app?error=ms_bad_request`, 302);

  let stateData;
  try { stateData = await decryptState(state, secret); }
  catch { return Response.redirect(`${appUrl}/app?error=ms_invalid_state`, 302); }

  if (Date.now() - stateData.ts > 15 * 60 * 1000)
    return Response.redirect(`${appUrl}/app?error=ms_expired`, 302);

  const userId       = stateData.uid;
  const clientId     = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri  = `${appUrl}/api/auth/microsoft/callback`;

  // Exchange authorization code for tokens
  const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });

  if (!tokenRes.ok) {
    console.error('Token exchange failed:', await tokenRes.text());
    return Response.redirect(`${appUrl}/app?error=ms_token_failed`, 302);
  }

  const { access_token, refresh_token, expires_in } = await tokenRes.json();

  const tokenBlob = JSON.stringify({ at: access_token, rt: refresh_token || null, exp: Date.now() + (expires_in || 3600) * 1000 });
  const encToken  = await encrypt(tokenBlob, secret);

  await supabaseAdmin.from('user_settings').upsert({
    user_id:       userId,
    teams_token:   encToken,
    outlook_token: encToken,
    updated_at:    new Date().toISOString(),
  });

  // Get the UIDs that were generated at signup — these MUST match what webhooks look up by
  const { data: settings } = await supabaseAdmin
    .from('user_settings').select('teams_uid, outlook_uid').eq('user_id', userId).single();

  const teamsUid   = settings?.teams_uid;
  const outlookUid = settings?.outlook_uid;

  if (teamsUid && outlookUid) {
    // Register Outlook inbox subscription (max 4230 min)
    const outlookExpiry = new Date(Date.now() + 4230 * 60 * 1000).toISOString();
    const outlookSubRes = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changeType:         'created',
        notificationUrl:    `${appUrl}/api/webhooks/outlook?uid=${outlookUid}`,
        resource:           "me/mailFolders('Inbox')/messages",
        expirationDateTime: outlookExpiry,
        clientState:        process.env.OUTLOOK_CLIENT_STATE || '',
      }),
    });
    if (!outlookSubRes.ok) console.warn('Outlook subscription failed:', await outlookSubRes.text());

    // Register Teams chat messages subscription (max 60 min)
    const teamsExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const teamsSubRes = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changeType:         'created',
        notificationUrl:    `${appUrl}/api/webhooks/teams?uid=${teamsUid}`,
        resource:           'me/chats/getAllMessages',
        expirationDateTime: teamsExpiry,
        clientState:        process.env.TEAMS_CLIENT_STATE || '',
      }),
    });
    if (!teamsSubRes.ok) console.warn('Teams subscription failed:', await teamsSubRes.text());

    // Register Calendar events subscription (max 4230 min)
    const calExpiry = new Date(Date.now() + 4230 * 60 * 1000).toISOString();
    await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changeType:         'created,updated,deleted',
        notificationUrl:    `${appUrl}/api/webhooks/teams?uid=${teamsUid}&type=calendar`,
        resource:           'me/events',
        expirationDateTime: calExpiry,
        clientState:        process.env.TEAMS_CLIENT_STATE || '',
      }),
    }).catch(e => console.warn('Calendar subscription failed:', e.message));
  }

  // Run initial data sync (errors are caught internally per function)
  await Promise.allSettled([
    syncOutlookEmails(userId, access_token),
    syncTeamsMessages(userId, access_token),
    syncCalendarMeetings(userId, access_token),
  ]);

  return Response.redirect(`${appUrl}/app?connected=microsoft`, 302);
}
