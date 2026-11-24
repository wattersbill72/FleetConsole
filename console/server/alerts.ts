import type { Queryable } from './db.js';

export interface OpenAlert {
  orgId: string;
  rule: string;
  subjectType: 'node' | 'farm';
  subjectId: string;
  subjectLabel: string;
  farmId: string;
  silentSince: string | null;
  detail: Record<string, unknown>;
}

/** Open an alert unless one is already open for this rule and subject. Returns true if it opened. */
export async function openAlert(q: Queryable, a: OpenAlert): Promise<boolean> {
  const r = await q.query<{ id: string }>(
    `INSERT INTO alerts (org_id, rule, subject_type, subject_id, subject_label, farm_id, silent_since, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (rule, subject_id) WHERE closed_at IS NULL DO NOTHING
     RETURNING id`,
    [a.orgId, a.rule, a.subjectType, a.subjectId, a.subjectLabel, a.farmId, a.silentSince, JSON.stringify(a.detail)],
  );
  if (!r.rows[0]) return false;
  await q.query(`INSERT INTO alert_events (alert_id, event) VALUES ($1, 'open')`, [r.rows[0].id]);
  return true;
}

/** Close the open alert for this rule and subject, recording how long it lasted. Returns true if one closed. */
export async function closeAlert(q: Queryable, rule: string, subjectId: string, reason: string): Promise<boolean> {
  const r = await q.query<{ id: string }>(
    `UPDATE alerts SET
       closed_at = now(),
       duration_s = GREATEST(0, extract(epoch FROM now() - opened_at))::int,
       outage_s = CASE WHEN silent_since IS NULL THEN NULL ELSE GREATEST(0, extract(epoch FROM now() - silent_since))::int END,
       close_reason = $3
     WHERE rule = $1 AND subject_id = $2 AND closed_at IS NULL
     RETURNING id`,
    [rule, subjectId, reason],
  );
  if (!r.rows[0]) return false;
  await q.query(`INSERT INTO alert_events (alert_id, event) VALUES ($1, 'close')`, [r.rows[0].id]);
  return true;
}

export const RULE_NODE_STALE = 'node_stale';
export const RULE_FARM_STALE = 'farm_stale';
