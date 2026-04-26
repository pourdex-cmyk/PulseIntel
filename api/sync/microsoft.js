// api/sync/microsoft.js  [nodejs runtime]
// Idempotent — safe to run multiple times. Called by OAuth callback, webhooks, and frontend refresh.
import { getValidToken } from '../_lib/crypto.js';
import { createSupabaseClient } from '../_lib/supabase.js';
import { verifyJWT } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  let userId;
  const internalKey = req.headers['x-internal'];
  if (internalKey === process.env.JWT_SECRET) {
    userId = req.body?.userId;
  } else {
    const user = await verifyJWT(req).catch(() => null);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    userId = user.userId;
  }

  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const supabase = createSupabaseClient();
  const results  = { outlook: 0, teams: 0, calendar: 0, errors: [] };

  // ── OUTLOOK EMAIL ─────────────────────────────────────────────────────────
  try {
    const token   = await getValidToken(userId, 'microsoft', 'outlook');
    const mailRes = await fetch(
      'https://graph.microsoft.com/v1.0/me/messages' +
      '?$top=50&$orderby=receivedDateTime desc' +
      '&$select=id,subject,from,body,receivedDateTime,isRead,importance,hasAttachments',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!mailRes.ok) throw new Error(await mailRes.text());
    const { value: emails } = await mailRes.json();

    for (const email of (emails || [])) {
      const { error: upsertErr } = await supabase.from('messages').upsert({
        user_id:         userId,
        source:          'outlook',
        external_id:     email.id,
        subject:         email.subject || '(no subject)',
        sender:          email.from?.emailAddress?.name || '',
        handle:          email.from?.emailAddress?.address || '',
        from_name:       email.from?.emailAddress?.name || '',
        from_email:      email.from?.emailAddress?.address || '',
        body:            email.body?.content || '',
        preview:         (email.body?.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 120),
        body_preview:    (email.body?.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 1000),
        received_at:     email.receivedDateTime || new Date().toISOString(),
        unread:          !email.isRead,
        is_read:         !!email.isRead,
        importance:      email.importance || 'normal',
        has_attachments: !!email.hasAttachments,
        type:            'email',
        category:        'fyi',
        priority:        50,
        tags:            [],
        raw_json:        email,
      }, { onConflict: 'user_id,source,external_id' });
      if (!upsertErr) results.outlook++;
    }
  } catch (e) { results.errors.push(`outlook: ${e.message}`); }

  // ── TEAMS CHATS ───────────────────────────────────────────────────────────
  try {
    const token    = await getValidToken(userId, 'microsoft', 'teams');
    const chatsRes = await fetch(
      'https://graph.microsoft.com/v1.0/me/chats?$expand=lastMessagePreview&$top=20',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!chatsRes.ok) throw new Error(await chatsRes.text());
    const { value: chats } = await chatsRes.json();

    for (const chat of (chats || [])) {
      const lmp     = chat.lastMessagePreview;
      if (!lmp) continue;
      const fromName = lmp.from?.user?.displayName || lmp.from?.application?.displayName || 'Unknown';
      const bodyText = lmp.body?.content || '';
      const { error: upsertErr } = await supabase.from('messages').upsert({
        user_id:      userId,
        source:       'teams',
        external_id:  chat.id,
        subject:      chat.topic || 'Teams Chat',
        sender:       fromName,
        handle:       fromName,
        from_name:    fromName,
        from_email:   '',
        body:         bodyText,
        preview:      bodyText.slice(0, 120),
        body_preview: bodyText.slice(0, 1000),
        received_at:  lmp.createdDateTime || new Date().toISOString(),
        unread:       true,
        is_read:      false,
        type:         'chat',
        category:     'fyi',
        priority:     50,
        tags:         [],
        raw_json:     chat,
      }, { onConflict: 'user_id,source,external_id' });
      if (!upsertErr) results.teams++;
    }
  } catch (e) { results.errors.push(`teams: ${e.message}`); }

  // ── CALENDAR ──────────────────────────────────────────────────────────────
  try {
    const token  = await getValidToken(userId, 'microsoft', 'outlook');
    const now    = new Date().toISOString();
    const future = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const calRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${now}&endDateTime=${future}` +
      '&$select=id,subject,start,end,attendees,onlineMeetingUrl,bodyPreview,organizer' +
      '&$top=30&$orderby=start/dateTime',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!calRes.ok) throw new Error(await calRes.text());
    const { value: events } = await calRes.json();

    for (const event of (events || [])) {
      const startRaw = event.start?.dateTime || '';
      const date     = startRaw.substring(0, 10);
      const time     = startRaw.length > 10 ? startRaw.substring(11, 16) : '00:00';
      const endRaw   = event.end?.dateTime || '';
      const startMs  = startRaw ? new Date(startRaw).getTime() : 0;
      const endMs    = endRaw   ? new Date(endRaw).getTime()   : 0;
      const durMin   = startMs && endMs ? Math.round((endMs - startMs) / 60000) : 60;
      const dur      = durMin >= 60 ? `${Math.floor(durMin / 60)} hr${durMin >= 120 ? 's' : ''}` : `${durMin} min`;
      const attendees = (event.attendees || []).map(a => a.emailAddress?.name || a.emailAddress?.address || '').filter(Boolean);

      const { error: upsertErr } = await supabase.from('meetings').upsert({
        user_id:     userId,
        source:      'outlook',
        external_id: event.id,
        title:       event.subject || 'Untitled meeting',
        date,
        time,
        duration:    dur,
        start_time:  startRaw ? new Date(startRaw).toISOString() : null,
        end_time:    endRaw   ? new Date(endRaw).toISOString()   : null,
        platform:    event.onlineMeetingUrl ? 'teams' : 'inperson',
        link:        event.onlineMeetingUrl || null,
        attendees:   JSON.stringify(attendees),
        organizer:   event.organizer?.emailAddress?.name || '',
        notes:       event.bodyPreview || '',
        agenda:      JSON.stringify([]),
        ai_prep:     '',
        raw_json:    event,
      }, { onConflict: 'user_id,source,external_id' });
      if (!upsertErr) results.calendar++;
    }
  } catch (e) { results.errors.push(`calendar: ${e.message}`); }

  return res.status(200).json({ ok: true, synced: results });
}
