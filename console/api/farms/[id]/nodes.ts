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
    `SELECT n.id, n.display_name, n.platform, n.status, n.hostname, n.agent_version, n.last_heartbeat_at, n.enrolled_at,
            (n.decommission_unconfirmed_at IS NOT NULL) AS decommission_unconfirmed,
            (SELECT c.result FROM node_commands c WHERE c.node_id = n.id AND c.command = 'decommission' AND c.status = 'failed'
              ORDER BY c.id DESC LIMIT 1) AS removal_error
       FROM nodes n WHERE n.farm_id = $1 AND n.org_id = $2 AND n.status <> 'removed'
      ORDER BY lower(n.display_name)`,
    [id, ctx.orgId],
  );
  return json(res, 200, { nodes: r.rows });
});
