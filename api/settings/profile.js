import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  // GET /api/settings/profile
  if (req.method === 'GET') {
    const { data, error: err } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    if (err) return error('Profile not found', 404);
    return json(data);
  }

  // PUT /api/settings/profile
  if (req.method === 'PUT') {
    const body = await req.json();
    const allowed = ['first_name','last_name','title','company','signoff','style_notes',
                     'tone','model','draft_length','auto_analyze'];
    const update = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k))
    );
    update.updated_at = new Date().toISOString();

    const { data, error: err } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: user.id, ...update })
      .select()
      .single();
    if (err) return error(err.message);
    return json(data);
  }

  return error('Method not allowed', 405);
});
