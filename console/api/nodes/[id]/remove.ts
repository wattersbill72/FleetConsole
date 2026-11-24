import { withAuth } from '../../../server/auth.js';
import { db, tx } from '../../../server/db.js';
import { requestDecommission } from '../../../server/decommission.js';
import { bodyObject, json, methodNotAllowed, UUID_RE } from '../../../server/http.js';

// Remove a node from the console and have its agent uninstall itself. The operator must type the node's name.
// The node becomes `decommissioning`; it is `removed` only when the agent confirms (or the operator marks it removed).
export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id || !UUID_RE.test(id)) return json(res, 404, { error: 'Node not found' });
  const b = bodyObject(req);
  if (b.history !== 'keep' && b.history !== 'purge') return json(res, 400, { error: 'Choose whether to keep or purge the node\'s history' });

  const node = (await db.query<{ display_name: string }>('SELECT display_name FROM nodes WHERE id = $1 AND org_id = $2', [id, ctx.orgId])).rows[0];
  if (!node) return json(res, 404, { error: 'Node not found' });
  if (typeof b.confirm_name !== 'string' || b.confirm_name.trim() !== node.display_name) {
    return json(res, 400, { error: 'Type the node\'s name exactly to confirm' });
  }

  const r = await tx((q) => requestDecommission(q, ctx.orgId, id, { userId: ctx.userId, label: ctx.username }, b.history === 'purge'));
  if (!r.ok) {
    if (r.reason === 'removed') return json(res, 409, { error: 'This node is already removed' });
    if (r.reason === 'unconfirmed') {
      return json(res, 409, { error: 'The agent did not confirm in time and its credential is revoked. Run "sudo fleetagent uninstall" on the machine, then mark the node removed here.' });
    }
    return json(res, 404, { error: 'Node not found' });
  }
  return json(res, 202, { ok: true, status: 'decommissioning', already_requested: r.alreadyRequested });
});
