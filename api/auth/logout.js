import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, handleOptions, requireAuth } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return error('Method not allowed', 405);
  try {
    const { token } = await requireAuth(req);
    await supabaseAdmin.auth.admin.signOut(token);
    return json({ success: true });
  } catch (err) {
    return json({ success: true }); // Always succeed on logout
  }
}
