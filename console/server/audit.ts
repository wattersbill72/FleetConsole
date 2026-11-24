import type { Queryable } from './db.js';

export interface AuditInput {
  orgId: string | null;
  actorUserId: string | null;
  /** Human-readable actor; for a failed sign-in with an unknown user this is just 'unknown'. */
  actorLabel: string;
  action: string;
  subjectType?: string;
  subjectId?: string;
  subjectLabel?: string;
  outcome: 'success' | 'failure';
  /** Must never carry secrets, credentials, or log content. */
  detail?: Record<string, unknown>;
}

/** The single entry point for audit events. Pass the caller's transaction so the event commits with the change. */
export async function recordAudit(q: Queryable, e: AuditInput): Promise<void> {
  await q.query(
    `INSERT INTO audit_events
       (org_id, actor_user_id, actor_label, action, subject_type, subject_id, subject_label, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.orgId,
      e.actorUserId,
      e.actorLabel,
      e.action,
      e.subjectType ?? null,
      e.subjectId ?? null,
      e.subjectLabel ?? null,
      e.outcome,
      JSON.stringify(e.detail ?? {}),
    ],
  );
}
