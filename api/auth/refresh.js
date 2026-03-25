import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, handleOptions } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return error('Method not allowed', 405);
  try {
    const { refresh_token } = await req.json();
    if (!refresh_token) return error('Refresh token required');
    const { data, error: err } = await supabaseAdmin.auth.refreshSession({ refresh_token });
    if (err) return error('Session expired — please log in again', 401);
    return json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at
    });
  } catch (err) {
    return error(err.message, 500);
  }
}
