import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closePool, call, makeOperator, cookieFrom, audit } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import logout from '../build-test/api/auth/logout.js';
import me from '../build-test/api/auth/me.js';
import branding from '../build-test/api/branding.js';
import farms from '../build-test/api/farms/index.js';
import farmById from '../build-test/api/farms/[id].js';
import { hashPassword, verifyPassword } from '../build-test/server/auth.js';

after(closePool);

async function signIn(op, password = op.password) {
  return call(login, { method: 'POST', body: { username: op.username, password } });
}

test('password hash round-trips and rejects wrong password', async () => {
  const h = await hashPassword('a long enough password');
  assert.match(h, /^scrypt\$N=16384,r=8,p=1\$/);
  assert.equal(await verifyPassword('a long enough password', h), true);
  assert.equal(await verifyPassword('another password!!', h), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
});

test('US-001: unauthenticated visitor gets nothing from any data route', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const [h, opts] of [
    [me, {}], [farms, {}], [farms, { method: 'POST', body: { name: 'x', time_zone: 'UTC' } }],
    [farmById, { query: { id } }], [farmById, { method: 'PATCH', query: { id }, body: { name: 'y' } }],
    [logout, { method: 'POST' }],
  ]) {
    const res = await call(h, opts);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Not authenticated' });
  }
});

test('US-001: garbage and forged session cookies are refused', async () => {
  const res = await call(me, { cookie: 'fc_session=' + 'a'.repeat(64) });
  assert.equal(res.statusCode, 401);
});

test('US-001: sign-in succeeds, sets an HttpOnly cookie, is audited', async () => {
  const op = await makeOperator();
  const res = await signIn(op);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['set-cookie'], /fc_session=[0-9a-f]{64}/);
  assert.match(res.headers['set-cookie'], /HttpOnly/);
  assert.match(res.headers['set-cookie'], /SameSite=Lax/);

  const who = await call(me, { cookie: cookieFrom(res) });
  assert.equal(who.statusCode, 200);
  assert.equal(who.body.user.username, op.username);
  assert.equal(who.body.org.productName, 'Fleet Console');

  const events = await audit('auth.sign_in', op.orgId);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'success');
  assert.equal(events[0].actor_user_id, op.userId);
});

test('US-001: the raw session token is never stored', async () => {
  const op = await makeOperator();
  const res = await signIn(op);
  const token = cookieFrom(res).split('=')[1];
  const stored = await db.query('SELECT token_hash FROM sessions WHERE user_id = $1', [op.userId]);
  assert.equal(stored.rows.length, 1);
  assert.notEqual(stored.rows[0].token_hash, token);
});

test('US-001: wrong password and unknown user are indistinguishable; failures audited without the attempted name', async () => {
  const op = await makeOperator();
  const wrong = await signIn(op, 'definitely not the password');
  const unknown = await call(login, { method: 'POST', body: { username: 'nobody-here', password: 'whatever it is' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.headers['set-cookie'], undefined);

  const events = await audit('auth.sign_in', op.orgId);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'failure');
  const orphan = await db.query(`SELECT * FROM audit_events WHERE action='auth.sign_in' AND org_id IS NULL AND actor_label='unknown'`);
  assert.ok(orphan.rows.length >= 1);
  assert.ok(!JSON.stringify(orphan.rows).includes('nobody-here'));
});

test('US-001: five failures lock the username, and a correct password does not bypass the lock', async () => {
  const op = await makeOperator();
  for (let i = 0; i < 5; i++) assert.equal((await signIn(op, 'wrong password #' + i)).statusCode, 401);
  const locked = await signIn(op);
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.headers['set-cookie'], undefined);
});

test('US-001: a session idle past the limit is refused; activity within it is accepted', async () => {
  const op = await makeOperator();
  const cookie = cookieFrom(await signIn(op));
  assert.equal((await call(me, { cookie })).statusCode, 200);

  await db.query(`UPDATE sessions SET last_active_at = now() - interval '9 hours' WHERE user_id = $1`, [op.userId]);
  assert.equal((await call(me, { cookie })).statusCode, 401);
});

test('US-001: a session past its absolute lifetime is refused', async () => {
  const op = await makeOperator();
  const cookie = cookieFrom(await signIn(op));
  await db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [op.userId]);
  assert.equal((await call(me, { cookie })).statusCode, 401);
});

test('US-001: activity is stamped (sliding idle window) once stale by a minute', async () => {
  const op = await makeOperator();
  const cookie = cookieFrom(await signIn(op));
  await db.query(`UPDATE sessions SET last_active_at = now() - interval '2 hours' WHERE user_id = $1`, [op.userId]);
  assert.equal((await call(me, { cookie })).statusCode, 200);
  const r = await db.query(`SELECT last_active_at > now() - interval '1 minute' AS fresh FROM sessions WHERE user_id = $1`, [op.userId]);
  assert.equal(r.rows[0].fresh, true);
});

test('US-001: sign-out kills the session, clears the cookie, and is audited', async () => {
  const op = await makeOperator();
  const cookie = cookieFrom(await signIn(op));
  const out = await call(logout, { method: 'POST', cookie });
  assert.equal(out.statusCode, 200);
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await call(me, { cookie })).statusCode, 401);
  assert.equal((await audit('auth.sign_out', op.orgId)).length, 1);
});

test('US-001: a disabled user cannot sign in and an existing session stops working', async () => {
  const op = await makeOperator();
  const cookie = cookieFrom(await signIn(op));
  await db.query('UPDATE users SET disabled_at = now() WHERE id = $1', [op.userId]);
  assert.equal((await call(me, { cookie })).statusCode, 401);
  assert.equal((await signIn(op)).statusCode, 401);
});

test('US-001: state-changing request from another origin is refused', async () => {
  const op = await makeOperator();
  const cookie = cookieFrom(await signIn(op));
  const res = await call(farms, {
    method: 'POST', cookie, headers: { origin: 'https://evil.example' },
    body: { name: 'Sneaky', time_zone: 'UTC' },
  });
  assert.equal(res.statusCode, 403);
  const ok = await call(farms, {
    method: 'POST', cookie, headers: { origin: 'https://console.test' },
    body: { name: 'Fine', time_zone: 'UTC' },
  });
  assert.equal(ok.statusCode, 201);
});

test('US-001: sign-in screen branding is public and reveals only the product name', async () => {
  const res = await call(branding);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body), ['productName']);
});
