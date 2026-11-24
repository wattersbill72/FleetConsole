import type { VercelRequest, VercelResponse } from '@vercel/node';
import { tx } from '../server/db.js';
import { recordAudit } from '../server/audit.js';
import { MAX_ENROL_BODY_BYTES, buildInitialConfig, newNodeCredential, sha256 } from '../server/enrol.js';
import { bodyObject, json, methodNotAllowed } from '../server/http.js';

// Public endpoint, authenticated by the single-use enrolment token in the body.
// A token that matches nothing gets one generic refusal; only a real (hash-matching) token can learn why it was refused.

const REFUSALS = {
  token_invalid: { status: 401, error: 'This enrolment token is not valid.' },
  token_used: { status: 410, error: 'This enrolment token has already been used. Generate a new one in the console.' },
  token_expired: { status: 410, error: 'This enrolment token has expired. Generate a new one in the console.' },
  token_cancelled: { status: 410, error: 'This enrolment was cancelled in the console. Generate a new one.' },
  platform_mismatch: { status: 409, error: 'This token was issued for a different platform. Generate one for this machine.' },
} as const;
type Refusal = keyof typeof REFUSALS;

const short = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const declared = parseInt((req.headers['content-length'] as string | undefined) ?? '0', 10);
  const b = bodyObject(req);
  if (declared > MAX_ENROL_BODY_BYTES || JSON.stringify(b).length > MAX_ENROL_BODY_BYTES) {
    return json(res, 413, { error: 'Request too large' });
  }
  if (typeof b.token !== 'string' || b.token.length < 8 || b.token.length > 200) {
    return json(res, 401, { code: 'token_invalid', error: REFUSALS.token_invalid.error });
  }
  const os = b.os === 'ubuntu' || b.os === 'macos' ? b.os : null;
  if (!os) return json(res, 400, { error: 'os must be ubuntu or macos' });

  const outcome = await tx(async (q) => {
    const e = (await q.query<{
      id: string; org_id: string; farm_id: string; platform: string; display_name: string | null;
      initial_config: Record<string, unknown>; used_at: string | null; cancelled_at: string | null; expired: boolean;
    }>(
      `SELECT id, org_id, farm_id, platform, display_name, initial_config, used_at, cancelled_at,
              (expires_at <= now()) AS expired
         FROM enrolments WHERE token_hash = $1 FOR UPDATE`,
      [sha256(b.token as string)],
    )).rows[0];

    if (!e) return { ok: false as const, refused: 'token_invalid' as Refusal };
    if (e.used_at) return { ok: false as const, refused: 'token_used' as Refusal };
    if (e.cancelled_at) return { ok: false as const, refused: 'token_cancelled' as Refusal };
    if (e.expired) return { ok: false as const, refused: 'token_expired' as Refusal };
    if (e.platform !== os) return { ok: false as const, refused: 'platform_mismatch' as Refusal };

    const hostname = short(b.hostname, 255);
    const displayName = e.display_name ?? hostname ?? 'unnamed node';
    const node = (await q.query<{ id: string }>(
      `INSERT INTO nodes (org_id, farm_id, display_name, platform, hostname, os_version, agent_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [e.org_id, e.farm_id, displayName, os, hostname, short(b.os_version, 64), short(b.agent_version, 64)],
    )).rows[0];

    const config = buildInitialConfig(e.initial_config, 1);
    await q.query(
      `INSERT INTO node_configs (node_id, version, config, created_by) VALUES ($1, 1, $2, 'enrolment')`,
      [node.id, JSON.stringify(config)],
    );
    const credential = newNodeCredential();
    await q.query('INSERT INTO node_credentials (node_id, hash) VALUES ($1, $2)', [node.id, sha256(credential)]);
    await q.query('UPDATE enrolments SET used_at = now(), node_id = $2 WHERE id = $1', [e.id, node.id]);

    const farm = (await q.query<{ id: string; name: string }>('SELECT id, name FROM farms WHERE id = $1', [e.farm_id])).rows[0];
    await recordAudit(q, {
      orgId: e.org_id, actorUserId: null, actorLabel: 'enrolment',
      action: 'enrolment.use', subjectType: 'node', subjectId: node.id, subjectLabel: displayName,
      outcome: 'success', detail: { enrolment_id: e.id, farm_id: e.farm_id, platform: os },
    });
    return { ok: true as const, node_id: node.id, credential, farm, config };
  });

  if (!outcome.ok) {
    const r = REFUSALS[outcome.refused];
    return json(res, r.status, { code: outcome.refused, error: r.error });
  }
  // The credential appears in this response and nowhere else; only its hash is stored.
  const { ok: _ok, ...body } = outcome;
  return json(res, 201, body);
}
