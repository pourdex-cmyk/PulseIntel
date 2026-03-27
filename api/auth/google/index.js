import { supabaseAdmin } from '../../../lib/supabase.js';
import { error } from '../../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url   = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return error('Missing session token', 401);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return error('Google OAuth not configured — add GOOGLE_CLIENT_ID to Vercel env vars', 503);

  // Validate session and get user ID
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return error('Invalid or expired session', 401);

  const appUrl = process.env.APP_URL || 'https://acgpulseintel.com';
  const secret = (process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!').slice(0, 32).padEnd(32, '0');

  // Encrypt state: { uid, ts }
  const statePayload = JSON.stringify({ uid: user.id, ts: Date.now() });
  const key   = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv    = crypto.getRandomValues(new Uint8Array(12));
  const enc   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(statePayload));
  const state = btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(enc)));

  const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',   // read + send + trash + mark read
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar.events', // read + create/update events
    'https://www.googleapis.com/auth/userinfo.email',  // get the user's email address
  ].join(' ');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri',  `${appUrl}/api/auth/google/callback`);
  authUrl.searchParams.set('scope',         scopes);
  authUrl.searchParams.set('state',         state);
  authUrl.searchParams.set('access_type',   'offline');  // ensures refresh_token is returned
  authUrl.searchParams.set('prompt',        'consent');  // force consent to always get refresh_token

  return Response.redirect(authUrl.toString(), 302);
}
