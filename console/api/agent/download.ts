import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../../server/db.js';
import { sha256 } from '../../server/enrol.js';
import { DOWNLOADABLE, releaseConfig, resolveAgentFile } from '../../server/github.js';
import { json, methodNotAllowed } from '../../server/http.js';

// Hands an enrolling machine the agent binary. Authenticated by a valid, unused enrolment token, which
// is NOT consumed here (the install still has to enrol with it). The binary itself is not proxied: the
// node is redirected to a short-lived signed URL, so no size limit applies and the console's GitHub
// token never leaves the console.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const m = /^Bearer (fce_[A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization ?? ''));
  const valid = m && (await db.query(
    `SELECT 1 FROM enrolments
      WHERE token_hash = $1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > now()`,
    [sha256(m[1])],
  )).rows.length === 1;
  if (!valid) return json(res, 401, { error: 'Unauthorized' });   // one answer for every failure

  const file = Array.isArray(req.query.file) ? req.query.file[0] : req.query.file;
  if (!file || !DOWNLOADABLE.test(file)) return json(res, 404, { error: 'No such file' });

  const cfg = releaseConfig();
  if (!cfg) return json(res, 503, { error: 'Agent downloads are not configured on this console' });

  const r = await resolveAgentFile(cfg, file);
  if (!r.ok) {
    const msg = r.reason === 'upstream' ? 'The release store is unavailable. Try again shortly.' : 'No agent release has been published yet';
    return json(res, r.reason === 'upstream' ? 502 : 404, { error: msg });
  }
  res.setHeader('Location', r.location);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(302).end();
}
