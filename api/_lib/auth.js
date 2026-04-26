// api/_lib/auth.js
// JWT verification guard. Call verifyJWT(req) at the top of every protected route.
// Works in both Node.js (IncomingMessage headers object) and Edge (Request headers.get).

import { jwtVerify } from 'jose';

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

// Returns { userId, email, role } or throws.
export async function verifyJWT(req) {
  const authHeader = req.headers['authorization'] ?? req.headers.get?.('authorization');
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token');
  const token = authHeader.slice(7);
  const { payload } = await jwtVerify(token, SECRET);
  return { userId: payload.sub, email: payload.email, role: payload.role ?? 'user' };
}
