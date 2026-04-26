// api/meetings/index.js  [nodejs runtime]
import { verifyJWT } from '../_lib/auth.js';
import { createSupabaseClient } from '../_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await verifyJWT(req).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createSupabaseClient();

  if (req.method === 'GET') {
    const url      = new URL(req.url, `https://${req.headers.host}`);
    const filter   = url.searchParams.get('filter');
    const today    = new Date().toISOString().substring(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().substring(0, 10);

    let query = supabase
      .from('meetings')
      .select('*')
      .eq('user_id', user.userId)
      .order('date', { ascending: true })
      .order('time', { ascending: true });

    if (filter === 'today')    query = query.eq('date', today);
    if (filter === 'upcoming') query = query.gte('date', tomorrow);
    if (filter === 'past')     query = query.lt('date', today);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Normalize attendees for app.html compatibility
    const meetings = (data || []).map(m => ({
      ...m,
      attendees: typeof m.attendees === 'string'
        ? JSON.parse(m.attendees || '[]')
        : (m.attendees || []),
      agenda: typeof m.agenda === 'string'
        ? JSON.parse(m.agenda || '[]')
        : (m.agenda || []),
      needs: typeof m.needs === 'string'
        ? JSON.parse(m.needs || '[]')
        : (m.needs || []),
    }));

    return res.status(200).json({ meetings });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: 'Title is required' });

    const { data, error } = await supabase
      .from('meetings')
      .insert({
        user_id:   user.userId,
        title:     body.title,
        platform:  body.platform || 'teams',
        date:      body.date,
        time:      body.time,
        duration:  body.duration || '1 hr',
        link:      body.link || null,
        attendees: JSON.stringify(body.attendees || []),
        agenda:    JSON.stringify(body.agenda || []),
        notes:     body.notes || '',
        ai_prep:   '',
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
