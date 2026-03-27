import { supabaseAdmin } from '../../../lib/supabase.js';
import { error } from '../../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return error('Missing session token', 401);

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) return error('Microsoft OAuth not configured — add MICROSOFT_CLIENT_ID to Vercel env vars', 503);

  // Validate session and get user ID
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return error('Invalid or expired session', 401);

  const appUrl   = process.env.APP_URL || 'https://your-app.vercel.app';
  const secret   = (process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!').slice(0, 32).padEnd(32, '0');

  // Encrypt state: { uid, ts } — callback uses this to identify the user
  const statePayload = JSON.stringify({ uid: user.id, ts: Date.now() });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(statePayload));
  const state = btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(enc)));

  const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri',  `${appUrl}/api/auth/microsoft/callback`);
  authUrl.searchParams.set('scope',         'offline_access Mail.Read Mail.Send Chat.Read User.Read');
  authUrl.searchParams.set('state',         state);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('prompt',        'consent'); // ensures refresh_token is returned

  return Response.redirect(authUrl.toString(), 302);
}
