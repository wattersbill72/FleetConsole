import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closePool, call, makeOperator, cookieFrom } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import enrolments from '../build-test/api/farms/[id]/enrolments/index.js';
import enrol from '../build-test/api/enrol.js';
import ingest from '../build-test/api/ingest/snapshot.js';
import alertsRoute from '../build-test/api/alerts.js';
import cron from '../build-test/api/cron/evaluate.js';
import { evaluateStaleness } from '../build-test/server/evaluate.js';

after(closePool);

async function org() {
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farmOf = async (name = 'home') => (await call(farms, { method: 'POST', cookie, body: { name, time_zone: 'UTC' } })).body.farm;
  return { op, cookie, farmOf };
}

let n = 0;
/** Insert a node directly. `silentFor` is seconds since its last heartbeat; null means it never reported. */
async function seed(o, farm, { silentFor = 0, status = 'healthy', interval = 60, intermittent = false, name } = {}) {
  n += 1;
  const nd = (await db.query(
    `INSERT INTO nodes (org_id, farm_id, display_name, platform, status, last_heartbeat_at, applied_config_version)
     VALUES ($1, $2, $3, 'ubuntu', $4, ${silentFor === null ? 'NULL' : `now() - make_interval(secs => ${Number(silentFor)})`}, 1) RETURNING id`,
    [o.op.orgId, farm.id, name ?? `node-${n}`, status],
  )).rows[0];
  await db.query(
    `INSERT INTO node_configs (node_id, version, config, created_by) VALUES ($1, 1, $2, 'test')`,
    [nd.id, JSON.stringify({ schema_version: 1, version: 1, heartbeat_interval_s: interval, intermittent })],
  );
  return nd.id;
}
const status = async (id) => (await db.query('SELECT status FROM nodes WHERE id = $1', [id])).rows[0].status;
const alerts = async (orgId, rule) =>
  (await db.query(`SELECT * FROM alerts WHERE org_id = $1 ${rule ? 'AND rule = $2' : ''} ORDER BY opened_at`, rule ? [orgId, rule] : [orgId])).rows;
const open = async (orgId, rule) => (await alerts(orgId, rule)).filter((a) => !a.closed_at);

test('US-060: a node that has missed three intervals moves to stale and an alert opens; two is not enough', async () => {
  const o = await org(), farm = await o.farmOf();
  const fine = await seed(o, farm, { silentFor: 170 });     // under 3 x 60 s
  const dead = await seed(o, farm, { silentFor: 181, name: 'dell01' });
  const r = await evaluateStaleness();
  assert.equal(await status(fine), 'healthy');
  assert.equal(await status(dead), 'stale');
  assert.equal(r.nodesStale >= 1, true);
  const a = await open(o.op.orgId, 'node_stale');
  assert.equal(a.length, 1);
  assert.equal(a[0].subject_id, dead);
  assert.equal(a[0].subject_label, 'dell01');
  assert.equal(a[0].detail.threshold_s, 180);
  assert.ok(a[0].silent_since);
});

test('US-060: the threshold follows each node\'s own interval', async () => {
  const o = await org(), farm = await o.farmOf();
  const slowOk = await seed(o, farm, { silentFor: 300, interval: 120 });    // 360 s threshold
  const slowDead = await seed(o, farm, { silentFor: 361, interval: 120 });
  const fastDead = await seed(o, farm, { silentFor: 100, interval: 30 });   // 90 s threshold
  await evaluateStaleness();
  assert.deepEqual([await status(slowOk), await status(slowDead), await status(fastDead)], ['healthy', 'stale', 'stale']);
});

test('US-060: a dead node is flagged within four minutes at the default interval', async () => {
  // Heartbeat received at t0; the evaluator runs every 60 s. Stale from t0+180 s, so the first run at or after
  // that point is at most 60 s later: 240 s worst case. Check the boundary and the evaluator period.
  const o = await org(), farm = await o.farmOf();
  const justBefore = await seed(o, farm, { silentFor: 179 });
  const justAfter = await seed(o, farm, { silentFor: 181 });
  await evaluateStaleness();
  assert.equal(await status(justBefore), 'healthy');
  assert.equal(await status(justAfter), 'stale');
  const vercel = JSON.parse((await import('node:fs')).readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(vercel.crons, [{ path: '/api/cron/evaluate', schedule: '* * * * *' }]);
});

test('US-060: evaluating repeatedly, even concurrently, opens exactly one alert and one open event', async () => {
  const o = await org(), farm = await o.farmOf();
  await seed(o, farm, { silentFor: 400 });
  await seed(o, farm, { silentFor: 10 });
  await Promise.all([evaluateStaleness(), evaluateStaleness(), evaluateStaleness()]);
  await evaluateStaleness();
  const a = await open(o.op.orgId, 'node_stale');
  assert.equal(a.length, 1);
  const ev = await db.query('SELECT event FROM alert_events WHERE alert_id = $1', [a[0].id]);
  assert.deepEqual(ev.rows.map((r) => r.event), ['open']);
});

test('US-060: detection works when every node is silent at once, with no heartbeat arriving', async () => {
  const o = await org(), farm = await o.farmOf();
  for (let i = 0; i < 4; i++) await seed(o, farm, { silentFor: 600 + i });
  const r = await evaluateStaleness();
  assert.equal(r.farmAlertsOpened, 1);
  assert.equal((await db.query(`SELECT count(*) AS n FROM nodes WHERE farm_id = $1 AND status = 'stale'`, [farm.id])).rows[0].n, '4');
});

test('US-060: when every node in a farm goes stale together, one farm alert opens instead of one per node', async () => {
  const o = await org(), farm = await o.farmOf();
  for (let i = 0; i < 3; i++) await seed(o, farm, { silentFor: 400 + i * 20 });
  await evaluateStaleness();
  assert.equal((await open(o.op.orgId, 'farm_stale')).length, 1);
  assert.equal((await open(o.op.orgId, 'node_stale')).length, 0);
  const fa = (await open(o.op.orgId, 'farm_stale'))[0];
  assert.equal(fa.subject_label, 'home');
  assert.equal(fa.detail.nodes.length, 3);
});

test('US-060: silences that began far apart are separate outages: one alert per node, no farm alert', async () => {
  const o = await org(), farm = await o.farmOf();
  await seed(o, farm, { silentFor: 3600 });
  await seed(o, farm, { silentFor: 400 });
  await seed(o, farm, { silentFor: 410 });
  await evaluateStaleness();
  assert.equal((await open(o.op.orgId, 'farm_stale')).length, 0);
  assert.equal((await open(o.op.orgId, 'node_stale')).length, 3);
});

test('US-060: a single-node farm gets a node alert, not a farm alert; a healthy peer prevents a farm alert', async () => {
  const a = await org(), fa = await a.farmOf();
  await seed(a, fa, { silentFor: 500 });
  await evaluateStaleness();
  assert.equal((await open(a.op.orgId, 'node_stale')).length, 1);
  assert.equal((await open(a.op.orgId, 'farm_stale')).length, 0);

  const b = await org(), fb = await b.farmOf();
  await seed(b, fb, { silentFor: 500 });
  await seed(b, fb, { silentFor: 510 });
  await seed(b, fb, { silentFor: 5 });
  await evaluateStaleness();
  assert.equal((await open(b.op.orgId, 'farm_stale')).length, 0);
  assert.equal((await open(b.op.orgId, 'node_stale')).length, 2);
});

test('US-060: intermittent nodes go to expected-offline and open no alert, and do not count toward a farm outage', async () => {
  const o = await org(), farm = await o.farmOf();
  const mac = await seed(o, farm, { silentFor: 900, intermittent: true, name: 'macbook' });
  const a = await seed(o, farm, { silentFor: 400 });
  const b = await seed(o, farm, { silentFor: 410 });
  await evaluateStaleness();
  assert.equal(await status(mac), 'expected-offline');
  assert.equal((await alerts(o.op.orgId)).filter((x) => x.subject_id === mac).length, 0);
  assert.equal((await open(o.op.orgId, 'farm_stale')).length, 1);          // a and b are the whole expected fleet
  assert.deepEqual((await open(o.op.orgId, 'farm_stale'))[0].detail.nodes.map((x) => x.id).sort(), [a, b].sort());
});

test('US-060: pending, decommissioning, removed and already-expected-offline nodes are never alerted', async () => {
  const o = await org(), farm = await o.farmOf();
  await seed(o, farm, { silentFor: null, status: 'pending' });
  await seed(o, farm, { silentFor: 9999, status: 'decommissioning' });
  await seed(o, farm, { silentFor: 9999, status: 'removed' });
  await seed(o, farm, { silentFor: 9999, status: 'expected-offline' });
  await evaluateStaleness();
  assert.equal((await alerts(o.op.orgId)).length, 0);
});

// ---- recovery, through the real ingest path ----
async function realNode(o, farm) {
  const token = (await call(enrolments, { method: 'POST', cookie: o.cookie, query: { id: farm.id }, body: { platform: 'ubuntu', display_name: 'real' } })).body.token;
  const r = await call(enrol, { method: 'POST', body: { token, os: 'ubuntu', hostname: 'h' } });
  return { id: r.body.node_id, credential: r.body.credential };
}
const snap = (id, seq, replayed = false) => ({
  schema_version: 1,
  envelope: { node_id: id, agent_version: '0.1.0', applied_config_version: 1, node_time: new Date().toISOString(), seq, replayed },
  host: { hostname: 'h', os: 'ubuntu', os_version: '24.04', uptime_s: 5 },
  agent_health: { buffer_depth: 0, dropped_count: 0 },
});
const send = (nd, body) => call(ingest, { method: 'POST', headers: { authorization: `Bearer ${nd.credential}` }, body });

test('US-060: when the node reports again the alert closes and its duration is recorded', async () => {
  const o = await org(), farm = await o.farmOf();
  const nd = await realNode(o, farm);
  await send(nd, snap(nd.id, 1));
  await db.query(`UPDATE nodes SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [nd.id]);
  await db.query(`UPDATE node_configs SET config = jsonb_set(config, '{heartbeat_interval_s}', '60') WHERE node_id = $1`, [nd.id]);
  await evaluateStaleness();
  const [a] = await open(o.op.orgId, 'node_stale');
  assert.ok(a);
  // pretend the alert was opened 5 minutes ago so the duration is visible
  await db.query(`UPDATE alerts SET opened_at = now() - interval '5 minutes' WHERE id = $1`, [a.id]);

  const r = await send(nd, snap(nd.id, 2));
  assert.equal(r.statusCode, 200);
  assert.equal((await db.query('SELECT status FROM nodes WHERE id = $1', [nd.id])).rows[0].status, 'healthy');
  const closed = (await alerts(o.op.orgId, 'node_stale'))[0];
  assert.ok(closed.closed_at);
  assert.ok(closed.duration_s >= 299 && closed.duration_s <= 310, `duration ${closed.duration_s}`);
  assert.ok(closed.outage_s >= 599 && closed.outage_s <= 610, `outage ${closed.outage_s}`);
  assert.equal(closed.close_reason, 'node reported again');
  const ev = await db.query('SELECT event FROM alert_events WHERE alert_id = $1 ORDER BY id', [a.id]);
  assert.deepEqual(ev.rows.map((x) => x.event), ['open', 'close']);

  // A later outage is a new alert; the first stays in history.
  await db.query(`UPDATE nodes SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [nd.id]);
  await evaluateStaleness();
  assert.equal((await alerts(o.op.orgId, 'node_stale')).length, 2);
  assert.equal((await open(o.op.orgId, 'node_stale')).length, 1);
});

test('US-060: a replayed Snapshot does not end an outage', async () => {
  const o = await org(), farm = await o.farmOf();
  const nd = await realNode(o, farm);
  await send(nd, snap(nd.id, 5));
  await db.query(`UPDATE nodes SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [nd.id]);
  await evaluateStaleness();
  await send(nd, snap(nd.id, 2, true));
  assert.equal((await db.query('SELECT status FROM nodes WHERE id = $1', [nd.id])).rows[0].status, 'stale');
  assert.equal((await open(o.op.orgId, 'node_stale')).length, 0 + 1);
});

test('US-060: an intermittent node that reports again becomes healthy with no alert history', async () => {
  const o = await org(), farm = await o.farmOf();
  const nd = await realNode(o, farm);
  await send(nd, snap(nd.id, 1));
  await db.query(`UPDATE node_configs SET config = jsonb_set(config, '{intermittent}', 'true') WHERE node_id = $1`, [nd.id]);
  await db.query(`UPDATE nodes SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [nd.id]);
  await evaluateStaleness();
  assert.equal((await db.query('SELECT status FROM nodes WHERE id = $1', [nd.id])).rows[0].status, 'expected-offline');
  await send(nd, snap(nd.id, 2));
  assert.equal((await db.query('SELECT status FROM nodes WHERE id = $1', [nd.id])).rows[0].status, 'healthy');
  assert.equal((await alerts(o.op.orgId)).length, 0);
});

test('US-060: the farm alert closes when a node of the silent farm reports; the nodes still silent then get their own alerts', async () => {
  const o = await org(), farm = await o.farmOf();
  const back = await realNode(o, farm);
  await send(back, snap(back.id, 1));
  await db.query(`UPDATE nodes SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [back.id]);
  const other1 = await seed(o, farm, { silentFor: 600 });
  const other2 = await seed(o, farm, { silentFor: 605 });
  await evaluateStaleness();
  assert.equal((await open(o.op.orgId, 'farm_stale')).length, 1);

  await send(back, snap(back.id, 2));
  assert.equal((await open(o.op.orgId, 'farm_stale')).length, 0);
  const fa = (await alerts(o.op.orgId, 'farm_stale'))[0];
  assert.ok(fa.closed_at && fa.duration_s >= 0 && fa.outage_s >= 599);

  await evaluateStaleness();                                    // the site is back, but two machines are still down
  const nodeAlerts = await open(o.op.orgId, 'node_stale');
  assert.deepEqual(nodeAlerts.map((x) => x.subject_id).sort(), [other1, other2].sort());
});

test('US-060: alerts whose node is removed or decommissioned are closed by the evaluator', async () => {
  const o = await org(), farm = await o.farmOf();
  const a = await seed(o, farm, { silentFor: 500 });
  await seed(o, farm, { silentFor: 5 });
  await evaluateStaleness();
  assert.equal((await open(o.op.orgId, 'node_stale')).length, 1);
  await db.query(`UPDATE nodes SET status = 'removed' WHERE id = $1`, [a]);
  await evaluateStaleness();
  assert.equal((await open(o.op.orgId, 'node_stale')).length, 0);
  assert.equal((await alerts(o.op.orgId, 'node_stale'))[0].close_reason, 'node no longer stale');
});

// ---- cron endpoint and alerts API ----
test('the cron endpoint refuses to run without a matching secret, and refuses everything if none is configured', async () => {
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  assert.equal((await call(cron, { headers: { authorization: 'Bearer anything' } })).statusCode, 503);
  process.env.CRON_SECRET = 's3cret-value';
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer s3cret-value ' }, { authorization: 's3cret-value' }]) {
    assert.equal((await call(cron, { headers })).statusCode, 401, JSON.stringify(headers));
  }
  const ok = await call(cron, { headers: { authorization: 'Bearer s3cret-value' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.skipped, false);
  assert.equal(typeof ok.body.nodesStale, 'number');
  assert.equal((await call(cron, { method: 'DELETE', headers: { authorization: 'Bearer s3cret-value' } })).statusCode, 405);
  process.env.CRON_SECRET = saved;
  if (saved === undefined) delete process.env.CRON_SECRET;
});

test('alerts API: operator sees only their organisation\'s alerts; unauthenticated sees nothing', async () => {
  const a = await org(), fa = await a.farmOf();
  const b = await org(), fb = await b.farmOf();
  await seed(a, fa, { silentFor: 500 });
  await seed(b, fb, { silentFor: 500 });
  await evaluateStaleness();
  const mine = (await call(alertsRoute, { cookie: a.cookie, query: { state: 'open' } })).body.alerts;
  assert.equal(mine.length, 1);
  assert.ok(mine.every((x) => x.farm_id === fa.id));
  assert.equal((await call(alertsRoute, {})).statusCode, 401);
  const all = (await call(alertsRoute, { cookie: a.cookie })).body.alerts;
  assert.equal(all.length, 1);
});
