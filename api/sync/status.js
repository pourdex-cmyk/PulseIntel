// api/sync/status.js  [nodejs runtime]
import { verifyJWT } from '../_lib/auth.js';
import { createSupabaseClient } from '../_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  const user = await verifyJWT(req).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createSupabaseClient();

  const [{ data: tokens }, { count: messageCount }, { count: meetingCount }] = await Promise.all([
    supabase
      .from('oauth_tokens')
      .select('provider, scope, expires_at, updated_at')
      .eq('user_id', user.userId),
    supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.userId),
    supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.userId),
  ]);

  const connected = (tokens || []).map(t => ({
    provider: t.provider,
    scope:    t.scope,
    lastSync: t.updated_at,
    expired:  new Date(t.expires_at) < new Date(),
  }));

  return res.status(200).json({
    connected,
    messageCount: messageCount ?? 0,
    meetingCount: meetingCount ?? 0,
    providers: {
      microsoft: connected.some(t => t.provider === 'microsoft'),
      google:    connected.some(t => t.provider === 'google'),
    },
  });
}
