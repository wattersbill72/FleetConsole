import { withAuth } from '../../server/auth.js';
import { db } from '../../server/db.js';
import { recordAudit } from '../../server/audit.js';
import { sendTest } from '../../server/notify/deliver.js';
import { json, methodNotAllowed } from '../../server/http.js';

// One immediate attempt to every enabled target, with the answer shown to the operator.
export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const results = await sendTest(ctx.orgId);
  if (results.length === 0) return json(res, 400, { error: 'Add a notification address first', results });
  await recordAudit(db, {
    orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username, action: 'notification.test',
    outcome: results.every((r) => r.ok) ? 'success' : 'failure', detail: { targets: results.length },
  });
  return json(res, 200, { results });
});
