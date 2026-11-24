import { withAuth } from '../../../server/auth.js';
import { tx } from '../../../server/db.js';
import { recordAudit } from '../../../server/audit.js';
import { json, methodNotAllowed, UUID_RE } from '../../../server/http.js';

export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id || !UUID_RE.test(id)) return json(res, 404, { error: 'Not found' });
  const gone = await tx(async (q) => {
    const r = await q.query<{ address: string }>(
      'DELETE FROM notification_targets WHERE id = $1 AND org_id = $2 RETURNING address', [id, ctx.orgId]);
    if (!r.rows[0]) return false;
    await recordAudit(q, {
      orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username, action: 'notification_target.delete',
      subjectType: 'notification_target', subjectId: id, subjectLabel: r.rows[0].address, outcome: 'success',
    });
    return true;
  });
  if (!gone) return json(res, 404, { error: 'Not found' });
  return json(res, 200, { ok: true });
});
