import { withAuth } from '../server/auth.js';
import { buildOverview } from '../server/overview.js';
import { json, methodNotAllowed } from '../server/http.js';

// The home screen's data. Polled by the browser, so it is passive: polling must not keep a session alive.
export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  return json(res, 200, await buildOverview(ctx.orgId));
}, { passive: true });
