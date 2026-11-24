import { withAuth } from '../../../../server/auth.js';
import { tx } from '../../../../server/db.js';
import { recordAudit } from '../../../../server/audit.js';
import { json, methodNotAllowed, UUID_RE } from '../../../../server/http.js';

export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const farmId = one(req.query.id), eid = one(req.query.eid);
  if (!farmId || !eid || !UUID_RE.test(farmId) || !UUID_RE.test(eid)) return json(res, 404, { error: 'Enrolment not found' });

  const ok = await tx(async (q) => {
    const r = await q.query<{ id: string; display_name: string | null }>(
      `UPDATE enrolments SET cancelled_at = now()
        WHERE id = $1 AND farm_id = $2 AND org_id = $3 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > now()
        RETURNING id, display_name`,
      [eid, farmId, ctx.orgId],
    );
    if (!r.rows[0]) return false;
    await recordAudit(q, {
      orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username,
      action: 'enrolment.cancel', subjectType: 'enrolment', subjectId: eid, subjectLabel: r.rows[0].display_name ?? undefined,
      outcome: 'success', detail: { farm_id: farmId },
    });
    return true;
  });
  // Unknown, already used, already cancelled, expired, or another org's: all the same answer.
  if (!ok) return json(res, 404, { error: 'No outstanding enrolment found' });
  return json(res, 200, { ok: true });
});
