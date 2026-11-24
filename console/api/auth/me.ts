import { withAuth } from '../../server/auth.js';
import { db } from '../../server/db.js';
import { json, methodNotAllowed } from '../../server/http.js';

export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const r = await db.query<{ id: string; name: string; product_name: string }>(
    'SELECT id, name, product_name FROM organisations WHERE id = $1',
    [ctx.orgId],
  );
  const org = r.rows[0];
  return json(res, 200, {
    user: { id: ctx.userId, username: ctx.username },
    org: { id: org.id, name: org.name, productName: org.product_name },
  });
});
