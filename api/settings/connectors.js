import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

export default withAuth(async (req, { user }) => {
  if (req.method === 'GET') {
    // Read connected status from oauth_tokens (new system) not user_settings (old columns)
    const { data: tokens } = await supabaseAdmin
      .from('oauth_tokens')
      .select('provider, scope, expires_at, updated_at')
      .eq('user_id', user.id);

    const connected = {
      teams:   !!(tokens || []).find(t => t.provider === 'microsoft' && t.scope === 'teams'),
      outlook: !!(tokens || []).find(t => t.provider === 'microsoft' && t.scope === 'outlook'),
      gmail:   !!(tokens || []).find(t => t.provider === 'google'    && t.scope === 'gmail'),
      slack:   false, // Slack OAuth not yet implemented
    };

    const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL || 'https://acgpulseintel.com';
    const webhooks = {
      teams:   `${baseUrl}/api/webhooks/microsoft`,
      outlook: `${baseUrl}/api/webhooks/microsoft`,
      gmail:   `${baseUrl}/api/webhooks/google`,
    };

    return json({
      connected,
      webhooks,
      claude_configured: !!process.env.ANTHROPIC_API_KEY,
    });
  }

  if (req.method === 'DELETE') {
    const { source } = await req.json();
    if (!['microsoft', 'google', 'teams', 'outlook', 'gmail'].includes(source)) {
      return error('Invalid source');
    }
    // Map UI source names to provider names
    const provider = (source === 'teams' || source === 'outlook') ? 'microsoft'
                   : (source === 'gmail') ? 'google'
                   : source;

    await supabaseAdmin
      .from('oauth_tokens')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', provider);

    return json({ success: true });
  }

  return error('Method not allowed', 405);
});
