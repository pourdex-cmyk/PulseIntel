import { supabaseAdmin } from '../../lib/supabase.js';
import { json, error, withAuth } from '../../lib/middleware.js';

export const config = { runtime: 'edge' };

// Simple symmetric encryption using Web Crypto API
async function encrypt(text, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')),
    { name: 'AES-GCM' }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key, new TextEncoder().encode(text)
  );
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(encrypted)));
}

async function decrypt(encoded, secret) {
  const raw = atob(encoded);
  const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0)));
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret.slice(0, 32).padEnd(32, '0')),
    { name: 'AES-GCM' }, false, ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

const SECRET = process.env.JWT_SECRET || 'dev-secret-32-chars-minimum!!!';

export default withAuth(async (req, { user }) => {
  if (req.method === 'GET') {
    const { data } = await supabaseAdmin
      .from('user_settings')
      .select('*')
      .eq('user_id', user.id)
      .single();
    if (!data) return json({ connected: {} });

    // Return which sources are connected (not the actual tokens)
    const connected = {};
    for (const src of ['teams','slack','outlook','gmail']) {
      connected[src] = !!data[`${src}_token`];
    }
    // Also return webhook URLs
    const baseUrl = process.env.APP_URL || 'https://your-app.vercel.app';
    const userId = user.id.replace(/-/g,'').slice(0,16);
    const webhooks = {
      teams:   `${baseUrl}/api/webhooks/teams?uid=${userId}`,
      slack:   `${baseUrl}/api/webhooks/slack?uid=${userId}`,
      outlook: `${baseUrl}/api/webhooks/outlook?uid=${userId}`,
      gmail:   `${baseUrl}/api/webhooks/gmail?uid=${userId}`,
    };
    return json({ connected, webhooks, claude_configured: !!(data.claude_key_encrypted || process.env.ANTHROPIC_API_KEY) });
  }

  if (req.method === 'PUT') {
    const body = await req.json();
    const update = { user_id: user.id, updated_at: new Date().toISOString() };

    if (body.claude_key) {
      update.claude_key_encrypted = await encrypt(body.claude_key, SECRET);
    }
    for (const src of ['teams','slack','outlook','gmail']) {
      if (body[`${src}_token`] !== undefined) {
        update[`${src}_token`] = body[`${src}_token`]
          ? await encrypt(body[`${src}_token`], SECRET)
          : null;
      }
    }

    await supabaseAdmin.from('user_settings').upsert(update);
    return json({ success: true });
  }

  if (req.method === 'DELETE') {
    // Disconnect a specific source
    const { source } = await req.json();
    if (!['teams','slack','outlook','gmail'].includes(source)) return error('Invalid source');
    await supabaseAdmin
      .from('user_settings')
      .update({ [`${source}_token`]: null })
      .eq('user_id', user.id);
    return json({ success: true });
  }

  return error('Method not allowed', 405);
});
