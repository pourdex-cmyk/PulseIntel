import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error } from '../../lib/middleware.js';
import { getMsAccessToken, graphGet, scorePriority, categorize } from '../../lib/msGraph.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req) {
  const url = new URL(req.url);

  // Microsoft Graph subscription validation
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, { headers: { 'Content-Type': 'text/plain' } });
  }

  if (req.method !== 'POST') return error('Method not allowed', 405);

  const payload     = await req.json();
  const uid         = url.searchParams.get('uid');
  const type        = url.searchParams.get('type'); // 'calendar' or undefined (= chat messages)
  if (!uid) return json({ ok: true });

  const { data: settings } = await supabaseAdmin
    .from('user_settings').select('user_id').eq('teams_uid', uid).single();
  if (!settings) return json({ ok: true });

  const userId = settings.user_id;

  // Get a valid (auto-refreshed) access token
  const accessToken = await getMsAccessToken(supabaseAdmin, userId);

  const expectedState = process.env.TEAMS_CLIENT_STATE;

  for (const notification of (payload.value || [])) {
    if (expectedState && notification.clientState !== expectedState) continue;

    // ── Calendar event notification ───────────────────────────────────────
    if (type === 'calendar' || notification.resource?.includes('me/events')) {
      if (!['created', 'updated'].includes(notification.changeType)) continue;
      await handleCalendarNotification(notification, userId, accessToken);
      continue;
    }

    // ── Chat / channel message notification ───────────────────────────────
    if (notification.changeType !== 'created') continue;

    let resource = notification.resourceData || {};

    // If we have an access token, fetch the full message for richer content
    if (accessToken && notification.resource) {
      try {
        const path = '/' + notification.resource.replace('https://graph.microsoft.com/v1.0/', '');
        const full = await graphGet(path, accessToken);
        if (full?.body?.content) resource = full;
      } catch { /* fall back to notification payload */ }
    }

    const content = (resource.body?.content || '').replace(/<[^>]+>/g, '').trim();
    if (!content) continue;

    const from    = resource.from?.user || resource.from || {};
    const channel = resource.channelIdentity?.channelId || null;

    await supabaseAdmin.from('messages').insert({
      user_id:     userId,
      source:      'teams',
      type:        channel ? 'channel' : 'message',
      sender:      from.displayName || from.name || 'Unknown',
      handle:      from.userPrincipalName || from.email || '',
      subject:     content.substring(0, 80) || 'Teams message',
      preview:     content.substring(0, 120),
      body:        resource.body?.content || `<p>${content}</p>`,
      tags:        [categorize(content)],
      category:    categorize(content),
      priority:    scorePriority(content),
      channel:     channel ? `#${channel}` : null,
      unread:      true,
      received_at: resource.createdDateTime || new Date().toISOString(),
    });
  }

  return json({ ok: true });
}

async function handleCalendarNotification(notification, userId, accessToken) {
  try {
    if (!accessToken) return;

    // Fetch the full event from Graph
    const path = '/' + notification.resource.replace('https://graph.microsoft.com/v1.0/', '');
    const event = await graphGet(
      path + '?$select=subject,start,end,organizer,attendees,onlineMeeting,bodyPreview,location',
      accessToken
    );

    const startDt = new Date(event.start?.dateTime
      ? event.start.dateTime + (event.start.timeZone === 'UTC' ? 'Z' : '')
      : Date.now());
    const endDt = new Date(event.end?.dateTime
      ? event.end.dateTime + (event.end.timeZone === 'UTC' ? 'Z' : '')
      : startDt.getTime() + 3600000);

    const durationMin = Math.round((endDt - startDt) / 60000);
    const duration    = durationMin >= 60 ? `${Math.round(durationMin / 60)} hr` : `${durationMin} min`;
    const date        = startDt.toISOString().split('T')[0];
    const time        = startDt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

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

    if (notification.changeType === 'created') {
      await supabaseAdmin.from('meetings').insert({
        user_id:   userId,
        title:     event.subject || 'Untitled meeting',
        platform,
        date,
        time,
        duration,
        link:      joinUrl,
        attendees: JSON.stringify(attendees),
        agenda:    JSON.stringify([]),
        notes:     event.bodyPreview || '',
        ai_prep:   '',
      });
    } else if (notification.changeType === 'updated') {
      // Update existing meeting by matching title + date (best-effort)
      await supabaseAdmin.from('meetings')
        .update({ title: event.subject, date, time, duration, link: joinUrl, attendees: JSON.stringify(attendees) })
        .eq('user_id', userId)
        .eq('title', event.subject)
        .eq('date', date);
    }
  } catch (e) {
    console.warn('Calendar notification handling:', e.message);
  }
}
