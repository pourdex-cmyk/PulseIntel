// api/_lib/crypto.js
// AES-256-GCM via Web Crypto API — works in Edge runtime AND Node.js 18+.
// ENCRYPTION_KEY env var must be a 64-char hex string (32 bytes).
// All functions are async.

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64) {
  return new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
}

async function getKey() {
  const bytes = hexToBytes(process.env.ENCRYPTION_KEY);
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Returns base64 string: iv(12B) + ciphertext+tag
export async function encrypt(plaintext) {
  const key = await getKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const combined = new Uint8Array(iv.length + enc.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(enc), iv.length);
  return bytesToBase64(combined);
}

// Takes base64 string from encrypt(), returns plaintext
export async function decrypt(ciphertext) {
  const key  = await getKey();
  const data = base64ToBytes(ciphertext);
  const iv   = data.slice(0, 12);
  const enc  = data.slice(12);
  const dec  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, enc);
  return new TextDecoder().decode(dec);
}

// ── getValidToken ─────────────────────────────────────────────────────────────
// Returns a valid plaintext access token for user+provider+scope.
// Auto-refreshes if expired (<5 min remaining). Throws if no token or refresh fails.
import { createSupabaseClient } from './supabase.js';

export async function getValidToken(userId, provider, scope) {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('oauth_tokens')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('scope', scope)
    .single();

  if (error || !data) throw new Error(`No ${provider}/${scope} token for user ${userId}`);

  // Still valid with >5 min buffer
  if (Date.now() < new Date(data.expires_at).getTime() - 5 * 60 * 1000) {
    return decrypt(data.access_token);
  }

  // Expired — attempt refresh
  if (!data.refresh_token) throw new Error(`No refresh token for ${provider}/${scope}`);
  const refreshToken = await decrypt(data.refresh_token);
  let newTokens;

  if (provider === 'microsoft') {
    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) throw new Error(`MS refresh failed: ${await res.text()}`);
    newTokens = await res.json();
  } else if (provider === 'google') {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) throw new Error(`Google refresh failed: ${await res.text()}`);
    newTokens = await res.json();
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const newExpiry = new Date(Date.now() + (newTokens.expires_in ?? 3600) * 1000).toISOString();
  await supabase.from('oauth_tokens').update({
    access_token:  await encrypt(newTokens.access_token),
    refresh_token: newTokens.refresh_token
      ? await encrypt(newTokens.refresh_token)
      : data.refresh_token,
    expires_at:  newExpiry,
    updated_at:  new Date().toISOString(),
  }).eq('id', data.id);

  return newTokens.access_token;
}
