import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  const url = new URL(req.url);
  const id = url.pathname.split('/').pop();

  if (req.method === 'GET') {
    const { data, error: err } = await supabaseAdmin
      .from('messages').select('*').eq('id', id).eq('user_id', user.id).single();
    if (err) return error('Message not found', 404);
    // Auto-mark as read on fetch
    await supabaseAdmin.from('messages').update({ unread: false }).eq('id', id);
    return json({ ...data, unread: false });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const allowed = ['unread','category','priority','tags'];
    const update = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k))
    );
    const { data, error: err } = await supabaseAdmin
      .from('messages').update(update).eq('id', id).eq('user_id', user.id).select().single();
    if (err) return error(err.message);
    return json(data);
  }

  if (req.method === 'DELETE') {
    await supabaseAdmin.from('messages').delete().eq('id', id).eq('user_id', user.id);
    return json({ success: true });
  }

  return error('Method not allowed', 405);
});
