import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  const url = new URL(req.url);
  const id = url.pathname.split('/').pop();

  if (req.method === 'GET') {
    const { data, error: err } = await supabaseAdmin
      .from('meetings').select('*').eq('id', id).eq('user_id', user.id).single();
    if (err) return error('Meeting not found', 404);
    return json(data);
  }

  if (req.method === 'PUT') {
    const body = await req.json();
    const allowed = ['title','platform','date','time','duration','link',
                     'attendees','agenda','needs','notes','related_msg_ids','ai_prep'];
    const update = {
      ...Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k))),
      updated_at: new Date().toISOString()
    };
    const { data, error: err } = await supabaseAdmin
      .from('meetings').update(update).eq('id', id).eq('user_id', user.id).select().single();
    if (err) return error(err.message);
    return json(data);
  }

  if (req.method === 'DELETE') {
    await supabaseAdmin.from('meetings').delete().eq('id', id).eq('user_id', user.id);
    return json({ success: true });
  }

  return error('Method not allowed', 405);
});
