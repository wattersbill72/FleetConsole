import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  MAX_SNAPSHOT_BYTES, authenticateNode, checkRateLimit, readJsonBody, storeSnapshot, validateSnapshot,
} from '../../server/ingest.js';
import { json, methodNotAllowed } from '../../server/http.js';

// Public by necessity (ARCH-001 s10). Order matters and is the whole defence:
//   credential -> rate limit -> size-capped body -> schema -> store.
// Every credential failure is the same 401, so an unauthenticated caller learns nothing.

// Read the raw stream ourselves so the size cap applies before a large body is buffered.
export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const node = await authenticateNode(req);
  if (!node) return json(res, 401, { error: 'Unauthorized' });

  const wait = await checkRateLimit(node.id);
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    return json(res, 429, { error: 'Rate limit exceeded', retry_after_s: wait });
  }

  const body = await readJsonBody(req, MAX_SNAPSHOT_BYTES);
  if (!body.ok) return json(res, body.status, { error: body.error });

  const v = validateSnapshot(body.value);
  if (!v.ok) return json(res, 400, { error: 'Snapshot rejected', code: v.code, details: v.errors });

  const snap = body.value as { envelope: { node_id: string } };
  if (snap.envelope.node_id !== node.id) {
    return json(res, 403, { error: 'node_id does not match the credential' });
  }

  const out = await storeSnapshot(node, body.value);
  // The heartbeat response carries what the node must act on (ARCH-001 s8.1). The command queue arrives with US-023.
  return json(res, 200, {
    ok: true,
    duplicate: out.duplicate,
    last_seq: out.lastSeq,
    desired_config_version: node.desiredConfigVersion,
    commands: [],
  });
}
