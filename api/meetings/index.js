import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const filter = url.searchParams.get('filter'); // today|upcoming|past|all
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    let query = supabaseAdmin
      .from('meetings')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: true })
      .order('time', { ascending: true });

    if (filter === 'today')    query = query.eq('date', today);
    if (filter === 'upcoming') query = query.gte('date', tomorrow);
    if (filter === 'past')     query = query.lt('date', today);

    const { data, error: err } = await query;
    if (err) return error(err.message);
    return json({ meetings: data });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    if (!body.title) return error('Title is required');

    const { data, error: err } = await supabaseAdmin
      .from('meetings')
      .insert({
        user_id:    user.id,
        title:      body.title,
        platform:   body.platform || 'teams',
        date:       body.date,
        time:       body.time,
        duration:   body.duration || '1 hr',
        link:       body.link || null,
        attendees:  body.attendees || [],
        agenda:     body.agenda || [],
        needs:      body.needs || [],
        notes:      body.notes || '',
        related_msg_ids: body.related_msg_ids || [],
        ai_prep:    '',
      })
      .select()
      .single();
    if (err) return error(err.message);
    return json(data, 201);
  }

  return error('Method not allowed', 405);
});
