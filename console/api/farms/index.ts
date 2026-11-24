import { withAuth } from '../../server/auth.js';
import { db, tx } from '../../server/db.js';
import { recordAudit } from '../../server/audit.js';
import { validateFarm } from '../../server/farms.js';
import { bodyObject, json, methodNotAllowed } from '../../server/http.js';

const COLS = 'id, name, description, time_zone, created_at, updated_at';

export default withAuth(async (req, res, ctx) => {
  if (req.method === 'GET') {
    const r = await db.query(`SELECT ${COLS} FROM farms WHERE org_id = $1 ORDER BY lower(name)`, [ctx.orgId]);
    return json(res, 200, { farms: r.rows });
  }

  if (req.method === 'POST') {
    const v = validateFarm(bodyObject(req), false);
    if (!v.ok) return json(res, 400, { error: v.error });
    const f = v.value;
    try {
      const farm = await tx(async (q) => {
        const ins = await q.query(
          `INSERT INTO farms (org_id, name, description, time_zone)
           VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
          [ctx.orgId, f.name, f.description ?? '', f.time_zone],
        );
        const row = ins.rows[0];
        await recordAudit(q, {
          orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username,
          action: 'farm.create', subjectType: 'farm', subjectId: row.id, subjectLabel: row.name,
          outcome: 'success',
          detail: { name: row.name, description: row.description, time_zone: row.time_zone },
        });
        return row;
      });
      return json(res, 201, { farm });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return json(res, 409, { error: 'A farm with that name already exists' });
      }
      throw err;
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});
