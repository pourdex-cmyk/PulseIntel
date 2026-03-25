import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, handleOptions, rateLimit } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return error('Method not allowed', 405);

  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const limited = rateLimit(`signup:${ip}`, { max: 3, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { email, password, firstName, lastName } = await req.json();
    if (!email || !password) return error('Email and password required');
    if (password.length < 8) return error('Password must be at least 8 characters');

    const { data, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email, password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName }
    });
    if (authErr) return error(authErr.message);

    // Create profile row
    await supabaseAdmin.from('profiles').insert({
      id: data.user.id,
      first_name: firstName || '',
      last_name: lastName || '',
    });

    return json({ user: { id: data.user.id, email: data.user.email } }, 201);
  } catch (err) {
    return error('Signup failed: ' + err.message, 500);
  }
}
