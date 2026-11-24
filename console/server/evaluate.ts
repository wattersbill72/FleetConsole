import { tx, type Queryable } from './db.js';
import { RULE_FARM_STALE, RULE_NODE_STALE, closeAlert, openAlert } from './alerts.js';

/** A node is stale once it has missed this many consecutive heartbeat intervals. */
export const STALE_AFTER_INTERVALS = 3;
/** Nodes of a farm whose silence began within this many seconds of each other count as one outage. */
export const FARM_OUTAGE_WINDOW_S = 300;

const LOCK_KEY = 60060; // advisory lock so overlapping cron runs cannot double-process

export interface EvaluationResult {
  skipped: boolean;
  nodesStale: number;            // moved to stale in this run
  nodesExpectedOffline: number;  // intermittent nodes moved to expected-offline in this run
  nodeAlertsOpened: number;
  farmAlertsOpened: number;
  alertsClosed: number;
}

interface Row {
  id: string; org_id: string; farm_id: string; display_name: string; status: string;
  farm_name: string; interval_s: number; intermittent: boolean; overdue: boolean;
  last_heartbeat_at: Date;
}

/**
 * Detect silence. Runs in the console on its own clock (the database's), so it works when every node is
 * silent at once: it never depends on an incoming heartbeat. Safe to run repeatedly and concurrently.
 */
export async function evaluateStaleness(): Promise<EvaluationResult> {
  return tx(async (q: Queryable) => {
    const lock = await q.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK_KEY]);
    const res: EvaluationResult = { skipped: false, nodesStale: 0, nodesExpectedOffline: 0, nodeAlertsOpened: 0, farmAlertsOpened: 0, alertsClosed: 0 };
    if (!lock.rows[0].ok) return { ...res, skipped: true };

    // Interval and intermittent flag come from the configuration the node is actually running.
    // FOR UPDATE OF n serialises with ingest, so a node that reports at this instant cannot be marked stale.
    const nodes = (await q.query<Row>(
      `SELECT n.id, n.org_id, n.farm_id, n.display_name, n.status, f.name AS farm_name,
              COALESCE((c.config->>'heartbeat_interval_s')::int, 60) AS interval_s,
              COALESCE((c.config->>'intermittent')::boolean, false) AS intermittent,
              n.last_heartbeat_at,
              (now() - n.last_heartbeat_at >= make_interval(secs => $1 * COALESCE((c.config->>'heartbeat_interval_s')::int, 60))) AS overdue
         FROM nodes n
         JOIN farms f ON f.id = n.farm_id
         LEFT JOIN node_configs c ON c.node_id = n.id AND c.version = COALESCE(n.applied_config_version, n.desired_config_version)
        WHERE n.status IN ('healthy', 'degraded', 'stale') AND n.last_heartbeat_at IS NOT NULL
        FOR UPDATE OF n`,
      [STALE_AFTER_INTERVALS],
    )).rows;

    // 1. Status. Intermittent nodes go to expected-offline and are then left alone.
    for (const n of nodes) {
      if (!n.overdue || n.status === 'stale') continue;
      const to = n.intermittent ? 'expected-offline' : 'stale';
      await q.query('UPDATE nodes SET status = $2 WHERE id = $1', [n.id, to]);
      if (to === 'stale') { n.status = 'stale'; res.nodesStale++; } else { n.status = 'expected-offline'; res.nodesExpectedOffline++; }
    }

    // 2. Which farms are down as a whole: at least two nodes that are expected to report, all of them
    //    silent, and their silence began within a short window of each other.
    const byFarm = new Map<string, Row[]>();
    for (const n of nodes) {
      if (n.intermittent) continue;
      (byFarm.get(n.farm_id) ?? byFarm.set(n.farm_id, []).get(n.farm_id)!).push(n);
    }
    const farmDown = new Set<string>();
    for (const [farmId, members] of byFarm) {
      if (members.length < 2 || !members.every((m) => m.status === 'stale')) continue;
      const times = members.map((m) => m.last_heartbeat_at.getTime());
      if ((Math.max(...times) - Math.min(...times)) / 1000 <= FARM_OUTAGE_WINDOW_S) farmDown.add(farmId);
    }

    // 3. Alerts. One farm alert in place of one per node; node alerts for everything else that is stale.
    for (const [farmId, members] of byFarm) {
      if (farmDown.has(farmId)) {
        const first = members[0];
        const opened = await openAlert(q, {
          orgId: first.org_id, rule: RULE_FARM_STALE, subjectType: 'farm', subjectId: farmId, subjectLabel: first.farm_name,
          farmId, silentSince: new Date(Math.max(...members.map((m) => m.last_heartbeat_at.getTime()))).toISOString(),
          detail: { nodes: members.map((m) => ({ id: m.id, name: m.display_name })), threshold_intervals: STALE_AFTER_INTERVALS },
        });
        if (opened) res.farmAlertsOpened++;
      } else if (await closeAlert(q, RULE_FARM_STALE, farmId, 'condition cleared')) {
        res.alertsClosed++;
      }
    }
    for (const n of nodes) {
      if (n.intermittent) continue;
      const suppressed = farmDown.has(n.farm_id);
      if (n.status === 'stale' && !suppressed) {
        const opened = await openAlert(q, {
          orgId: n.org_id, rule: RULE_NODE_STALE, subjectType: 'node', subjectId: n.id, subjectLabel: n.display_name,
          farmId: n.farm_id, silentSince: n.last_heartbeat_at.toISOString(),
          detail: { farm: n.farm_name, interval_s: n.interval_s, threshold_s: STALE_AFTER_INTERVALS * n.interval_s },
        });
        if (opened) res.nodeAlertsOpened++;
      }
    }

    // 4. Farms with no remaining stale-capable members (all removed, say) must not keep a farm alert open,
    //    and alerts whose node is no longer stale (removed, decommissioning, intermittent) are closed.
    const open = (await q.query<{ rule: string; subject_id: string }>(
      `SELECT a.rule, a.subject_id FROM alerts a WHERE a.closed_at IS NULL AND a.rule IN ('node_stale', 'farm_stale')`,
    )).rows;
    const staleNodeIds = new Set(nodes.filter((n) => n.status === 'stale').map((n) => n.id));
    for (const a of open) {
      if (a.rule === RULE_NODE_STALE && !staleNodeIds.has(a.subject_id)) {
        if (await closeAlert(q, RULE_NODE_STALE, a.subject_id, 'node no longer stale')) res.alertsClosed++;
      }
      if (a.rule === RULE_FARM_STALE && !farmDown.has(a.subject_id)) {
        if (await closeAlert(q, RULE_FARM_STALE, a.subject_id, 'condition cleared')) res.alertsClosed++;
      }
    }
    return res;
  });
}
