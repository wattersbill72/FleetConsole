import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closePool, call, makeOperator, cookieFrom, audit } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import farmById from '../build-test/api/farms/[id].js';

after(closePool);

async function session(op) {
  const res = await call(login, { method: 'POST', body: { username: op.username, password: op.password } });
  return cookieFrom(res);
}
const create = (cookie, body) => call(farms, { method: 'POST', cookie, body });

test('US-002: create a farm with name, description, time zone; it is audited', async () => {
  const op = await makeOperator();
  const cookie = await session(op);
  const res = await create(cookie, { name: '  home-kennewick ', description: 'Garage rack', time_zone: 'America/Los_Angeles' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.farm.name, 'home-kennewick');
  assert.equal(res.body.farm.description, 'Garage rack');
  assert.equal(res.body.farm.time_zone, 'America/Los_Angeles');

  const ev = await audit('farm.create', op.orgId);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].subject_id, res.body.farm.id);
  assert.equal(ev[0].actor_label, op.username);
});

test('US-002: a new org starts with an empty farm list', async () => {
  const op = await makeOperator();
  const res = await call(farms, { cookie: await session(op) });
  assert.deepEqual(res.body, { farms: [] });
});

test('US-002: farm names are unique within an org, ignoring case; another org may reuse a name', async () => {
  const a = await makeOperator(), b = await makeOperator();
  const ca = await session(a), cb = await session(b);
  assert.equal((await create(ca, { name: 'Lab', time_zone: 'UTC' })).statusCode, 201);
  const dup = await create(ca, { name: 'lab', time_zone: 'UTC' });
  assert.equal(dup.statusCode, 409);
  assert.match(dup.body.error, /already exists/);
  assert.equal((await create(cb, { name: 'Lab', time_zone: 'UTC' })).statusCode, 201);
});

test('US-002: validation refuses bad input and writes nothing', async () => {
  const op = await makeOperator();
  const cookie = await session(op);
  for (const body of [
    {}, { name: '', time_zone: 'UTC' }, { name: '   ', time_zone: 'UTC' }, { name: 'x'.repeat(81), time_zone: 'UTC' },
    { name: 'ok', time_zone: 'Mars/Olympus' }, { name: 'ok' }, { name: 'ok', time_zone: 'UTC', description: 'd'.repeat(501) },
    { name: 42, time_zone: 'UTC' },
  ]) {
    assert.equal((await create(cookie, body)).statusCode, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await audit('farm.create', op.orgId)).length, 0);
  assert.deepEqual((await call(farms, { cookie })).body, { farms: [] });
});

test('US-002: rename and edit description keep the same id; changes are audited with before/after', async () => {
  const op = await makeOperator();
  const cookie = await session(op);
  const { farm } = (await create(cookie, { name: 'old', description: 'one', time_zone: 'UTC' })).body;

  const res = await call(farmById, { method: 'PATCH', cookie, query: { id: farm.id }, body: { name: 'new', description: 'two' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.farm.id, farm.id);
  assert.equal(res.body.farm.name, 'new');
  assert.equal(res.body.farm.time_zone, 'UTC');

  const ev = await audit('farm.update', op.orgId);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].detail.changes, { name: { from: 'old', to: 'new' }, description: { from: 'one', to: 'two' } });
});

test('US-002: a no-op edit writes no audit event; renaming onto an existing name is 409', async () => {
  const op = await makeOperator();
  const cookie = await session(op);
  const a = (await create(cookie, { name: 'A', time_zone: 'UTC' })).body.farm;
  await create(cookie, { name: 'B', time_zone: 'UTC' });
  await call(farmById, { method: 'PATCH', cookie, query: { id: a.id }, body: { name: 'A' } });
  assert.equal((await audit('farm.update', op.orgId)).length, 0);
  const clash = await call(farmById, { method: 'PATCH', cookie, query: { id: a.id }, body: { name: 'b' } });
  assert.equal(clash.statusCode, 409);
  assert.equal((await call(farmById, { cookie, query: { id: a.id } })).body.farm.name, 'A');
});

test('US-001/002: another organisation cannot list, read, or edit a farm (404, indistinguishable from missing)', async () => {
  const a = await makeOperator(), b = await makeOperator();
  const ca = await session(a), cb = await session(b);
  const farm = (await create(ca, { name: 'Private', time_zone: 'UTC' })).body.farm;

  assert.deepEqual((await call(farms, { cookie: cb })).body, { farms: [] });
  const get = await call(farmById, { cookie: cb, query: { id: farm.id } });
  const missing = await call(farmById, { cookie: cb, query: { id: '11111111-1111-4111-8111-111111111111' } });
  assert.equal(get.statusCode, 404);
  assert.deepEqual(get.body, missing.body);
  const patch = await call(farmById, { method: 'PATCH', cookie: cb, query: { id: farm.id }, body: { name: 'Hijack' } });
  assert.equal(patch.statusCode, 404);
  assert.equal((await call(farmById, { cookie: ca, query: { id: farm.id } })).body.farm.name, 'Private');
});

test('US-002: malformed ids are 404, not a database error', async () => {
  const op = await makeOperator();
  const res = await call(farmById, { cookie: await session(op), query: { id: "1' OR '1'='1" } });
  assert.equal(res.statusCode, 404);
});

test('audit events carry no secrets: nothing in the trail contains a password or session token', async () => {
  const op = await makeOperator();
  const cookie = await session(op);
  await create(cookie, { name: 'x', time_zone: 'UTC' });
  const rows = JSON.stringify((await db.query('SELECT * FROM audit_events WHERE org_id = $1', [op.orgId])).rows);
  assert.ok(!rows.includes(op.password));
  assert.ok(!rows.includes(cookie.split('=')[1]));
});
