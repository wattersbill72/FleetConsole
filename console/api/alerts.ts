import { withAuth } from '../server/auth.js';
import { db } from '../server/db.js';
import { json, methodNotAllowed, UUID_RE } from '../server/http.js';

const RANGES: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

// Open alerts and searchable history for the caller's organisation.
//   state=open|closed|all (default all)   q=text in the subject name   rule=node_stale|farm_stale
//   range=24h|7d|30d|all (by opened time)   id=<alert id>   limit (max 100)   offset
export default withAuth(async (req, res, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const where = ['a.org_id = $1'];
  const params: unknown[] = [ctx.orgId];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };

  const state = one(req.query.state);
  if (state === 'open') where.push('a.closed_at IS NULL');
  else if (state === 'closed') where.push('a.closed_at IS NOT NULL');
  else if (state !== undefined && state !== 'all') return json(res, 400, { error: 'state must be open, closed or all' });

  const q = one(req.query.q)?.trim();
  if (q) add(`(a.subject_label ILIKE ? ESCAPE '\\')`, `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  const rule = one(req.query.rule);
  if (rule) add('a.rule = ?', rule);
  const range = one(req.query.range);
  if (range && range !== 'all') {
    if (!RANGES[range]) return json(res, 400, { error: 'range must be 24h, 7d, 30d or all' });
    where.push(`a.opened_at > now() - interval '${RANGES[range]}'`);   // fixed text from the table above, never user input
  }
  const id = one(req.query.id);
  if (id) {
    if (!UUID_RE.test(id)) return json(res, 200, { alerts: [], total: 0 });
    add('a.id = ?', id);
  }

  const limit = Math.min(Math.max(parseInt(one(req.query.limit) ?? '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(one(req.query.offset) ?? '0', 10) || 0, 0);
  const clause = where.join(' AND ');

  const [rows, total] = await Promise.all([
    db.query(
      `SELECT a.id, a.rule, a.subject_type, a.subject_id, a.subject_label, a.farm_id, f.name AS farm_name,
              a.opened_at, a.silent_since, a.closed_at, a.duration_s, a.outage_s, a.close_reason, a.detail
         FROM alerts a LEFT JOIN farms f ON f.id = a.farm_id
        WHERE ${clause}
        ORDER BY (a.closed_at IS NULL) DESC, a.opened_at DESC
        LIMIT ${limit} OFFSET ${offset}`, params),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM alerts a WHERE ${clause}`, params),
  ]);
  return json(res, 200, { alerts: rows.rows, total: parseInt(total.rows[0].n, 10) });
});
