import { supabaseAdmin } from './supabase.js';

// ── Rate Limiter ────────────────────────────────────────────────
// In-memory per-instance. Provides basic brute-force protection.
const _rlStore = new Map();
export function rateLimit(key, { max = 10, windowMs = 60_000 } = {}) {
  const now = Date.now();
  let r = _rlStore.get(key);
  if (!r || now > r.reset) r = { count: 0, reset: now + windowMs };
  r.count++;
  _rlStore.set(key, r);
  if (r.count > max) return error('Too many requests — try again later', 429);
  return null;
}

// ── Token Decryption (AES-GCM with JWT_SECRET) ─────────────────
export async function decryptToken(encrypted) {
  try {
    const secret = (process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!').slice(0, 32).padEnd(32, '0');
    const raw    = atob(encrypted);
    const bytes  = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
    const key    = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'AES-GCM' }, false, ['decrypt']);
    const dec    = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return new TextDecoder().decode(dec);
  } catch { return null; }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function error(message, status = 400) {
  return json({ error: message }, status);
}

// Verifies the Supabase JWT from Authorization header
// Returns { user, token } or throws
export async function requireAuth(req) {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) throw new Error('No token provided');

  const { data: { user }, error: err } = await supabaseAdmin.auth.getUser(token);
  if (err || !user) throw new Error('Invalid or expired token');
  return { user, token };
}

// CORS preflight handler — call at top of every API route
export function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

// Wraps a handler with auth + error handling
export function withAuth(handler) {
  return async (req) => {
    if (req.method === 'OPTIONS') return handleOptions();
    try {
      const auth = await requireAuth(req);
      return await handler(req, auth);
    } catch (err) {
      if (err.message?.includes('token') || err.message?.includes('auth')) {
        return error(err.message, 401);
      }
      console.error('[API Error]', err);
      return error(err.message || 'Internal server error', 500);
    }
  };
}
