import { withAuth } from '../../server/auth.js';
import { tx } from '../../server/db.js';
import { recordAudit } from '../../server/audit.js';
import { json, methodNotAllowed } from '../../server/http.js';

// Put this organisation's failed alert notifications of the last 24 hours back in the queue.
export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const n = await tx(async (q) => {
    const r = await q.query(
      `UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = now()
        WHERE org_id = $1 AND status = 'failed' AND kind <> 'test' AND created_at > now() - interval '24 hours'`, [ctx.orgId]);
    await recordAudit(q, {
      orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username, action: 'notification.retry',
      outcome: 'success', detail: { requeued: r.rowCount },
    });
    return r.rowCount ?? 0;
  });
  return json(res, 200, { requeued: n });
});
