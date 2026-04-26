// api/webhooks/microsoft.js  [EDGE RUNTIME]
export const config = { runtime: 'edge' };

import { createSupabaseClient } from '../_lib/supabase.js';
import { decrypt } from '../_lib/crypto.js';

export default async function handler(req) {
  // Microsoft Graph sends a validation token on subscription creation
  const url             = new URL(req.url, process.env.APP_BASE_URL);
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (req.method !== 'POST') return new Response('', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return new Response('', { status: 400 }); }

  const supabase   = createSupabaseClient();
  const clientState = process.env.TEAMS_CLIENT_STATE || process.env.JWT_SECRET?.slice(0, 32) || '';

  for (const notification of (body.value || [])) {
    if (notification.clientState !== clientState) continue;

    const resource  = notification.resource || '';
    const changeType = notification.changeType;
    const uid       = url.searchParams.get('uid');

    if (!uid) continue;

    // Find user by teams_uid in user_settings (legacy) or by oauth_tokens user matching
    const { data: settings } = await supabase
      .from('user_settings')
      .select('user_id')
      .eq('teams_uid', uid)
      .single();

    const userId = settings?.user_id;
    if (!userId) continue;

    // Get the MS access token
    const { data: tokenRow } = await supabase
      .from('oauth_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'microsoft')
      .eq('scope', 'outlook')
      .single();

    if (!tokenRow) continue;

    let accessToken;
    try { accessToken = await decrypt(tokenRow.access_token); } catch { continue; }

    // Calendar notification
    if (url.searchParams.get('type') === 'calendar' || resource.includes('/events/')) {
      const eventId = notification.resourceData?.id;
      if (!eventId) continue;
      try {
        const evRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/events/${eventId}?$select=id,subject,start,end,attendees,onlineMeetingUrl,bodyPreview,organizer`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!evRes.ok) continue;
        const event    = await evRes.json();
        const startRaw = event.start?.dateTime || '';
        const date     = startRaw.substring(0, 10);
        const time     = startRaw.length > 10 ? startRaw.substring(11, 16) : '00:00';
        const attendees = (event.attendees || []).map(a => a.emailAddress?.name || '').filter(Boolean);
        if (changeType === 'deleted') {
          await supabase.from('meetings').delete()
            .eq('user_id', userId).eq('source', 'outlook').eq('external_id', event.id);
        } else {
          await supabase.from('meetings').upsert({
            user_id: userId, source: 'outlook', external_id: event.id,
            title: event.subject || 'Untitled', date, time,
            platform: event.onlineMeetingUrl ? 'teams' : 'inperson',
            link: event.onlineMeetingUrl || null,
            attendees: JSON.stringify(attendees),
            organizer: event.organizer?.emailAddress?.name || '',
            notes: event.bodyPreview || '',
          }, { onConflict: 'user_id,source,external_id' });
        }
      } catch (e) { console.error('Calendar webhook error:', e.message); }
      continue;
    }

    // Email notification
    const messageId = notification.resourceData?.id;
    if (!messageId) continue;
    try {
      const msgRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=id,subject,from,body,receivedDateTime,isRead,importance`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!msgRes.ok) continue;
      const email    = await msgRes.json();
      const bodyText = (email.body?.content || '').replace(/<[^>]+>/g, '').trim();
      await supabase.from('messages').upsert({
        user_id: userId, source: 'outlook', external_id: email.id,
        subject: email.subject || '(no subject)',
        sender: email.from?.emailAddress?.name || '',
        handle: email.from?.emailAddress?.address || '',
        from_name: email.from?.emailAddress?.name || '',
        from_email: email.from?.emailAddress?.address || '',
        body: email.body?.content || '',
        preview: bodyText.slice(0, 120),
        body_preview: bodyText.slice(0, 1000),
        received_at: email.receivedDateTime || new Date().toISOString(),
        unread: !email.isRead, is_read: !!email.isRead,
        type: 'email', category: 'fyi', priority: 50, tags: [],
      }, { onConflict: 'user_id,source,external_id' });
    } catch (e) { console.error('Email webhook error:', e.message); }
  }

  return new Response('', { status: 202 });
}
