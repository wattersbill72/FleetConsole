import { withAuth } from '../../../server/auth.js';
import { db } from '../../../server/db.js';
import { json, methodNotAllowed, UUID_RE } from '../../../server/http.js';

export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id || !UUID_RE.test(id)) return json(res, 404, { error: 'Farm not found' });
  const farm = await db.query('SELECT 1 FROM farms WHERE id = $1 AND org_id = $2', [id, ctx.orgId]);
  if (!farm.rows[0]) return json(res, 404, { error: 'Farm not found' });

  const r = await db.query(
    `SELECT id, display_name, platform, status, hostname, agent_version, last_heartbeat_at, enrolled_at
       FROM nodes WHERE farm_id = $1 AND org_id = $2 AND status <> 'removed'
      ORDER BY lower(display_name)`,
    [id, ctx.orgId],
  );
  return json(res, 200, { nodes: r.rows });
});
