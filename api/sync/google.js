// api/sync/google.js  [nodejs runtime]
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
  const results  = { gmail: 0, gcal: 0, errors: [] };

  // ── GMAIL ─────────────────────────────────────────────────────────────────
  try {
    const token   = await getValidToken(userId, 'google', 'gmail');
    const listRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&labelIds=INBOX',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!listRes.ok) throw new Error(await listRes.text());
    const { messages = [] } = await listRes.json();

    // Fetch message details in parallel batches of 5
    for (let i = 0; i < messages.length; i += 5) {
      const batch = messages.slice(i, i + 5);
      await Promise.all(batch.map(async ({ id }) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
          '&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!msgRes.ok) return;
        const msg     = await msgRes.json();
        const headers = Object.fromEntries(
          (msg.payload?.headers || []).map(h => [h.name, h.value])
        );
        const fromRaw  = headers['From'] || '';
        const fromName = fromRaw.split('<')[0].trim().replace(/^"|"$/g, '');
        const fromEmail = fromRaw.match(/<(.+?)>/)?.[1] || fromRaw;
        const snippet  = msg.snippet || '';

        await supabase.from('messages').upsert({
          user_id:      userId,
          source:       'gmail',
          external_id:  id,
          subject:      headers['Subject'] || '(no subject)',
          sender:       fromName,
          handle:       fromEmail,
          from_name:    fromName,
          from_email:   fromEmail,
          body:         snippet,
          preview:      snippet.slice(0, 120),
          body_preview: snippet.slice(0, 1000),
          received_at:  new Date(parseInt(msg.internalDate || '0')).toISOString(),
          unread:       (msg.labelIds || []).includes('UNREAD'),
          is_read:      !(msg.labelIds || []).includes('UNREAD'),
          type:         'email',
          category:     'fyi',
          priority:     50,
          tags:         [],
          raw_json:     msg,
        }, { onConflict: 'user_id,source,external_id' });
        results.gmail++;
      }));
    }
  } catch (e) { results.errors.push(`gmail: ${e.message}`); }

  // ── GOOGLE CALENDAR ───────────────────────────────────────────────────────
  try {
    const token  = await getValidToken(userId, 'google', 'gcal');
    const now    = new Date().toISOString();
    const future = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
      `?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(future)}` +
      `&singleEvents=true&orderBy=startTime&maxResults=30`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!calRes.ok) throw new Error(await calRes.text());
    const { items = [] } = await calRes.json();

    for (const event of items) {
      const startRaw = event.start?.dateTime || event.start?.date || '';
      const endRaw   = event.end?.dateTime   || event.end?.date   || '';
      const date     = startRaw.substring(0, 10);
      const time     = startRaw.length > 10 ? startRaw.substring(11, 16) : '00:00';
      const startMs  = startRaw ? new Date(startRaw).getTime() : 0;
      const endMs    = endRaw   ? new Date(endRaw).getTime()   : 0;
      const durMin   = startMs && endMs ? Math.round((endMs - startMs) / 60000) : 60;
      const dur      = durMin >= 60 ? `${Math.floor(durMin / 60)} hr${durMin >= 120 ? 's' : ''}` : `${durMin} min`;
      const attendees = (event.attendees || []).map(a => a.displayName || a.email || '').filter(Boolean);

      await supabase.from('meetings').upsert({
        user_id:     userId,
        source:      'gcal',
        external_id: event.id,
        title:       event.summary || '(no title)',
        date,
        time,
        duration:    dur,
        start_time:  startRaw ? new Date(startRaw).toISOString() : null,
        end_time:    endRaw   ? new Date(endRaw).toISOString()   : null,
        platform:    event.hangoutLink ? 'gmeet' : 'inperson',
        link:        event.hangoutLink || null,
        attendees:   JSON.stringify(attendees),
        organizer:   event.organizer?.displayName || '',
        notes:       event.description || '',
        agenda:      JSON.stringify([]),
        ai_prep:     '',
        raw_json:    event,
      }, { onConflict: 'user_id,source,external_id' });
      results.gcal++;
    }
  } catch (e) { results.errors.push(`gcal: ${e.message}`); }

  return res.status(200).json({ ok: true, synced: results });
}
