import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authenticateNode, checkRateLimit } from '../../server/ingest.js';
import { json, methodNotAllowed } from '../../server/http.js';

// Lets `fleetagent test` check a credential without storing anything.
// Same rule as the rest of ingest: every credential failure is one identical 401.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const node = await authenticateNode(req);
  if (!node) return json(res, 401, { error: 'Unauthorized' });
  const wait = await checkRateLimit(node.id);
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    return json(res, 429, { error: 'Rate limit exceeded', retry_after_s: wait });
  }
  return json(res, 200, { ok: true, desired_config_version: node.desiredConfigVersion });
}
