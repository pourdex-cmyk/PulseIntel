import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, handleOptions, rateLimit } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return error('Method not allowed', 405);

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const limited = rateLimit(`login:${ip}`, { max: 5, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { email, password } = await req.json();
    if (!email || !password) return error('Email and password required');

    const { data, error: authErr } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (authErr) return error('Invalid credentials', 401);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    return json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: { id: data.user.id, email: data.user.email },
      profile: profile || {}
    });
  } catch (err) {
    return error('Login failed: ' + err.message, 500);
  }
}
