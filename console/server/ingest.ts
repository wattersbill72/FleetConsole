import type { VercelRequest } from '@vercel/node';
import { db, tx, type Queryable } from './db.js';
import { sha256 } from './enrol.js';
import { snapshotV1 } from './contracts.generated.js';
import { validate } from './schema.js';

export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const INGEST_LIMIT_PER_MINUTE = 60;   // live (1/min) plus replay headroom; the agent honours Retry-After

export interface IngestNode {
  id: string;
  orgId: string;
  status: string;
  desiredConfigVersion: number;
  lastSeq: number | null;
}

const BEARER = /^Bearer (fcn_[A-Za-z0-9_-]{43})$/;

/** Resolve the node behind a credential. Every failure is the same null: callers must not learn why. */
export async function authenticateNode(req: VercelRequest): Promise<IngestNode | null> {
  const header = req.headers.authorization;
  const m = typeof header === 'string' ? BEARER.exec(header) : null;
  if (!m) return null;
  const r = await db.query<{ id: string; org_id: string; status: string; desired_config_version: number; last_seq: string | null }>(
    `SELECT n.id, n.org_id, n.status, n.desired_config_version, n.last_seq
       FROM node_credentials c JOIN nodes n ON n.id = c.node_id
      WHERE c.hash = $1 AND c.revoked_at IS NULL AND n.status <> 'removed'`,
    [sha256(m[1])],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id, orgId: row.org_id, status: row.status,
    desiredConfigVersion: row.desired_config_version,
    lastSeq: row.last_seq === null ? null : Number(row.last_seq),
  };
}

/** Per-node, per-minute counter. Returns seconds to wait when over the limit, else 0. */
export async function checkRateLimit(nodeId: string): Promise<number> {
  const r = await db.query<{ n: number; wait: number }>(
    `INSERT INTO ingest_rate (node_id, bucket, n)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (node_id, bucket) DO UPDATE SET n = ingest_rate.n + 1
     RETURNING n, ceil(extract(epoch FROM (date_trunc('minute', now()) + interval '1 minute' - now())))::int AS wait`,
    [nodeId],
  );
  const { n, wait } = r.rows[0];
  if (n === 1) {
    await db.query(`DELETE FROM ingest_rate WHERE node_id = $1 AND bucket < now() - interval '1 hour'`, [nodeId]);
  }
  return n > INGEST_LIMIT_PER_MINUTE ? Math.max(1, wait) : 0;
}

export type Body = { ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string };

/** Read and parse a JSON body with a hard size cap. Works with a parsed body (Vercel default) or the raw stream. */
export async function readJsonBody(req: VercelRequest, limit: number): Promise<Body> {
  const declared = parseInt((req.headers['content-length'] as string | undefined) ?? '0', 10);
  if (declared > limit) return { ok: false, status: 413, error: 'Payload too large' };

  if (req.body !== undefined) {
    const size = typeof req.body === 'string' ? Buffer.byteLength(req.body) : Buffer.byteLength(JSON.stringify(req.body) ?? '');
    if (size > limit) return { ok: false, status: 413, error: 'Payload too large' };
    if (typeof req.body !== 'string') return { ok: true, value: req.body };
    try { return { ok: true, value: JSON.parse(req.body) }; } catch { return { ok: false, status: 400, error: 'Body is not valid JSON' }; }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += b.length;
    if (total > limit) return { ok: false, status: 413, error: 'Payload too large' };
    chunks.push(b);
  }
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { ok: false, status: 400, error: 'Body is not valid JSON' }; }
}

export function validateSnapshot(body: unknown): { ok: true } | { ok: false; code?: string; errors: string[] } {
  if (body && typeof body === 'object' && (body as { schema_version?: unknown }).schema_version !== 1) {
    return { ok: false, code: 'unsupported_schema_version', errors: ['schema_version must be 1'] };
  }
  const errors = validate(snapshotV1, body);
  return errors.length ? { ok: false, errors: errors.slice(0, 5) } : { ok: true };
}

export function worstDiskPct(disks: { used_bytes: number; total_bytes: number }[] | undefined): number | null {
  let worst: number | null = null;
  for (const d of disks ?? []) {
    if (d.total_bytes > 0) worst = Math.max(worst ?? 0, (d.used_bytes / d.total_bytes) * 100);
  }
  return worst;
}

// Statuses a live heartbeat may move to `healthy`. decommissioning and removed are never overwritten by telemetry.
const REVIVABLE = ['pending', 'healthy', 'degraded', 'stale', 'expected-offline'];

export interface StoreResult { duplicate: boolean; lastSeq: number }

/** Store one validated Snapshot for an authenticated node. Idempotent on (node, seq). */
export async function storeSnapshot(node: IngestNode, s: any): Promise<StoreResult> {
  const env = s.envelope, host = s.host;
  const { disks, addresses, temperature_c, hostname, os, os_version, load, cpu_pct, mem_used_bytes, mem_total_bytes, uptime_s } = host;
  const detail = {
    host: { hostname, os, os_version, disks: disks ?? [], addresses: addresses ?? [], temperature_c: temperature_c ?? null, load: load ?? null },
    services: s.services ?? [],
    sovereignai: s.sovereignai ?? null,
    error_tail: s.error_tail ?? [],
    agent_health: s.agent_health,
  };
  const worst = worstDiskPct(disks);

  return tx(async (q: Queryable) => {
    // Serialise per node so "latest" and last_seq stay consistent under concurrent requests.
    const cur = (await q.query<{ last_seq: string | null; status: string }>(
      'SELECT last_seq, status FROM nodes WHERE id = $1 FOR UPDATE', [node.id],
    )).rows[0];

    const ins = await q.query<{ id: string }>(
      `INSERT INTO snapshots (node_id, seq, node_time, replayed, config_version, cpu_pct, load1,
                              mem_used_bytes, mem_total_bytes, uptime_s, disk_worst_pct, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (node_id, seq) DO NOTHING RETURNING id`,
      [node.id, env.seq, env.node_time, env.replayed, env.applied_config_version, cpu_pct ?? null, load ? load[0] : null,
       mem_used_bytes ?? null, mem_total_bytes ?? null, uptime_s, worst, JSON.stringify(detail)],
    );
    const inserted = ins.rows.length === 1;
    const prevSeq = cur.last_seq === null ? -1 : Number(cur.last_seq);

    // Any accepted request proves the node is alive.
    await q.query('UPDATE nodes SET last_heartbeat_at = now() WHERE id = $1', [node.id]);

    // Only a new, live, newest-so-far Snapshot changes current state. Replays fill history and nothing else.
    if (inserted && !env.replayed && env.seq > prevSeq) {
      await q.query(
        `UPDATE nodes SET
           status = CASE WHEN status = ANY($2) THEN 'healthy' ELSE status END,
           last_seq = $3, hostname = $4, os_version = $5, agent_version = $6, applied_config_version = $7,
           latest = $8
         WHERE id = $1`,
        [node.id, REVIVABLE, env.seq, hostname, os_version, env.agent_version, env.applied_config_version,
         JSON.stringify({ cpu_pct: cpu_pct ?? null, load: load ?? null, mem_used_bytes: mem_used_bytes ?? null,
                          mem_total_bytes: mem_total_bytes ?? null, disk_worst_pct: worst, uptime_s, node_time: env.node_time })],
      );
    }
    const newest = Math.max(prevSeq, inserted && !env.replayed ? env.seq : prevSeq);
    return { duplicate: !inserted, lastSeq: newest };
  });
}
