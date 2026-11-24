import type { VercelRequest } from '@vercel/node';
import { withAuth } from '../../../../server/auth.js';
import { db, tx } from '../../../../server/db.js';
import { recordAudit } from '../../../../server/audit.js';
import {
  ENROLMENT_TTL_MINUTES, MAX_OUTSTANDING_PER_FARM, consoleOrigin, installCommand,
  newEnrolmentToken, parseEnrolmentInput, sha256,
} from '../../../../server/enrol.js';
import { bodyObject, json, methodNotAllowed, UUID_RE } from '../../../../server/http.js';

const farmId = (req: VercelRequest) => (Array.isArray(req.query.id) ? req.query.id[0] : req.query.id);

export default withAuth(async (req, res, ctx) => {
  const id = farmId(req);
  if (!id || !UUID_RE.test(id)) return json(res, 404, { error: 'Farm not found' });
  const farm = (await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM farms WHERE id = $1 AND org_id = $2', [id, ctx.orgId],
  )).rows[0];
  if (!farm) return json(res, 404, { error: 'Farm not found' });

  if (req.method === 'GET') {
    // Outstanding = unused, uncancelled, unexpired. The token itself is never returned: only its hash exists.
    const r = await db.query(
      `SELECT id, platform, display_name, initial_config, created_at, expires_at
         FROM enrolments
        WHERE farm_id = $1 AND org_id = $2 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [farm.id, ctx.orgId],
    );
    return json(res, 200, { enrolments: r.rows });
  }

  if (req.method === 'POST') {
    const parsed = parseEnrolmentInput(bodyObject(req));
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    const input = parsed.value;

    const token = newEnrolmentToken();
    const result = await tx(async (q) => {
      // Serialise per farm so the outstanding cap cannot be raced past.
      await q.query('SELECT id FROM farms WHERE id = $1 FOR UPDATE', [farm.id]);
      const open = await q.query<{ n: string }>(
        `SELECT count(*) AS n FROM enrolments
          WHERE farm_id = $1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > now()`,
        [farm.id],
      );
      if (parseInt(open.rows[0].n, 10) >= MAX_OUTSTANDING_PER_FARM) return null;

      const ins = await q.query(
        `INSERT INTO enrolments (org_id, farm_id, token_hash, platform, display_name, initial_config, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))
         RETURNING id, platform, display_name, initial_config, created_at, expires_at`,
        [ctx.orgId, farm.id, sha256(token), input.platform, input.displayName, JSON.stringify(input.initialConfig), ctx.userId, ENROLMENT_TTL_MINUTES],
      );
      const row = ins.rows[0];
      await recordAudit(q, {
        orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username,
        action: 'enrolment.issue', subjectType: 'enrolment', subjectId: row.id, subjectLabel: input.displayName ?? farm.name,
        outcome: 'success',
        detail: { farm_id: farm.id, platform: input.platform, display_name: input.displayName, expires_at: row.expires_at },
      });
      return row;
    });
    if (!result) {
      return json(res, 409, { error: `This farm already has ${MAX_OUTSTANDING_PER_FARM} outstanding enrolments. Cancel some first.` });
    }
    // The only time the token exists in plaintext outside the operator's clipboard.
    return json(res, 201, { enrolment: result, token, command: installCommand(consoleOrigin(req), token) });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});
