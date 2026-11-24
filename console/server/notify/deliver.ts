import { db, type Queryable } from './../db.js';
import { getChannel, SendError } from './channels.js';
import './ses.js';
import { renderAlert, renderTest, type AlertView } from './render.js';

// Backoff after the 1st, 2nd, ... failed attempt, in minutes. After the last, the notification is `failed`
// and stays visible in the console. A claim also leases the row for 2 minutes, so a crashed run retries.
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const LEASE_MINUTES = 2;

export interface DeliveryResult { sent: number; retrying: number; failed: number }

interface Claimed {
  id: string; org_id: string; alert_event_id: string | null; kind: 'alert_open' | 'alert_close' | 'test';
  channel: string; recipient: string; attempts: number;
}

/** Enqueue one notification per enabled target for an alert transition, or a visible 'skipped' row if there are none. */
export async function enqueueAlertEvent(q: Queryable, orgId: string, alertEventId: string, event: 'open' | 'close'): Promise<void> {
  const kind = event === 'open' ? 'alert_open' : 'alert_close';
  const ins = await q.query(
    `INSERT INTO notifications (org_id, alert_event_id, kind, channel, recipient)
     SELECT org_id, $2, $3, channel, address FROM notification_targets WHERE org_id = $1 AND enabled
     ON CONFLICT DO NOTHING`,
    [orgId, alertEventId, kind],
  );
  if (ins.rowCount === 0) {
    await q.query(
      `INSERT INTO notifications (org_id, alert_event_id, kind, channel, recipient, status, last_error)
       VALUES ($1, $2, $3, 'none', '', 'skipped', 'No notification target is configured')
       ON CONFLICT DO NOTHING`,
      [orgId, alertEventId, kind],
    );
  }
}

/** Send what is due. Safe to run concurrently: rows are claimed with SKIP LOCKED. */
export async function deliverDue(limit = 10): Promise<DeliveryResult> {
  const claimed = (await db.query<Claimed>(
    `UPDATE notifications SET attempts = attempts + 1, next_attempt_at = now() + make_interval(mins => $2)
      WHERE id IN (SELECT id FROM notifications WHERE status = 'pending' AND next_attempt_at <= now()
                    ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, org_id, alert_event_id, kind, channel, recipient, attempts`,
    [limit, LEASE_MINUTES],
  )).rows.sort((a, b) => Number(a.id) - Number(b.id));

  const out: DeliveryResult = { sent: 0, retrying: 0, failed: 0 };
  for (const n of claimed) {
    const r = await sendOne(n);
    if (r === 'sent') out.sent++; else if (r === 'retry') out.retrying++; else if (r === 'failed') out.failed++;
  }
  return out;
}

export async function sendOne(n: Claimed): Promise<'sent' | 'retry' | 'failed' | 'skipped'> {
  try {
    // An address removed while its notification waited must not be written to.
    if (n.kind !== 'test') {
      const still = await db.query(
        'SELECT 1 FROM notification_targets WHERE org_id = $1 AND channel = $2 AND lower(address) = lower($3) AND enabled',
        [n.org_id, n.channel, n.recipient],
      );
      if (still.rows.length === 0) {
        await db.query(`UPDATE notifications SET status = 'skipped', last_error = 'The address was removed before this was sent' WHERE id = $1`, [n.id]);
        return 'skipped';
      }
    }
    const channel = getChannel(n.channel);
    if (!channel) throw new SendError(`Unknown channel "${n.channel}"`, false);
    const message = await buildMessage(n);
    if (!channel.configured()) throw new SendError(`The ${n.channel} channel is not configured`, true);
    const res = await channel.send({ to: n.recipient, ...message });
    await db.query(`UPDATE notifications SET status = 'sent', sent_at = now(), provider_id = $2, last_error = NULL WHERE id = $1`, [n.id, res.id ?? null]);
    return 'sent';
  } catch (e) {
    const retryable = e instanceof SendError ? e.retryable : true;
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    if (retryable && n.attempts < MAX_ATTEMPTS) {
      await db.query(
        `UPDATE notifications SET last_error = $2, next_attempt_at = now() + make_interval(mins => $3) WHERE id = $1`,
        [n.id, msg, BACKOFF_MINUTES[n.attempts - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]],
      );
      return 'retry';
    }
    await db.query(`UPDATE notifications SET status = 'failed', last_error = $2 WHERE id = $1`, [n.id, msg]);
    return 'failed';
  }
}

async function buildMessage(n: Claimed): Promise<{ subject: string; text: string; html: string }> {
  const org = (await db.query<{ product_name: string }>('SELECT product_name FROM organisations WHERE id = $1', [n.org_id])).rows[0];
  const product = org?.product_name ?? 'Fleet Console';
  if (n.kind === 'test') return renderTest(product);

  const a = (await db.query<AlertView & { alert_id: string }>(
    `SELECT a.id, a.id AS alert_id, a.rule, a.subject_label, f.name AS farm_name, f.time_zone AS farm_time_zone,
            a.opened_at, a.silent_since, a.closed_at, a.duration_s, a.outage_s, a.detail
       FROM alert_events e JOIN alerts a ON a.id = e.alert_id LEFT JOIN farms f ON f.id = a.farm_id
      WHERE e.id = $1`,
    [n.alert_event_id],
  )).rows[0];
  if (!a) throw new SendError('The alert for this notification no longer exists', false);
  const origin = process.env.CONSOLE_URL?.replace(/\/+$/, '');
  return renderAlert({ productName: product, kind: n.kind as 'alert_open' | 'alert_close', alert: a, link: origin ? `${origin}/#alerts/${a.id}` : null });
}

/** Send a test message to every enabled target right now and report each result. */
export async function sendTest(orgId: string): Promise<{ recipient: string; channel: string; ok: boolean; error?: string }[]> {
  const targets = (await db.query<{ channel: string; address: string }>(
    'SELECT channel, address FROM notification_targets WHERE org_id = $1 AND enabled ORDER BY created_at', [orgId],
  )).rows;
  const results = [];
  for (const t of targets) {
    const row = (await db.query<{ id: string }>(
      `INSERT INTO notifications (org_id, kind, channel, recipient, attempts, next_attempt_at)
       VALUES ($1, 'test', $2, $3, 1, now() + interval '100 years') RETURNING id`,
      [orgId, t.channel, t.address],
    )).rows[0];
    // A test is one immediate attempt with the answer shown to the operator, never retried in the background.
    const r = await sendOne({ id: row.id, org_id: orgId, alert_event_id: null, kind: 'test', channel: t.channel, recipient: t.address, attempts: MAX_ATTEMPTS });
    const final = (await db.query<{ last_error: string | null }>('SELECT last_error FROM notifications WHERE id = $1', [row.id])).rows[0];
    results.push({ recipient: t.address, channel: t.channel, ok: r === 'sent', ...(r === 'sent' ? {} : { error: final.last_error ?? 'failed' }) });
  }
  return results;
}
