import { withAuth, signOut } from '../../server/auth.js';
import { json, methodNotAllowed } from '../../server/http.js';

export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  await signOut(res, ctx);
  return json(res, 200, { ok: true });
});
