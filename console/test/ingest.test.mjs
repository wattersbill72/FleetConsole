import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { db, closePool, call, makeOperator, cookieFrom, mockRes } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import enrolments from '../build-test/api/farms/[id]/enrolments/index.js';
import enrol from '../build-test/api/enrol.js';
import ingest from '../build-test/api/ingest/snapshot.js';

after(closePool);

async function newNode() {
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farm = (await call(farms, { method: 'POST', cookie, body: { name: 'home', time_zone: 'UTC' } })).body.farm;
  const { token } = (await call(enrolments, { method: 'POST', cookie, query: { id: farm.id }, body: { platform: 'ubuntu' } })).body;
  const r = await call(enrol, { method: 'POST', body: { token, os: 'ubuntu', hostname: 'dell01' } });
  return { op, cookie, farm, nodeId: r.body.node_id, credential: r.body.credential };
}

const snap = (nodeId, seq, over = {}) => ({
  schema_version: 1,
  envelope: { node_id: nodeId, agent_version: '0.1.0', applied_config_version: 1, node_time: new Date().toISOString(), seq, replayed: false, ...over.envelope },
  host: {
    hostname: 'dell01', os: 'ubuntu', os_version: '24.04', uptime_s: 1000, cpu_pct: 12.5, load: [0.5, 0.4, 0.3],
    mem_used_bytes: 4e9, mem_total_bytes: 16e9, disks: [{ mount: '/', used_bytes: 50, total_bytes: 100 }, { mount: '/data', used_bytes: 90, total_bytes: 100 }],
    addresses: ['192.168.1.10'], temperature_c: null, ...over.host,
  },
  agent_health: { buffer_depth: 0, dropped_count: 0 },
  ...over.top,
});
const send = (n, body, headers = {}) =>
  call(ingest, { method: 'POST', body, headers: { authorization: `Bearer ${n.credential}`, ...headers } });
const count = async (nodeId) => Number((await db.query('SELECT count(*) AS n FROM snapshots WHERE node_id = $1', [nodeId])).rows[0].n);
const node = async (nodeId) => (await db.query('SELECT * FROM nodes WHERE id = $1', [nodeId])).rows[0];

test('US-013: a valid Snapshot is stored; pending becomes healthy; response carries config version and commands', async () => {
  const n = await newNode();
  assert.equal((await node(n.nodeId)).status, 'pending');
  const res = await send(n, snap(n.nodeId, 1));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, duplicate: false, last_seq: 1, desired_config_version: 1, commands: [] });

  const row = (await db.query('SELECT * FROM snapshots WHERE node_id = $1', [n.nodeId])).rows[0];
  assert.equal(row.cpu_pct, 12.5);
  assert.equal(Number(row.mem_total_bytes), 16e9);
  assert.equal(row.disk_worst_pct, 90);
  assert.equal(row.detail.host.disks.length, 2);

  const nd = await node(n.nodeId);
  assert.equal(nd.status, 'healthy');
  assert.equal(nd.os_version, '24.04');
  assert.equal(nd.agent_version, '0.1.0');
  assert.equal(nd.latest.disk_worst_pct, 90);
  assert.ok(nd.last_heartbeat_at);
});

test('US-013: every credential failure is the same 401, and nothing is stored', async () => {
  const n = await newNode();
  const body = snap(n.nodeId, 1);
  const bad = [
    {},
    { authorization: 'Bearer nope' },
    { authorization: 'Basic abc' },
    { authorization: 'Bearer fcn_' + 'A'.repeat(43) },
    { authorization: `bearer ${n.credential}` },
  ];
  const results = [];
  for (const headers of bad) results.push(await call(ingest, { method: 'POST', body, headers }));

  await db.query('UPDATE node_credentials SET revoked_at = now() WHERE node_id = $1', [n.nodeId]);
  results.push(await send(n, body));                       // revoked
  const other = await newNode();
  await db.query(`UPDATE nodes SET status = 'removed' WHERE id = $1`, [other.nodeId]);
  results.push(await send(other, snap(other.nodeId, 1))); // removed node

  for (const r of results) { assert.equal(r.statusCode, 401); assert.deepEqual(r.body, { error: 'Unauthorized' }); }
  assert.equal(await count(n.nodeId), 0);
  assert.equal(await count(other.nodeId), 0);
});

test('US-013: an operator session cookie does not authenticate ingest', async () => {
  const n = await newNode();
  const res = await call(ingest, { method: 'POST', body: snap(n.nodeId, 1), cookie: n.cookie });
  assert.equal(res.statusCode, 401);
});

test('US-013: revocation takes effect on the very next Snapshot', async () => {
  const n = await newNode();
  assert.equal((await send(n, snap(n.nodeId, 1))).statusCode, 200);
  await db.query('UPDATE node_credentials SET revoked_at = now() WHERE node_id = $1', [n.nodeId]);
  assert.equal((await send(n, snap(n.nodeId, 2))).statusCode, 401);
  assert.equal(await count(n.nodeId), 1);
});

test('US-013: oversize payloads are refused (declared length, parsed body, and raw stream); nothing stored', async () => {
  const n = await newNode();
  const big = snap(n.nodeId, 1, { host: { hostname: 'h'.repeat(300 * 1024) } });
  assert.equal((await send(n, big)).statusCode, 413);
  assert.equal((await send(n, snap(n.nodeId, 1), { 'content-length': String(300 * 1024) })).statusCode, 413);

  // Raw stream path (bodyParser disabled in production): the cap applies while reading.
  const stream = Readable.from([Buffer.from('{"x":"'), Buffer.alloc(300 * 1024, 97), Buffer.from('"}')]);
  stream.method = 'POST'; stream.headers = { host: 'console.test', authorization: `Bearer ${n.credential}` };
  const res = mockRes();
  await ingest(stream, res);
  assert.equal(res.statusCode, 413);
  assert.equal(await count(n.nodeId), 0);
});

test('US-013: the raw stream path accepts a valid Snapshot', async () => {
  const n = await newNode();
  const stream = Readable.from([Buffer.from(JSON.stringify(snap(n.nodeId, 1)))]);
  stream.method = 'POST'; stream.headers = { host: 'console.test', authorization: `Bearer ${n.credential}` };
  const res = mockRes();
  await ingest(stream, res);
  assert.equal(res.statusCode, 200);
  assert.equal(await count(n.nodeId), 1);
  const bad = Readable.from([Buffer.from('{not json')]);
  bad.method = 'POST'; bad.headers = { host: 'console.test', authorization: `Bearer ${n.credential}` };
  const r2 = mockRes();
  await ingest(bad, r2);
  assert.equal(r2.statusCode, 400);
});

test('US-013: unknown schema version, malformed, and extra-field Snapshots are rejected; nothing stored', async () => {
  const n = await newNode();
  const v2 = await send(n, { ...snap(n.nodeId, 1), schema_version: 2 });
  assert.equal(v2.statusCode, 400);
  assert.equal(v2.body.code, 'unsupported_schema_version');
  const noHost = snap(n.nodeId, 1); delete noHost.host;
  assert.equal((await send(n, noHost)).statusCode, 400);
  assert.equal((await send(n, snap(n.nodeId, 1, { top: { surprise: true } }))).statusCode, 400);
  assert.equal((await send(n, snap(n.nodeId, 1, { host: { cpu_pct: 400 } }))).statusCode, 400);
  assert.equal((await send(n, snap(n.nodeId, -1))).statusCode, 400);
  assert.equal((await call(ingest, { method: 'POST', body: 'garbage', headers: { authorization: `Bearer ${n.credential}` } })).statusCode, 400);
  assert.equal(await count(n.nodeId), 0);
});

test('US-013: a valid credential cannot report as a different node', async () => {
  const a = await newNode(), b = await newNode();
  const res = await send(a, snap(b.nodeId, 1));
  assert.equal(res.statusCode, 403);
  assert.equal(await count(a.nodeId), 0);
  assert.equal(await count(b.nodeId), 0);
});

test('US-013: duplicates and replays produce one record, including under concurrency', async () => {
  const n = await newNode();
  const first = await send(n, snap(n.nodeId, 5));
  assert.equal(first.body.duplicate, false);
  const again = await send(n, snap(n.nodeId, 5));
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.duplicate, true);
  const burst = await Promise.all(Array.from({ length: 6 }, () => send(n, snap(n.nodeId, 9))));
  assert.equal(burst.filter((r) => r.body.duplicate === false).length, 1);
  assert.equal(await count(n.nodeId), 2);
});

test('US-013: receipt time is authoritative; the node timestamp is kept alongside', async () => {
  const n = await newNode();
  await send(n, snap(n.nodeId, 1, { envelope: { node_time: '2001-01-01T00:00:00Z' } }));
  await send(n, snap(n.nodeId, 2, { envelope: { node_time: '2099-01-01T00:00:00Z' } }));
  const rows = (await db.query(
    `SELECT seq, node_time, received_at > now() - interval '1 minute' AS recent FROM snapshots WHERE node_id = $1 ORDER BY received_at, seq`, [n.nodeId],
  )).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.recent));
  assert.equal(rows[0].node_time.getUTCFullYear(), 2001);
  assert.equal(rows[1].node_time.getUTCFullYear(), 2099);
});

test('US-013: replayed Snapshots fill history but never change current state', async () => {
  const n = await newNode();
  await send(n, snap(n.nodeId, 10, { host: { cpu_pct: 20 } }));
  await db.query(`UPDATE nodes SET status = 'stale' WHERE id = $1`, [n.nodeId]);
  const r = await send(n, snap(n.nodeId, 3, { envelope: { replayed: true }, host: { cpu_pct: 99 } }));
  assert.equal(r.statusCode, 200);
  const nd = await node(n.nodeId);
  assert.equal(nd.latest.cpu_pct, 20);
  assert.equal(Number(nd.last_seq), 10);
  assert.equal(nd.status, 'stale');              // only a live Snapshot revives a node
  assert.ok(nd.last_heartbeat_at);              // but it did prove the node is reachable
  assert.equal((await db.query('SELECT replayed FROM snapshots WHERE node_id = $1 AND seq = 3', [n.nodeId])).rows[0].replayed, true);
});

test('US-013: an out-of-order live Snapshot is stored but does not overwrite newer state', async () => {
  const n = await newNode();
  await send(n, snap(n.nodeId, 20, { host: { cpu_pct: 30 } }));
  await send(n, snap(n.nodeId, 19, { host: { cpu_pct: 77 } }));
  assert.equal((await node(n.nodeId)).latest.cpu_pct, 30);
  assert.equal(await count(n.nodeId), 2);
});

test('US-013: a live Snapshot revives a stale or expected-offline node; decommissioning is never overwritten', async () => {
  const n = await newNode();
  for (const [from, seq, want] of [['stale', 1, 'healthy'], ['expected-offline', 2, 'healthy'], ['decommissioning', 3, 'decommissioning']]) {
    await db.query('UPDATE nodes SET status = $2 WHERE id = $1', [n.nodeId, from]);
    await send(n, snap(n.nodeId, seq));
    assert.equal((await node(n.nodeId)).status, want, from);
  }
});

test('US-013: unavailable vitals are stored as null, never zero', async () => {
  const n = await newNode();
  await send(n, snap(n.nodeId, 1, { host: { cpu_pct: null, mem_used_bytes: null, mem_total_bytes: null, load: null, disks: [] } }));
  const row = (await db.query('SELECT * FROM snapshots WHERE node_id = $1', [n.nodeId])).rows[0];
  assert.equal(row.cpu_pct, null);
  assert.equal(row.mem_used_bytes, null);
  assert.equal(row.load1, null);
  assert.equal(row.disk_worst_pct, null);
});

test('US-013: per-node rate limit returns 429 with Retry-After; other nodes are unaffected', async () => {
  const a = await newNode(), b = await newNode();
  let limited;
  for (let i = 1; i <= 62; i++) {
    const r = await send(a, snap(a.nodeId, i));
    if (r.statusCode === 429) { limited = r; break; }
  }
  assert.ok(limited, 'expected a 429');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await send(b, snap(b.nodeId, 1))).statusCode, 200);
  assert.ok(await count(a.nodeId) <= 60);
});

test('US-013: GET is refused and ingest never echoes snapshot content or credentials in errors', async () => {
  const n = await newNode();
  assert.equal((await call(ingest, { method: 'GET' })).statusCode, 405);
  const bad = await send(n, { ...snap(n.nodeId, 1), schema_version: 2 });
  assert.ok(!JSON.stringify(bad.body).includes(n.credential));
});
