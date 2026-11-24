import type { VercelRequest, VercelResponse } from '@vercel/node';
import { tx } from '../../server/db.js';
import { finalizeRemoval, type RemovalReport } from '../../server/decommission.js';
import { authenticateNode, readJsonBody } from '../../server/ingest.js';
import { json, methodNotAllowed } from '../../server/http.js';

// The agent's confirmation that it has been removed from its machine (console-requested decommission, local
// uninstall, or a failed install rolling back). The console never reports `removed` without this or an operator's say-so.
// The body may carry the agent's own verification: { verified, residue[] }. A second call finds the credential
// revoked and gets the same 401.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const node = await authenticateNode(req);
  if (!node) return json(res, 401, { error: 'Unauthorized' });

  let report: RemovalReport | undefined;
  const body = await readJsonBody(req, 8192);
  if (body.ok && body.value && typeof body.value === 'object') {
    const b = body.value as { verified?: unknown; residue?: unknown };
    if (typeof b.verified === 'boolean') {
      report = { verified: b.verified, residue: Array.isArray(b.residue) ? b.residue.filter((x) => typeof x === 'string').slice(0, 20).map((x) => (x as string).slice(0, 200)) : [] };
    }
  }

  await tx((q) => finalizeRemoval(q, node.id, 'agent', { userId: null, label: 'node' }, { report }));
  return json(res, 200, { ok: true });
}
