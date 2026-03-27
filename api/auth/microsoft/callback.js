import { supabaseAdmin } from '../../../lib/supabase.js';

export const config = { runtime: 'edge' };

async function encrypt(text, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')),
    { name: 'AES-GCM' }, false, ['encrypt']
  );
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(enc)));
}

async function decryptState(state, secret) {
  const raw   = atob(state);
  const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
  const key   = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')),
    { name: 'AES-GCM' }, false, ['decrypt']
  );
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(dec));
}

export default async function handler(req) {
  const url      = new URL(req.url);
  const code     = url.searchParams.get('code');
  const state    = url.searchParams.get('state');
  const msError  = url.searchParams.get('error');
  const appUrl   = process.env.APP_URL || 'https://your-app.vercel.app';
  const secret   = process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!';

  if (msError) {
    console.error('Microsoft OAuth denied:', msError, url.searchParams.get('error_description'));
    return Response.redirect(`${appUrl}/app?error=ms_denied`, 302);
  }
  if (!code || !state) return Response.redirect(`${appUrl}/app?error=ms_bad_request`, 302);

  // Decrypt and validate state
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
    body:    new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });

  if (!tokenRes.ok) {
    console.error('Microsoft token exchange failed:', await tokenRes.text());
    return Response.redirect(`${appUrl}/app?error=ms_token_failed`, 302);
  }

  const { access_token, refresh_token, expires_in } = await tokenRes.json();

  // Store both tokens as an encrypted JSON blob in the existing token columns
  const tokenBlob  = JSON.stringify({ at: access_token, rt: refresh_token || null, exp: Date.now() + (expires_in || 3600) * 1000 });
  const encToken   = await encrypt(tokenBlob, secret);

  // Teams and Outlook share the same Microsoft OAuth token
  await supabaseAdmin.from('user_settings').upsert({
    user_id:       userId,
    teams_token:   encToken,
    outlook_token: encToken,
    updated_at:    new Date().toISOString(),
  });

  // Register Microsoft Graph webhook subscriptions
  const shortUid = userId.replace(/-/g, '').slice(0, 16);

  // Outlook inbox — max subscription lifetime: 4230 minutes
  const outlookExpiry = new Date(Date.now() + 4230 * 60 * 1000).toISOString();
  const outlookRes = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      changeType:           'created',
      notificationUrl:      `${appUrl}/api/webhooks/outlook?uid=${shortUid}`,
      resource:             "me/mailFolders('Inbox')/messages",
      expirationDateTime:   outlookExpiry,
      clientState:          process.env.OUTLOOK_CLIENT_STATE || '',
    }),
  });
  if (!outlookRes.ok) console.warn('Outlook subscription registration failed:', await outlookRes.text());

  // Teams chat messages — max subscription lifetime: 60 minutes
  const teamsExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const teamsRes = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      changeType:           'created',
      notificationUrl:      `${appUrl}/api/webhooks/teams?uid=${shortUid}`,
      resource:             'me/chats/getAllMessages',
      expirationDateTime:   teamsExpiry,
      clientState:          process.env.TEAMS_CLIENT_STATE || '',
    }),
  });
  if (!teamsRes.ok) console.warn('Teams subscription registration failed:', await teamsRes.text());

  return Response.redirect(`${appUrl}/app?connected=microsoft`, 302);
}
