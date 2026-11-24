import { withAuth } from '../../server/auth.js';
import { db } from '../../server/db.js';
import { channelNames, getChannel } from '../../server/notify/channels.js';
import '../../server/notify/ses.js';
import { json, methodNotAllowed } from '../../server/http.js';

// Settings view: where notifications go, whether sending is set up, and what happened to recent ones.
export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const [targets, recent, failed] = await Promise.all([
    db.query(
      `SELECT id, channel, address, enabled, created_at FROM notification_targets WHERE org_id = $1 ORDER BY created_at`, [ctx.orgId]),
    db.query(
      `SELECT n.id, n.kind, n.channel, n.recipient, n.status, n.attempts, n.last_error, n.created_at, n.sent_at,
              a.id AS alert_id, a.subject_label, a.rule
         FROM notifications n
         LEFT JOIN alert_events e ON e.id = n.alert_event_id
         LEFT JOIN alerts a ON a.id = e.alert_id
        WHERE n.org_id = $1 ORDER BY n.id DESC LIMIT 50`, [ctx.orgId]),
    db.query<{ n: string }>(
      `SELECT count(*) AS n FROM notifications WHERE org_id = $1 AND status = 'failed' AND created_at > now() - interval '24 hours'`, [ctx.orgId]),
  ]);
  return json(res, 200, {
    channels: Object.fromEntries(channelNames().map((c) => [c, { configured: getChannel(c)!.configured() }])),
    targets: targets.rows,
    recent: recent.rows,
    failed_24h: parseInt(failed.rows[0].n, 10),
  });
});
