import type { VercelRequest, VercelResponse } from '@vercel/node';
import { signIn, startSession } from '../../server/auth.js';
import { bodyObject, json, methodNotAllowed } from '../../server/http.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const b = bodyObject(req);
  if (typeof b.username !== 'string' || typeof b.password !== 'string' || !b.username || !b.password) {
    return json(res, 400, { error: 'Username and password are required' });
  }
  const result = await signIn(b.username, b.password);
  if (!result.ok) return json(res, result.status, { error: result.error });
  startSession(res, result.token);
  return json(res, 200, { ok: true });
}
