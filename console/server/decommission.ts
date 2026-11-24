import { db, tx, type Queryable } from './db.js';
import { recordAudit } from './audit.js';
import { RULE_NODE_STALE, closeAlert, openAlert } from './alerts.js';

/** How long the agent has to confirm its own removal before the console gives up waiting. */
export const DECOMMISSION_TIMEOUT_MINUTES = 15;
export const RULE_REMOVAL_UNCONFIRMED = 'removal_unconfirmed';

export interface RemovalReport { verified: boolean; residue: string[] }

interface NodeRef { id: string; org_id: string; display_name: string; farm_id: string; status: string; decommission_purge: boolean }

/**
 * End a node's life in the console: status `removed`, every credential revoked, live commands settled,
 * its alerts closed, history purged if that was the operator's choice, and one audit event.
 * Used by the agent's confirmation and by the operator's "mark removed". Idempotent: a removed node is left alone.
 */
export async function finalizeRemoval(
  q: Queryable, nodeId: string, via: 'agent' | 'operator',
  actor: { userId: string | null; label: string }, opts: { purge?: boolean; report?: RemovalReport } = {},
): Promise<boolean> {
  const n = (await q.query<NodeRef>(
    `SELECT id, org_id, display_name, farm_id, status, decommission_purge FROM nodes WHERE id = $1 FOR UPDATE`, [nodeId])).rows[0];
  if (!n || n.status === 'removed') return false;
  const purge = opts.purge ?? (n.status === 'decommissioning' && n.decommission_purge);

  await q.query(
    `UPDATE nodes SET status = 'removed', removed_at = now(), removed_via = $2, removal_report = $3 WHERE id = $1`,
    [nodeId, via, opts.report ? JSON.stringify(opts.report) : null],
  );
  await q.query('UPDATE node_credentials SET revoked_at = now() WHERE node_id = $1 AND revoked_at IS NULL', [nodeId]);
  // The agent's confirmation fulfils a decommission; an operator override cancels whatever was waiting.
  await q.query(
    `UPDATE node_commands SET status = CASE WHEN $2 = 'agent' AND command = 'decommission' THEN 'confirmed' ELSE 'cancelled' END, finished_at = now()
      WHERE node_id = $1 AND status IN ('queued', 'delivered')`,
    [nodeId, via],
  );
  await closeAlert(q, RULE_NODE_STALE, nodeId, 'node removed');
  await closeAlert(q, RULE_REMOVAL_UNCONFIRMED, nodeId, 'node removed');

  if (purge) {
    // History goes; the node's name, the alerts and the audit trail stay (US-025, US-071).
    await q.query('DELETE FROM snapshots WHERE node_id = $1', [nodeId]);
    await q.query('DELETE FROM ingest_rate WHERE node_id = $1', [nodeId]);
    await q.query('DELETE FROM node_configs WHERE node_id = $1', [nodeId]);
    await q.query('UPDATE nodes SET latest = NULL, hostname = NULL, os_version = NULL, last_seq = NULL WHERE id = $1', [nodeId]);
  }
  await recordAudit(q, {
    orgId: n.org_id, actorUserId: actor.userId, actorLabel: actor.label,
    action: 'node.remove', subjectType: 'node', subjectId: nodeId, subjectLabel: n.display_name,
    outcome: 'success',
    detail: {
      via: via === 'agent' ? 'agent-confirmation' : 'operator', farm_id: n.farm_id, history: purge ? 'purged' : 'kept',
      ...(opts.report ? { verified: opts.report.verified, residue: opts.report.residue } : {}),
    },
  });
  return true;
}

/** Queue the decommission command and move the node to `decommissioning`. Safe to repeat. */
export async function requestDecommission(
  q: Queryable, orgId: string, nodeId: string, actor: { userId: string; label: string }, purge: boolean,
): Promise<{ ok: true; alreadyRequested: boolean } | { ok: false; reason: 'not_found' | 'removed' | 'unconfirmed' }> {
  const n = (await q.query<NodeRef & { decommission_unconfirmed_at: string | null }>(
    `SELECT id, org_id, display_name, farm_id, status, decommission_purge, decommission_unconfirmed_at
       FROM nodes WHERE id = $1 AND org_id = $2 FOR UPDATE`, [nodeId, orgId])).rows[0];
  if (!n) return { ok: false, reason: 'not_found' };
  if (n.status === 'removed') return { ok: false, reason: 'removed' };
  // The console gave up and revoked the credential: the agent can no longer be reached, so asking again is pointless.
  if (n.decommission_unconfirmed_at) return { ok: false, reason: 'unconfirmed' };

  const live = (await q.query(`SELECT 1 FROM node_commands WHERE node_id = $1 AND command = 'decommission' AND status IN ('queued','delivered')`, [nodeId])).rows.length > 0;
  const retry = n.status === 'decommissioning' && !live;     // the agent reported it could not do it: ask again, restart the clock
  const already = n.status === 'decommissioning' && live;

  if (!already) {
    await q.query(
      `UPDATE nodes SET status = 'decommissioning', decommission_requested_at = now(), decommission_purge = $2, decommission_unconfirmed_at = NULL WHERE id = $1`,
      [nodeId, purge],
    );
    await q.query(`INSERT INTO node_commands (node_id, command, created_by) VALUES ($1, 'decommission', $2)`, [nodeId, actor.userId]);
    await recordAudit(q, {
      orgId, actorUserId: actor.userId, actorLabel: actor.label, action: 'node.decommission.request',
      subjectType: 'node', subjectId: nodeId, subjectLabel: n.display_name, outcome: 'success',
      detail: { farm_id: n.farm_id, history: purge ? 'purge' : 'keep', retry },
    });
  }
  return { ok: true, alreadyRequested: already };
}

/**
 * Give up on nodes that did not confirm in time: revoke the credential anyway, settle the command, and open an
 * alert so the operator is told, by the same route as every other alert, to run the local uninstall.
 * The node stays `decommissioning`: the console never says `removed` without the agent's confirmation or the operator's word.
 */
export async function expireDecommissions(): Promise<number> {
  return tx(async (q) => {
    const lock = await q.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(60061) AS ok');
    if (!lock.rows[0].ok) return 0;
    const due = (await q.query<{ id: string; org_id: string; display_name: string; farm_id: string }>(
      `UPDATE nodes SET decommission_unconfirmed_at = now()
        WHERE status = 'decommissioning' AND decommission_unconfirmed_at IS NULL
          AND decommission_requested_at < now() - make_interval(mins => $1)
        RETURNING id, org_id, display_name, farm_id`, [DECOMMISSION_TIMEOUT_MINUTES])).rows;
    for (const n of due) {
      await q.query('UPDATE node_credentials SET revoked_at = now() WHERE node_id = $1 AND revoked_at IS NULL', [n.id]);
      await q.query(
        `UPDATE node_commands SET status = 'expired', finished_at = now() WHERE node_id = $1 AND status IN ('queued', 'delivered')`, [n.id]);
      await recordAudit(q, {
        orgId: n.org_id, actorUserId: null, actorLabel: 'console', action: 'node.decommission.timeout',
        subjectType: 'node', subjectId: n.id, subjectLabel: n.display_name, outcome: 'failure',
        detail: { farm_id: n.farm_id, minutes: DECOMMISSION_TIMEOUT_MINUTES, credential: 'revoked' },
      });
      await openAlert(q, {
        orgId: n.org_id, rule: RULE_REMOVAL_UNCONFIRMED, subjectType: 'node', subjectId: n.id, subjectLabel: n.display_name,
        farmId: n.farm_id, silentSince: null, detail: { minutes: DECOMMISSION_TIMEOUT_MINUTES },
      });
    }
    return due.length;
  });
}

/** Commands to hand to a node in a heartbeat response, marking them delivered. Re-sent until the node settles them. */
export async function takeCommands(q: Queryable, nodeId: string): Promise<{ id: string; command: string; issued_at: string }[]> {
  const r = await q.query<{ id: string; command: string; created_at: Date }>(
    `UPDATE node_commands SET status = 'delivered', delivered_at = COALESCE(delivered_at, now())
      WHERE node_id = $1 AND status IN ('queued', 'delivered') RETURNING id, command, created_at`, [nodeId]);
  return r.rows.sort((a, b) => Number(a.id) - Number(b.id)).map((c) => ({ id: c.id, command: c.command, issued_at: c.created_at.toISOString() }));
}

/** The agent reported it could not carry out a command: record why, so the operator can see it. */
export async function recordCommandFailure(q: Queryable, nodeId: string, command: string, reason: string | null): Promise<void> {
  await q.query(
    `UPDATE node_commands SET status = 'failed', finished_at = now(), result = $3
      WHERE node_id = $1 AND command = $2 AND status IN ('queued', 'delivered')`, [nodeId, command, (reason ?? 'no reason given').slice(0, 500)]);
}

export { db };
