import { db } from './db.js';
import { STALE_AFTER_INTERVALS } from './evaluate.js';

export type NodeStatus = 'pending' | 'healthy' | 'degraded' | 'stale' | 'expected-offline' | 'decommissioning';

// Most urgent first. "Not healthy" sorts ahead of healthy; stale is the one that needs a person.
const SEVERITY: Record<NodeStatus, number> = { stale: 0, degraded: 1, decommissioning: 2, pending: 3, 'expected-offline': 4, healthy: 5 };
export const severity = (s: NodeStatus) => SEVERITY[s] ?? 9;

export interface OverviewNode {
  id: string; display_name: string; platform: string; status: NodeStatus; stored_status: string;
  hostname: string | null; agent_version: string | null; intermittent: boolean;
  last_heartbeat_at: string | null; age_s: number | null;
  cpu_pct: number | null; mem_pct: number | null; mem_used_bytes: number | null; mem_total_bytes: number | null; disk_worst_pct: number | null;
}

/**
 * Everything the overview screen needs, in two queries, scoped to one organisation.
 *
 * The status shown is computed here from the database clock, with the same rule the evaluator uses, so the
 * overview is right even if the evaluator has not run yet (or is not running): with the whole home site
 * offline, every node shows as stale with its true last-seen time.
 */
export async function buildOverview(orgId: string) {
  const [nodes, farms, alerts] = await Promise.all([
    db.query<any>(
      `SELECT n.id, n.farm_id, n.display_name, n.platform, n.status, n.hostname, n.agent_version, n.last_heartbeat_at, n.latest,
              COALESCE((c.config->>'intermittent')::boolean, false) AS intermittent,
              extract(epoch FROM now() - n.last_heartbeat_at)::int AS age_s,
              (n.last_heartbeat_at IS NOT NULL AND now() - n.last_heartbeat_at >=
                 make_interval(secs => $2 * COALESCE((c.config->>'heartbeat_interval_s')::int, 60))) AS overdue
         FROM nodes n
         LEFT JOIN node_configs c ON c.node_id = n.id AND c.version = COALESCE(n.applied_config_version, n.desired_config_version)
        WHERE n.org_id = $1 AND n.status <> 'removed'`,
      [orgId, STALE_AFTER_INTERVALS],
    ),
    db.query<any>('SELECT id, name, time_zone FROM farms WHERE org_id = $1', [orgId]),
    db.query<any>(
      `SELECT a.id, a.rule, a.subject_label, a.opened_at, f.name AS farm_name,
              count(*) OVER () AS total
         FROM alerts a LEFT JOIN farms f ON f.id = a.farm_id
        WHERE a.org_id = $1 AND a.closed_at IS NULL
        ORDER BY a.opened_at DESC LIMIT 5`,
      [orgId],
    ),
  ]);
  const serverTime = (await db.query<{ now: Date }>('SELECT now()')).rows[0].now.toISOString();

  const byFarm = new Map<string, OverviewNode[]>();
  for (const r of nodes.rows) {
    let status = r.status as NodeStatus;
    if ((status === 'healthy' || status === 'degraded') && r.overdue) status = r.intermittent ? 'expected-offline' : 'stale';
    const l = r.latest ?? {};
    const pct = (used: number | null, total: number | null) => (used != null && total ? Math.round((used / total) * 1000) / 10 : null);
    const node: OverviewNode = {
      id: r.id, display_name: r.display_name, platform: r.platform, status, stored_status: r.status,
      hostname: r.hostname, agent_version: r.agent_version, intermittent: r.intermittent,
      last_heartbeat_at: r.last_heartbeat_at ? new Date(r.last_heartbeat_at).toISOString() : null, age_s: r.age_s,
      cpu_pct: l.cpu_pct ?? null, mem_used_bytes: l.mem_used_bytes ?? null, mem_total_bytes: l.mem_total_bytes ?? null,
      mem_pct: pct(l.mem_used_bytes ?? null, l.mem_total_bytes ?? null), disk_worst_pct: l.disk_worst_pct ?? null,
    };
    (byFarm.get(r.farm_id) ?? byFarm.set(r.farm_id, []).get(r.farm_id)!).push(node);
  }
  for (const list of byFarm.values()) {
    list.sort((a, b) => severity(a.status) - severity(b.status) || a.display_name.localeCompare(b.display_name));
  }

  const farmList = farms.rows.map((f: any) => {
    const list = byFarm.get(f.id) ?? [];
    return { id: f.id, name: f.name, time_zone: f.time_zone, nodes: list, healthy: list.filter((n) => n.status === 'healthy').length };
  });
  // Farms with the most urgent node first, then by name. An empty farm has nothing urgent.
  const worst = (f: { nodes: OverviewNode[] }) => (f.nodes.length ? Math.min(...f.nodes.map((n) => severity(n.status))) : 9);
  farmList.sort((a, b) => worst(a) - worst(b) || a.name.localeCompare(b.name));

  const all = farmList.flatMap((f) => f.nodes);
  const count = (s: NodeStatus) => all.filter((n) => n.status === s).length;
  const openAlerts = alerts.rows.length ? parseInt(alerts.rows[0].total, 10) : 0;
  const needsAttention = count('stale') + count('degraded');

  return {
    server_time: serverTime,
    summary: {
      nodes_total: all.length, healthy: count('healthy'), stale: count('stale'), degraded: count('degraded'),
      pending: count('pending'), expected_offline: count('expected-offline'), decommissioning: count('decommissioning'),
      needs_attention: needsAttention, open_alerts: openAlerts,
      all_clear: needsAttention === 0 && openAlerts === 0,
    },
    alerts: alerts.rows.map((a: any) => ({ id: a.id, rule: a.rule, subject_label: a.subject_label, farm_name: a.farm_name, opened_at: new Date(a.opened_at).toISOString() })),
    farms: farmList,
  };
}
