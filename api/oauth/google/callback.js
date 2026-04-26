// api/oauth/google/callback.js  [EDGE RUNTIME — do not change runtime]
export const config = { runtime: 'edge' };

import { jwtVerify } from 'jose';
import { encrypt } from '../../_lib/crypto.js';
import { createSupabaseClient } from '../../_lib/supabase.js';

export default async function handler(req) {
  const base = process.env.APP_BASE_URL || 'https://acgpulseintel.com';
  try {
    const url        = new URL(req.url, base);
    const code       = url.searchParams.get('code');
    const stateToken = url.searchParams.get('state');
    const error      = url.searchParams.get('error');

    // Verify signed state to prevent CSRF
    let userId;
    try {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET);
      const { payload } = await jwtVerify(stateToken, secret);
      userId = payload.uid;
    } catch {
      return Response.redirect(`${base}/app?error=google_invalid_state`, 302);
    }

    if (error || !code || !userId) {
      console.error('[google/callback] OAuth denied or missing params:', error);
      return Response.redirect(`${base}/app?error=google_denied`, 302);
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
        code,
      }),
    });
    if (!tokenRes.ok) throw new Error(await tokenRes.text());
    const tokens = await tokenRes.json();

    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();
    const supabase  = createSupabaseClient();

    await supabase.from('oauth_tokens').upsert({
      user_id:       userId,
      provider:      'google',
      scope:         'gmail',
      access_token:  await encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token ? await encrypt(tokens.refresh_token) : null,
      expires_at:    expiresAt,
    }, { onConflict: 'user_id,provider,scope' });

    await supabase.from('oauth_tokens').upsert({
      user_id:       userId,
      provider:      'google',
      scope:         'gcal',
      access_token:  await encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token ? await encrypt(tokens.refresh_token) : null,
      expires_at:    expiresAt,
    }, { onConflict: 'user_id,provider,scope' });

    fetch(`${base}/api/sync/google`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal':   process.env.JWT_SECRET,
      },
      body: JSON.stringify({ userId, initial: true }),
    }).catch(e => console.error('Google initial sync trigger failed:', e.message));

    return Response.redirect(`${base}/app?connected=google`, 302);

  } catch (err) {
    console.error('[google/callback]', err.message);
    return Response.redirect(`${base}/app?error=oauth_failed`, 302);
  }
}
