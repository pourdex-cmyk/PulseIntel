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

  const payload = await req.json();
  const uid     = url.searchParams.get('uid');
  if (!uid) return json({ ok: true });

  const { data: settings } = await supabaseAdmin
    .from('user_settings').select('user_id').eq('outlook_uid', uid).single();
  if (!settings) return json({ ok: true });

  const userId      = settings.user_id;
  const accessToken = await getMsAccessToken(supabaseAdmin, userId);
  const expectedState = process.env.OUTLOOK_CLIENT_STATE;

  for (const notification of (payload.value || [])) {
    if (expectedState && notification.clientState !== expectedState) continue;
    if (notification.changeType !== 'created') continue;

    let subject    = '(No subject)';
    let fromName   = 'Unknown';
    let fromEmail  = '';
    let bodyText   = '';
    let bodyHtml   = '';
    let importance = 'normal';
    let receivedAt = new Date().toISOString();

    // Fetch the full email from Graph for complete body content
    if (accessToken && notification.resourceData?.id) {
      try {
        const msgId  = notification.resourceData.id;
        const full   = await graphGet(
          `/me/messages/${msgId}?$select=subject,from,body,importance,receivedDateTime,bodyPreview`,
          accessToken
        );
        subject    = full.subject    || '(No subject)';
        fromName   = full.from?.emailAddress?.name    || full.from?.emailAddress?.address || 'Unknown';
        fromEmail  = full.from?.emailAddress?.address || '';
        bodyHtml   = full.body?.content               || '';
        bodyText   = bodyHtml.replace(/<[^>]+>/g, '').trim();
        importance = full.importance || 'normal';
        receivedAt = full.receivedDateTime || receivedAt;
      } catch { /* fall back to notification payload */ }
    }

    // Fall back to whatever came in the notification if Graph fetch failed
    if (!bodyText) {
      const r   = notification.resourceData || {};
      subject    = r.subject    || subject;
      fromName   = r.from?.emailAddress?.name    || r.from?.emailAddress?.address || fromName;
      fromEmail  = r.from?.emailAddress?.address || fromEmail;
      bodyText   = r.bodyPreview || '';
      bodyHtml   = `<p>${bodyText}</p>`;
      importance = r.importance  || importance;
      receivedAt = r.receivedDateTime || receivedAt;
    }

    const baseText = `${subject} ${bodyText}${importance === 'high' ? ' urgent' : ''}`;
    const priority = scorePriority(baseText);
    const category = categorize(`${subject} ${bodyText}`);

    await supabaseAdmin.from('messages').insert({
      user_id:     userId,
      source:      'outlook',
      type:        'email',
      sender:      fromName,
      handle:      fromEmail,
      subject,
      preview:     bodyText.substring(0, 120),
      body:        bodyHtml || `<p>${bodyText}</p>`,
      tags:        [category],
      category,
      priority,
      channel:     null,
      unread:      true,
      received_at: receivedAt,
    });
  }

  return json({ ok: true });
}
