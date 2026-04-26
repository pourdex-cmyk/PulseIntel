// api/oauth/microsoft/initiate.js  [nodejs runtime]
import { verifyJWT } from '../../_lib/auth.js';

export default async function handler(req, res) {
  const user = await verifyJWT(req).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  process.env.MICROSOFT_REDIRECT_URI,
    response_mode: 'query',
    scope: [
      'offline_access',
      'Mail.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'Calendars.Read',
      'Chat.Read',
      'User.Read',
    ].join(' '),
    state: user.userId,
    prompt: 'consent',
  });

  res.redirect(302, `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
}
