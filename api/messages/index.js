import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const source    = url.searchParams.get('source');     // outlook|gmail|teams|slack
    const tab       = url.searchParams.get('tab');        // email|chat
    const category  = url.searchParams.get('category');  // action|fyi|noise|meeting
    const unread    = url.searchParams.get('unread');
    const priority  = url.searchParams.get('priority');  // min priority score
    const limit     = parseInt(url.searchParams.get('limit') || '50');
    const offset    = parseInt(url.searchParams.get('offset') || '0');

    let query = supabaseAdmin
      .from('messages')
      .select('*', { count: 'exact' })
      .eq('user_id', user.id)
      .order('received_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (source) query = query.eq('source', source);
    if (tab === 'email') query = query.in('source', ['outlook','gmail']);
    if (tab === 'chat')  query = query.in('source', ['teams','slack']);
    if (category)  query = query.eq('category', category);
    if (unread === 'true') query = query.eq('unread', true);
    if (priority)  query = query.gte('priority', parseInt(priority));

    const { data, error: err, count } = await query;
    if (err) return error(err.message);
    return json({ messages: data, total: count, offset, limit });
  }

  return error('Method not allowed', 405);
});
