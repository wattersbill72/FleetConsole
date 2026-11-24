import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closePool, call, makeOperator, cookieFrom } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import overview from '../build-test/api/overview.js';
import me from '../build-test/api/auth/me.js';
import { evaluateStaleness } from '../build-test/server/evaluate.js';

after(closePool);

async function org() {
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farmOf = async (name, tz = 'UTC') => (await call(farms, { method: 'POST', cookie, body: { name, time_zone: tz } })).body.farm;
  return { op, cookie, farmOf };
}
let n = 0;
async function seed(o, farm, { name, status = 'healthy', silentFor = 5, interval = 60, intermittent = false, latest = null, version = '0.1.0', never = false } = {}) {
  n++;
  const id = (await db.query(
    `INSERT INTO nodes (org_id, farm_id, display_name, platform, status, last_heartbeat_at, applied_config_version, agent_version, hostname, latest)
     VALUES ($1,$2,$3,'ubuntu',$4, ${never ? 'NULL' : `now() - make_interval(secs => ${silentFor})`}, 1, $5, 'host-' || $3, $6) RETURNING id`,
    [o.op.orgId, farm.id, name ?? `node-${n}`, status, version, latest ? JSON.stringify(latest) : null])).rows[0].id;
  await db.query(`INSERT INTO node_configs (node_id, version, config, created_by) VALUES ($1,1,$2,'t')`,
    [id, JSON.stringify({ schema_version: 1, version: 1, heartbeat_interval_s: interval, intermittent })]);
  return id;
}
const get = async (o) => (await call(overview, { cookie: o.cookie })).body;
const L = (cpu, used, total, disk) => ({ cpu_pct: cpu, mem_used_bytes: used, mem_total_bytes: total, disk_worst_pct: disk });

test('US-030: unauthenticated callers get nothing; other organisations\' nodes never appear', async () => {
  const a = await org(), b = await org();
  await seed(a, await a.farmOf('home'), { name: 'mine' });
  await seed(b, await b.farmOf('theirs'), { name: 'secret' });
  assert.equal((await call(overview, {})).statusCode, 401);
  const body = await get(a);
  assert.deepEqual(body.farms.flatMap((f) => f.nodes.map((x) => x.display_name)), ['mine']);
  assert.ok(!JSON.stringify(body).includes('secret'));
});

test('US-030: nodes are grouped by farm with name, status, time since last heartbeat, CPU, memory, worst disk, agent version', async () => {
  const o = await org();
  const home = await o.farmOf('home-kennewick', 'America/Los_Angeles');
  await seed(o, home, { name: 'UBUNTU-Dell01', silentFor: 42, version: '0.3.1', latest: L(12.5, 4e9, 16e9, 61.2) });
  const body = await get(o);
  assert.equal(body.farms.length, 1);
  const f = body.farms[0];
  assert.deepEqual([f.name, f.time_zone, f.healthy], ['home-kennewick', 'America/Los_Angeles', 1]);
  const nd = f.nodes[0];
  assert.equal(nd.display_name, 'UBUNTU-Dell01');
  assert.equal(nd.status, 'healthy');
  assert.ok(nd.age_s >= 42 && nd.age_s <= 45, `age ${nd.age_s}`);
  assert.ok(nd.last_heartbeat_at);
  assert.equal(nd.cpu_pct, 12.5);
  assert.equal(nd.mem_pct, 25);
  assert.equal(nd.disk_worst_pct, 61.2);
  assert.equal(nd.agent_version, '0.3.1');
  assert.ok(Math.abs(Date.parse(body.server_time) - Date.now()) < 5000);
});

test('US-030: unavailable vitals are null, never zero; a node that never reported shows no metrics', async () => {
  const o = await org(), farm = await o.farmOf('f');
  await seed(o, farm, { name: 'mac', latest: L(null, null, null, null) });
  await seed(o, farm, { name: 'fresh', status: 'pending', never: true });
  const nodes = (await get(o)).farms[0].nodes;
  for (const x of nodes) {
    assert.equal(x.cpu_pct, null); assert.equal(x.mem_pct, null); assert.equal(x.disk_worst_pct, null);
  }
  const fresh = nodes.find((x) => x.display_name === 'fresh');
  assert.equal(fresh.status, 'pending'); assert.equal(fresh.age_s, null); assert.equal(fresh.last_heartbeat_at, null);
});

test('US-030: anything not healthy sorts first, within a farm and across farms', async () => {
  const o = await org();
  const calm = await o.farmOf('a-calm'), bad = await o.farmOf('z-trouble'), empty = await o.farmOf('m-empty');
  await seed(o, calm, { name: 'ok-1' }); await seed(o, calm, { name: 'ok-2' });
  await seed(o, bad, { name: 'aa-healthy' });
  await seed(o, bad, { name: 'pend', status: 'pending', never: true });
  await seed(o, bad, { name: 'degr', status: 'degraded' });
  await seed(o, bad, { name: 'dead', silentFor: 900 });
  await seed(o, bad, { name: 'mac', silentFor: 900, intermittent: true });
  await seed(o, bad, { name: 'going', status: 'decommissioning', silentFor: 3 });
  const body = await get(o);
  assert.deepEqual(body.farms.map((f) => f.name), ['z-trouble', 'a-calm', 'm-empty']);   // worst first; empty farm last
  assert.deepEqual(body.farms[0].nodes.map((x) => [x.display_name, x.status]), [
    ['dead', 'stale'], ['degr', 'degraded'], ['going', 'decommissioning'], ['pend', 'pending'], ['mac', 'expected-offline'], ['aa-healthy', 'healthy']]);
  assert.deepEqual(body.farms[2].nodes, []);                                             // an empty farm is listed, so it can lead to enrolment
  assert.equal(empty.id, body.farms[2].id);
});

test('US-030: with the whole site offline every node shows stale with its true last-seen time, before the evaluator has run', async () => {
  const o = await org(), farm = await o.farmOf('home');
  for (let i = 0; i < 5; i++) await seed(o, farm, { name: `n${i}`, silentFor: 600 + i * 7 });   // stored status still 'healthy'
  const body = await get(o);
  assert.ok(body.farms[0].nodes.every((x) => x.status === 'stale' && x.stored_status === 'healthy'));
  const ages = body.farms[0].nodes.map((x) => x.age_s).sort((a, b) => a - b);
  assert.ok(ages[0] >= 600 && ages[4] >= 628 && ages[4] < 640, JSON.stringify(ages));
  assert.equal(body.summary.stale, 5);
  assert.equal(body.summary.all_clear, false);
  assert.equal(body.summary.needs_attention, 5);
  assert.equal(body.summary.open_alerts, 0);                                              // cron has not run: the screen is right regardless

  await evaluateStaleness();                                                              // and nothing changes when it does
  const after = await get(o);
  assert.deepEqual(after.farms[0].nodes.map((x) => x.status), Array(5).fill('stale'));
  assert.equal(after.summary.open_alerts, 1);                                             // one farm alert, not five
});

test('US-030: the stale threshold follows each node\'s own interval; two missed intervals is still healthy', async () => {
  const o = await org(), farm = await o.farmOf('f');
  await seed(o, farm, { name: 'slow-ok', silentFor: 300, interval: 120 });
  await seed(o, farm, { name: 'slow-dead', silentFor: 400, interval: 120 });
  await seed(o, farm, { name: 'fast-ok', silentFor: 80, interval: 60 });
  const got = Object.fromEntries((await get(o)).farms[0].nodes.map((x) => [x.display_name, x.status]));
  assert.deepEqual(got, { 'slow-ok': 'healthy', 'slow-dead': 'stale', 'fast-ok': 'healthy' });
});

test('US-030: removed nodes are not listed', async () => {
  const o = await org(), farm = await o.farmOf('f');
  await seed(o, farm, { name: 'gone', status: 'removed' });
  await seed(o, farm, { name: 'here' });
  assert.deepEqual((await get(o)).farms[0].nodes.map((x) => x.display_name), ['here']);
});

test('US-030: open alerts are summarised at the top with a count and the newest few', async () => {
  const o = await org(), farm = await o.farmOf('home');
  for (let i = 0; i < 7; i++) {
    const id = await seed(o, farm, { name: `d${i}`, silentFor: 4000 + i * 1000 });            // far apart: seven separate outages
    void id;
  }
  await evaluateStaleness();
  const s = await get(o);
  assert.equal(s.summary.open_alerts, 7);
  assert.equal(s.alerts.length, 5);
  assert.ok(s.alerts.every((a) => a.id && a.rule === 'node_stale' && a.farm_name === 'home' && a.opened_at));
  const clean = await org();
  await seed(clean, await clean.farmOf('f'), { name: 'ok' });
  const c = await get(clean);
  assert.deepEqual([c.summary.all_clear, c.summary.open_alerts, c.summary.needs_attention], [true, 0, 0]);
});

test('US-030: only stale and degraded nodes count as needing attention; pending and expected-offline do not', async () => {
  const o = await org(), farm = await o.farmOf('f');
  await seed(o, farm, { name: 'p', status: 'pending', never: true });
  await seed(o, farm, { name: 'e', silentFor: 900, intermittent: true });
  const s = (await get(o)).summary;
  assert.deepEqual([s.needs_attention, s.pending, s.expected_offline, s.all_clear], [0, 1, 1, true]);
});

test('US-030: the stored and shown status agree once the evaluator has run (no drift between the two rules)', async () => {
  const o = await org(), farm = await o.farmOf('f');
  for (const [name, silentFor, intermittent] of [['a', 10, false], ['b', 179, false], ['c', 181, false], ['d', 500, true], ['e', 1000, false]]) {
    await seed(o, farm, { name, silentFor, intermittent });
  }
  const before = (await get(o)).farms[0].nodes.map((x) => [x.display_name, x.status]);
  await evaluateStaleness();
  const stored = (await db.query(`SELECT display_name, status FROM nodes WHERE farm_id = $1`, [farm.id])).rows.map((r) => [r.display_name, r.status]);
  assert.deepEqual(before.sort(), stored.sort());
});

test('US-030: it answers quickly with a realistic and a generous fleet', async () => {
  const o = await org(), farm = await o.farmOf('f');
  for (let i = 0; i < 60; i++) await seed(o, farm, { name: `n${String(i).padStart(2, '0')}`, silentFor: i * 10, latest: L(10, 1e9, 4e9, 50) });
  const t = Date.now();
  const r = await call(overview, { cookie: o.cookie });
  assert.equal(r.statusCode, 200);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  assert.equal(r.body.farms[0].nodes.length, 60);
});

// ---- polling must not keep a session alive ----
test('US-001/030: polling the overview does not extend a session, while real use does', async () => {
  const o = await org();
  await db.query(`UPDATE sessions SET last_active_at = now() - interval '7 hours' WHERE user_id = $1`, [o.op.userId]);
  for (let i = 0; i < 3; i++) assert.equal((await call(overview, { cookie: o.cookie })).statusCode, 200);
  const stamp = (await db.query(`SELECT last_active_at < now() - interval '6 hours 59 minutes' AS still_old FROM sessions WHERE user_id = $1`, [o.op.userId])).rows[0];
  assert.equal(stamp.still_old, true, 'polling must not refresh the activity stamp');

  // Eight hours pass with nothing but polling: the session ends, as the story requires.
  await db.query(`UPDATE sessions SET last_active_at = now() - interval '9 hours' WHERE user_id = $1`, [o.op.userId]);
  assert.equal((await call(overview, { cookie: o.cookie })).statusCode, 401);

  // An ordinary request is activity and does extend it.
  const o2 = await org();
  await db.query(`UPDATE sessions SET last_active_at = now() - interval '7 hours' WHERE user_id = $1`, [o2.op.userId]);
  assert.equal((await call(me, { cookie: o2.cookie })).statusCode, 200);
  assert.equal((await db.query(`SELECT last_active_at > now() - interval '1 minute' AS fresh FROM sessions WHERE user_id = $1`, [o2.op.userId])).rows[0].fresh, true);
});
