import { withAuth } from '../server/auth.js';
import { db } from '../server/db.js';
import { json, methodNotAllowed } from '../server/http.js';

// Open alerts and recent history for the caller's organisation. Searchable history arrives with US-062.
export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const openOnly = req.query.state === 'open';
  const r = await db.query(
    `SELECT id, rule, subject_type, subject_id, subject_label, farm_id, opened_at, silent_since, closed_at,
            duration_s, outage_s, close_reason, detail
       FROM alerts
      WHERE org_id = $1 ${openOnly ? 'AND closed_at IS NULL' : ''}
      ORDER BY (closed_at IS NULL) DESC, opened_at DESC
      LIMIT 200`,
    [ctx.orgId],
  );
  return json(res, 200, { alerts: r.rows });
});
