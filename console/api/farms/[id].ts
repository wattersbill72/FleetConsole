import { withAuth } from '../../server/auth.js';
import { db, tx } from '../../server/db.js';
import { recordAudit } from '../../server/audit.js';
import { validateFarm, type FarmFields } from '../../server/farms.js';
import { bodyObject, json, methodNotAllowed, UUID_RE } from '../../server/http.js';

const COLS = 'id, name, description, time_zone, created_at, updated_at';

export default withAuth(async (req, res, ctx) => {
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  // A malformed id and another organisation's id are both just "not found".
  if (!id || !UUID_RE.test(id)) return json(res, 404, { error: 'Farm not found' });

  if (req.method === 'GET') {
    const r = await db.query(`SELECT ${COLS} FROM farms WHERE id = $1 AND org_id = $2`, [id, ctx.orgId]);
    if (!r.rows[0]) return json(res, 404, { error: 'Farm not found' });
    return json(res, 200, { farm: r.rows[0] });
  }

  if (req.method === 'PATCH') {
    const v = validateFarm(bodyObject(req), true);
    if (!v.ok) return json(res, 400, { error: v.error });
    try {
      const farm = await tx(async (q) => {
        const cur = await q.query<FarmFields & { id: string }>(
          'SELECT id, name, description, time_zone FROM farms WHERE id = $1 AND org_id = $2 FOR UPDATE',
          [id, ctx.orgId],
        );
        const before = cur.rows[0];
        if (!before) return null;

        const changes: Record<string, { from: string; to: string }> = {};
        for (const k of ['name', 'description', 'time_zone'] as const) {
          const next = v.value[k];
          if (next !== undefined && next !== before[k]) changes[k] = { from: before[k], to: next };
        }
        const merged = { ...before, ...v.value };
        const upd = await q.query(
          `UPDATE farms SET name = $3, description = $4, time_zone = $5, updated_at = now()
            WHERE id = $1 AND org_id = $2 RETURNING ${COLS}`,
          [id, ctx.orgId, merged.name, merged.description, merged.time_zone],
        );
        if (Object.keys(changes).length > 0) {
          await recordAudit(q, {
            orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username,
            action: 'farm.update', subjectType: 'farm', subjectId: id, subjectLabel: merged.name,
            outcome: 'success', detail: { changes },
          });
        }
        return upd.rows[0];
      });
      if (!farm) return json(res, 404, { error: 'Farm not found' });
      return json(res, 200, { farm });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return json(res, 409, { error: 'A farm with that name already exists' });
      }
      throw err;
    }
  }

  return methodNotAllowed(res, ['GET', 'PATCH']);
});
