// api/oauth/microsoft/callback.js  [EDGE RUNTIME — do not change runtime]
export const config = { runtime: 'edge' };

import { encrypt } from '../../_lib/crypto.js';
import { createSupabaseClient } from '../../_lib/supabase.js';

export default async function handler(req) {
  const base = process.env.APP_BASE_URL || 'https://acgpulseintel.com';
  try {
    const url    = new URL(req.url, base);
    const code   = url.searchParams.get('code');
    const userId = url.searchParams.get('state');
    const error  = url.searchParams.get('error');

    if (error || !code || !userId) {
      console.error('[microsoft/callback] OAuth denied or missing params:', error);
      return Response.redirect(`${base}/app?error=oauth_denied`, 302);
    }

    const tokenRes = await fetch(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     process.env.MICROSOFT_CLIENT_ID,
          client_secret: process.env.MICROSOFT_CLIENT_SECRET,
          redirect_uri:  process.env.MICROSOFT_REDIRECT_URI,
          grant_type:    'authorization_code',
          code,
        }),
      }
    );
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      throw new Error(`Token exchange failed: ${txt}`);
    }
    const tokens = await tokenRes.json();

    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();
    const supabase  = createSupabaseClient();

    await supabase.from('oauth_tokens').upsert({
      user_id:       userId,
      provider:      'microsoft',
      scope:         'outlook',
      access_token:  await encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token ? await encrypt(tokens.refresh_token) : null,
      expires_at:    expiresAt,
    }, { onConflict: 'user_id,provider,scope' });

    await supabase.from('oauth_tokens').upsert({
      user_id:       userId,
      provider:      'microsoft',
      scope:         'teams',
      access_token:  await encrypt(tokens.access_token),
      refresh_token: tokens.refresh_token ? await encrypt(tokens.refresh_token) : null,
      expires_at:    expiresAt,
    }, { onConflict: 'user_id,provider,scope' });

    // Fire-and-forget initial sync — do not await, do not block redirect
    fetch(`${base}/api/sync/microsoft`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal':   process.env.JWT_SECRET,
      },
      body: JSON.stringify({ userId, initial: true }),
    }).catch(e => console.error('Initial sync trigger failed:', e.message));

    return Response.redirect(`${base}/app?connected=microsoft`, 302);

  } catch (err) {
    console.error('[microsoft/callback]', err.message);
    return Response.redirect(`${base}/app?error=oauth_failed`, 302);
  }
}
