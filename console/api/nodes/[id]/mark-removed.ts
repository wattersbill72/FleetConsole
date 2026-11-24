import { withAuth } from '../../../server/auth.js';
import { db, tx } from '../../../server/db.js';
import { finalizeRemoval } from '../../../server/decommission.js';
import { bodyObject, json, methodNotAllowed, UUID_RE } from '../../../server/http.js';

// The operator's word that a node is gone: its machine was wiped, or the local uninstall was run, or the agent
// never confirmed. Revokes its credentials and ends its life in the console. The same confirmation as remove.
export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id || !UUID_RE.test(id)) return json(res, 404, { error: 'Node not found' });
  const b = bodyObject(req);
  if (b.history !== 'keep' && b.history !== 'purge') return json(res, 400, { error: 'Choose whether to keep or purge the node\'s history' });

  const node = (await db.query<{ display_name: string; status: string }>('SELECT display_name, status FROM nodes WHERE id = $1 AND org_id = $2', [id, ctx.orgId])).rows[0];
  if (!node) return json(res, 404, { error: 'Node not found' });
  if (node.status === 'removed') return json(res, 409, { error: 'This node is already removed' });
  if (typeof b.confirm_name !== 'string' || b.confirm_name.trim() !== node.display_name) {
    return json(res, 400, { error: 'Type the node\'s name exactly to confirm' });
  }

  await tx((q) => finalizeRemoval(q, id, 'operator', { userId: ctx.userId, label: ctx.username }, { purge: b.history === 'purge' }));
  return json(res, 200, { ok: true });
});
