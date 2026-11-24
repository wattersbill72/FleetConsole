import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closePool, call, makeOperator, cookieFrom, audit } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import enrolments from '../build-test/api/farms/[id]/enrolments/index.js';
import enrolmentById from '../build-test/api/farms/[id]/enrolments/[eid].js';
import farmNodes from '../build-test/api/farms/[id]/nodes.js';
import enrol from '../build-test/api/enrol.js';

after(closePool);
process.env.CONSOLE_URL = 'https://fleet.example.test';

async function setup() {
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farm = (await call(farms, { method: 'POST', cookie, body: { name: 'home', time_zone: 'UTC' } })).body.farm;
  return { op, cookie, farm };
}
const issue = (s, body = { platform: 'ubuntu' }) =>
  call(enrolments, { method: 'POST', cookie: s.cookie, query: { id: s.farm.id }, body });
const redeem = (token, extra = {}) =>
  call(enrol, { method: 'POST', body: { token, os: 'ubuntu', hostname: 'dell01', os_version: '24.04', agent_version: '0.1.0', ...extra } });

test('US-010: issue an enrolment: one-time token, install command, expiry about one hour', async () => {
  const s = await setup();
  const res = await issue(s);
  assert.equal(res.statusCode, 201);
  assert.match(res.body.token, /^fce_[A-Za-z0-9_-]{32}$/);
  assert.equal(res.body.command, `curl -fsSL https://fleet.example.test/install.sh | sudo bash -s -- --token ${res.body.token}`);
  const mins = (Date.parse(res.body.enrolment.expires_at) - Date.now()) / 60000;
  assert.ok(mins > 59 && mins <= 60, `expiry ${mins}`);
  assert.equal((await audit('enrolment.issue', s.op.orgId)).length, 1);
});

test('US-010: the token is displayed once: nowhere in the database, audit trail, or list response', async () => {
  const s = await setup();
  const { token } = (await issue(s)).body;
  const list = await call(enrolments, { cookie: s.cookie, query: { id: s.farm.id } });
  assert.equal(list.body.enrolments.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(token));
  assert.ok(!('token' in list.body.enrolments[0]) && !('token_hash' in list.body.enrolments[0]));
  for (const table of ['enrolments', 'audit_events']) {
    const dump = JSON.stringify((await db.query(`SELECT * FROM ${table}`)).rows);
    assert.ok(!dump.includes(token), `${table} leaked the token`);
  }
});

test('US-010: generating another enrolment is allowed and each token is distinct', async () => {
  const s = await setup();
  const a = (await issue(s)).body.token, b = (await issue(s)).body.token;
  assert.notEqual(a, b);
  assert.equal((await call(enrolments, { cookie: s.cookie, query: { id: s.farm.id } })).body.enrolments.length, 2);
});

test('US-010: presets (name, intermittent, initial config) are validated; bad input writes nothing', async () => {
  const s = await setup();
  for (const body of [
    {}, { platform: 'windows' }, { platform: 'ubuntu', display_name: 'x'.repeat(81) }, { platform: 'ubuntu', display_name: 7 },
    { platform: 'ubuntu', intermittent: 'yes' }, { platform: 'ubuntu', initial_config: [] },
    { platform: 'ubuntu', initial_config: { heartbeat_interval_s: 10 } },
    { platform: 'ubuntu', initial_config: { heartbeat_interval_s: 301 } },
    { platform: 'ubuntu', initial_config: { run_command: 'rm -rf /' } },
  ]) {
    assert.equal((await issue(s, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await audit('enrolment.issue', s.op.orgId)).length, 0);
});

test('US-010: cancel an outstanding enrolment; cancelled token is refused on the node; cancel is audited', async () => {
  const s = await setup();
  const { token, enrolment } = (await issue(s)).body;
  const del = await call(enrolmentById, { method: 'DELETE', cookie: s.cookie, query: { id: s.farm.id, eid: enrolment.id } });
  assert.equal(del.statusCode, 200);
  assert.deepEqual((await call(enrolments, { cookie: s.cookie, query: { id: s.farm.id } })).body.enrolments, []);
  const r = await redeem(token);
  assert.equal(r.statusCode, 410);
  assert.equal(r.body.code, 'token_cancelled');
  assert.equal((await audit('enrolment.cancel', s.op.orgId)).length, 1);
  assert.equal((await call(enrolmentById, { method: 'DELETE', cookie: s.cookie, query: { id: s.farm.id, eid: enrolment.id } })).statusCode, 404);
});

test('US-010: outstanding list excludes used and expired enrolments', async () => {
  const s = await setup();
  const used = (await issue(s)).body, expired = (await issue(s)).body, open = (await issue(s)).body;
  await redeem(used.token);
  await db.query(`UPDATE enrolments SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.enrolment.id]);
  const list = (await call(enrolments, { cookie: s.cookie, query: { id: s.farm.id } })).body.enrolments;
  assert.deepEqual(list.map((e) => e.id), [open.enrolment.id]);
});

test('US-010: unauthenticated and cross-org callers cannot issue, list, or cancel', async () => {
  const s = await setup();
  const other = await setup();
  const mine = (await issue(s)).body;
  assert.equal((await call(enrolments, { method: 'POST', query: { id: s.farm.id }, body: { platform: 'ubuntu' } })).statusCode, 401);
  assert.equal((await call(enrolments, { method: 'POST', cookie: other.cookie, query: { id: s.farm.id }, body: { platform: 'ubuntu' } })).statusCode, 404);
  assert.equal((await call(enrolments, { cookie: other.cookie, query: { id: s.farm.id } })).statusCode, 404);
  assert.equal((await call(enrolmentById, { method: 'DELETE', cookie: other.cookie, query: { id: s.farm.id, eid: mine.enrolment.id } })).statusCode, 404);
  assert.equal((await call(enrolmentById, { method: 'DELETE', cookie: other.cookie, query: { id: other.farm.id, eid: mine.enrolment.id } })).statusCode, 404);
  assert.equal((await call(farmNodes, { cookie: other.cookie, query: { id: s.farm.id } })).statusCode, 404);
});

test('US-010: at most 20 outstanding enrolments per farm', async () => {
  const s = await setup();
  for (let i = 0; i < 20; i++) assert.equal((await issue(s)).statusCode, 201);
  assert.equal((await issue(s)).statusCode, 409);
});

test('US-011: redeeming a token creates a pending node with a permanent identity and a one-time credential', async () => {
  const s = await setup();
  const { token } = (await issue(s, {
    platform: 'ubuntu', display_name: 'UBUNTU-Dell01', intermittent: true, initial_config: { heartbeat_interval_s: 120 },
  })).body;
  const r = await redeem(token, { hostname: 'dell-01-old-name' });
  assert.equal(r.statusCode, 201);
  assert.match(r.body.node_id, /^[0-9a-f-]{36}$/);
  assert.match(r.body.credential, /^fcn_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r.body.farm, { id: s.farm.id, name: 'home' });
  assert.equal(r.body.config.version, 1);
  assert.equal(r.body.config.schema_version, 1);
  assert.equal(r.body.config.heartbeat_interval_s, 120);
  assert.equal(r.body.config.intermittent, true);

  const node = (await db.query('SELECT * FROM nodes WHERE id = $1', [r.body.node_id])).rows[0];
  assert.equal(node.status, 'pending');
  assert.equal(node.display_name, 'UBUNTU-Dell01');
  assert.equal(node.hostname, 'dell-01-old-name');
  assert.equal(node.farm_id, s.farm.id);
  assert.equal(node.org_id, s.op.orgId);

  // Renaming the machine later changes an attribute, never the identity.
  await db.query(`UPDATE nodes SET hostname = 'renamed' WHERE id = $1`, [node.id]);
  assert.equal((await db.query('SELECT id FROM nodes WHERE hostname = $1', ['renamed'])).rows[0].id, r.body.node_id);

  const cfg = (await db.query('SELECT version, config FROM node_configs WHERE node_id = $1', [node.id])).rows;
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].config.heartbeat_interval_s, 120);
});

test('US-011: display name defaults to the hostname; defaults apply when no presets are given', async () => {
  const s = await setup();
  const r = await redeem((await issue(s)).body.token, { hostname: 'macmini' });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.config.heartbeat_interval_s, 60);
  assert.equal((await db.query('SELECT display_name FROM nodes WHERE id = $1', [r.body.node_id])).rows[0].display_name, 'macmini');
});

test('US-011: the credential is stored only as a hash and never appears in any table or audit event', async () => {
  const s = await setup();
  const r = await redeem((await issue(s)).body.token);
  for (const table of ['node_credentials', 'nodes', 'node_configs', 'enrolments', 'audit_events']) {
    const dump = JSON.stringify((await db.query(`SELECT * FROM ${table}`)).rows);
    assert.ok(!dump.includes(r.body.credential), `${table} leaked the credential`);
  }
  const row = (await db.query('SELECT hash, revoked_at FROM node_credentials WHERE node_id = $1', [r.body.node_id])).rows;
  assert.equal(row.length, 1);
  assert.equal(row[0].revoked_at, null);
  assert.match(row[0].hash, /^[0-9a-f]{64}$/);
});

test('US-010: a used token is refused with a clear message and creates nothing', async () => {
  const s = await setup();
  const { token } = (await issue(s)).body;
  assert.equal((await redeem(token)).statusCode, 201);
  const again = await redeem(token);
  assert.equal(again.statusCode, 410);
  assert.equal(again.body.code, 'token_used');
  assert.match(again.body.error, /already been used/);
  assert.equal((await db.query('SELECT count(*) AS n FROM nodes WHERE farm_id = $1', [s.farm.id])).rows[0].n, '1');
});

test('US-010: an expired token is refused with a clear message', async () => {
  const s = await setup();
  const { token, enrolment } = (await issue(s)).body;
  await db.query(`UPDATE enrolments SET expires_at = now() - interval '1 second' WHERE id = $1`, [enrolment.id]);
  const r = await redeem(token);
  assert.equal(r.statusCode, 410);
  assert.equal(r.body.code, 'token_expired');
  assert.match(r.body.error, /expired/);
});

test('US-010: an unknown token gets one generic refusal and nothing about what exists', async () => {
  const r = await redeem('fce_' + 'A'.repeat(32));
  assert.equal(r.statusCode, 401);
  assert.deepEqual(r.body, { code: 'token_invalid', error: 'This enrolment token is not valid.' });
  assert.equal((await redeem('x')).statusCode, 401);
  assert.equal((await call(enrol, { method: 'POST', body: {} })).statusCode, 401);
  assert.equal((await call(enrol, { method: 'GET' })).statusCode, 405);
});

test('US-011: a platform mismatch is refused and does not consume the token', async () => {
  const s = await setup();
  const { token } = (await issue(s, { platform: 'macos' })).body;
  const wrong = await redeem(token, { os: 'ubuntu' });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.body.code, 'platform_mismatch');
  assert.equal((await redeem(token, { os: 'macos' })).statusCode, 201);
});

test('US-010: two simultaneous redemptions of one token: exactly one wins', async () => {
  const s = await setup();
  const { token } = (await issue(s)).body;
  const results = await Promise.all(Array.from({ length: 6 }, () => redeem(token)));
  assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 410 && r.body.code === 'token_used').length, 5);
  assert.equal((await db.query('SELECT count(*) AS n FROM nodes WHERE farm_id = $1', [s.farm.id])).rows[0].n, '1');
  assert.equal((await db.query('SELECT count(*) AS n FROM node_credentials c JOIN nodes n ON n.id = c.node_id WHERE n.farm_id = $1', [s.farm.id])).rows[0].n, '1');
});

test('US-011: oversized enrol requests are refused', async () => {
  const r = await call(enrol, { method: 'POST', body: { token: 'fce_x', os: 'ubuntu', hostname: 'h'.repeat(9000) } });
  assert.equal(r.statusCode, 413);
});

test('US-011: redemption is audited without secrets; the node then shows in its farm as pending', async () => {
  const s = await setup();
  const { token } = (await issue(s, { platform: 'ubuntu', display_name: 'n1' })).body;
  const r = await redeem(token);
  const ev = await audit('enrolment.use', s.op.orgId);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].subject_id, r.body.node_id);
  const nodes = (await call(farmNodes, { cookie: s.cookie, query: { id: s.farm.id } })).body.nodes;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].status, 'pending');
  assert.equal(nodes[0].display_name, 'n1');
});
