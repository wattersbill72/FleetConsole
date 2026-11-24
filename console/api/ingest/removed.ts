import type { VercelRequest, VercelResponse } from '@vercel/node';
import { tx } from '../../server/db.js';
import { recordAudit } from '../../server/audit.js';
import { authenticateNode } from '../../server/ingest.js';
import { json, methodNotAllowed } from '../../server/http.js';

// The agent's confirmation that it has been removed from its machine (local uninstall, or a failed
// install rolling back). The console never reports `removed` without this or an operator's say-so.
// Revokes every credential of the node. A second call finds the credential revoked and gets the same 401.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const node = await authenticateNode(req);
  if (!node) return json(res, 401, { error: 'Unauthorized' });

  await tx(async (q) => {
    const n = (await q.query<{ display_name: string; farm_id: string }>(
      `UPDATE nodes SET status = 'removed', removed_at = now() WHERE id = $1 RETURNING display_name, farm_id`,
      [node.id],
    )).rows[0];
    await q.query('UPDATE node_credentials SET revoked_at = now() WHERE node_id = $1 AND revoked_at IS NULL', [node.id]);
    await recordAudit(q, {
      orgId: node.orgId, actorUserId: null, actorLabel: `node:${n.display_name}`,
      action: 'node.remove', subjectType: 'node', subjectId: node.id, subjectLabel: n.display_name,
      outcome: 'success', detail: { via: 'agent-confirmation', farm_id: n.farm_id },
    });
  });
  return json(res, 200, { ok: true });
}
