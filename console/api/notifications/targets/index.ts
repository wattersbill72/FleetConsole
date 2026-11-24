import { withAuth } from '../../../server/auth.js';
import { tx } from '../../../server/db.js';
import { recordAudit } from '../../../server/audit.js';
import { bodyObject, json, methodNotAllowed } from '../../../server/http.js';

const MAX_TARGETS = 10;
const EMAIL = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;

export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const b = bodyObject(req);
  if (b.channel !== 'email') return json(res, 400, { error: 'Only the email channel is available' });
  const address = typeof b.address === 'string' ? b.address.trim() : '';
  if (!address || address.length > 254 || !EMAIL.test(address)) return json(res, 400, { error: 'Enter a valid email address' });

  const out = await tx(async (q) => {
    const n = await q.query<{ n: string }>('SELECT count(*) AS n FROM notification_targets WHERE org_id = $1', [ctx.orgId]);
    if (parseInt(n.rows[0].n, 10) >= MAX_TARGETS) return { status: 409, error: `At most ${MAX_TARGETS} notification addresses` } as const;
    try {
      const r = await q.query(
        `INSERT INTO notification_targets (org_id, channel, address) VALUES ($1, 'email', $2) RETURNING id, channel, address, enabled, created_at`,
        [ctx.orgId, address],
      );
      await recordAudit(q, {
        orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username, action: 'notification_target.create',
        subjectType: 'notification_target', subjectId: r.rows[0].id, subjectLabel: address, outcome: 'success', detail: { channel: 'email' },
      });
      return { status: 201, target: r.rows[0] } as const;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return { status: 409, error: 'That address is already on the list' } as const;
      throw e;
    }
  });
  if ('error' in out) return json(res, out.status, { error: out.error });
  return json(res, 201, { target: out.target });
});
