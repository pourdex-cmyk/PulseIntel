// api/messages/index.js  [nodejs runtime]
import { verifyJWT } from '../_lib/auth.js';
import { createSupabaseClient } from '../_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await verifyJWT(req).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    const url      = new URL(req.url, `https://${req.headers.host}`);
    const source   = url.searchParams.get('source');
    const tab      = url.searchParams.get('tab');
    const category = url.searchParams.get('category');
    const unread   = url.searchParams.get('unread');
    const priority = url.searchParams.get('priority');
    const limit    = parseInt(url.searchParams.get('limit') || '100');
    const offset   = parseInt(url.searchParams.get('offset') || '0');

    const supabase = createSupabaseClient();
    let query = supabase
      .from('messages')
      .select('*', { count: 'exact' })
      .eq('user_id', user.userId)
      .order('received_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (source)             query = query.eq('source', source);
    if (tab === 'email')    query = query.in('source', ['outlook', 'gmail']);
    if (tab === 'chat')     query = query.in('source', ['teams', 'slack']);
    if (category)           query = query.eq('category', category);
    if (unread === 'true')  query = query.eq('unread', true);
    if (priority)           query = query.gte('priority', parseInt(priority));

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Normalize: map new column names to what app.html expects (sender, handle, body, preview)
    const messages = (data || []).map(m => ({
      ...m,
      sender:  m.sender  || m.from_name  || '',
      handle:  m.handle  || m.from_email || '',
      body:    m.body    || m.body_preview || '',
      preview: m.preview || (m.body_preview || '').slice(0, 120),
    }));

    return res.status(200).json({ messages, total: count, offset, limit });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
