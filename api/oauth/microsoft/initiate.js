// api/oauth/microsoft/initiate.js  [nodejs runtime]
// Token arrives as query param (browser redirect, no Authorization header possible)
// State is a short-lived signed JWT to prevent CSRF
import { verifyJWT } from '../../_lib/auth.js';
import { SignJWT } from 'jose';

export default async function handler(req, res) {
  // Read JWT from query param (browser redirect) or Authorization header (API call)
  const url    = new URL(req.url, `https://${req.headers.host}`);
  const qToken = url.searchParams.get('token');
  const authReq = qToken
    ? { headers: { authorization: `Bearer ${qToken}` } }
    : req;

  const user = await verifyJWT(authReq).catch(() => null);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Sign state with JWT_SECRET — expires in 15 minutes
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const state  = await new SignJWT({ uid: user.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('15m')
    .setIssuedAt()
    .sign(secret);

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
    state,
    prompt: 'consent',
  });

  res.redirect(302, `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
}
