// Contract test across languages: the real Go agent binary against the real console handlers.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { db, closePool, call, makeOperator, cookieFrom } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import enrolments from '../build-test/api/farms/[id]/enrolments/index.js';
import enrol from '../build-test/api/enrol.js';
import ingest from '../build-test/api/ingest/snapshot.js';

const run = promisify(execFile);
let goOk = true, bin, work, server, base;

function adaptRes(raw) {
  return {
    setHeader: (k, v) => raw.setHeader(k, v),
    status(c) { raw.statusCode = c; return this; },
    json(b) { raw.setHeader('content-type', 'application/json'); raw.end(JSON.stringify(b)); return this; },
  };
}

before(async () => {
  try {
    execFileSync('go', ['version'], { stdio: 'pipe' });
  } catch { goOk = false; return; }
  work = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  bin = join(work, 'fleetagent');
  execFileSync('go', ['build', '-o', bin, './cmd/fleetagent'], { cwd: join(import.meta.dirname, '..', '..', 'agent'), stdio: 'pipe' });

  server = createServer(async (req, res) => {
    const out = adaptRes(res);
    if (req.url === '/api/enrol') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      return enrol(req, out);
    }
    if (req.url === '/api/ingest/snapshot') return ingest(req, out);   // raw stream, as in production
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (work) rmSync(work, { recursive: true, force: true });
  await closePool();
});

async function agent(args, env = {}) {
  try {
    const r = await run(bin, args, { env: { ...process.env, ...env } });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    return { code: e.code, out: e.stdout, err: e.stderr };
  }
}

test('the Go agent enrols, heartbeats and is accepted by the console', async (t) => {
  if (!goOk) return t.skip('go toolchain not available');
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farm = (await call(farms, { method: 'POST', cookie, body: { name: 'home', time_zone: 'UTC' } })).body.farm;
  const issue = async () => (await call(enrolments, { method: 'POST', cookie, query: { id: farm.id }, body: { platform: 'ubuntu', display_name: 'e2e-node', initial_config: { heartbeat_interval_s: 90 } } })).body.token;
  const token = await issue();
  const dir = join(work, 'state');

  // Enrol. The token travels in the environment, not the process list.
  const en = await agent(['enrol', '--console', base, '--dir', dir], { FLEETAGENT_TOKEN: token });
  assert.equal(en.code, 0, en.err);
  assert.match(en.out, /Enrolled\. node [0-9a-f-]{36}, farm home/);
  assert.ok(!en.out.includes('fcn_'), 'credential must never be printed');

  const node = (await db.query(`SELECT * FROM nodes WHERE farm_id = $1`, [farm.id])).rows[0];
  assert.equal(node.status, 'pending');
  assert.equal(node.display_name, 'e2e-node');
  assert.match(node.os_version, /^24\.04/); // real /etc/os-release of the test machine
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'credential')).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).heartbeat_interval_s === 90);

  // First heartbeat: node becomes healthy with real vitals.
  const hb = await agent(['run', '--once', '--dir', dir]);
  assert.equal(hb.code, 0, hb.err);
  const after1 = (await db.query('SELECT * FROM nodes WHERE id = $1', [node.id])).rows[0];
  assert.equal(after1.status, 'healthy');
  assert.equal(Number(after1.last_seq), 1);
  const s1 = (await db.query('SELECT * FROM snapshots WHERE node_id = $1', [node.id])).rows[0];
  assert.ok(s1.cpu_pct >= 0 && s1.cpu_pct <= 100);
  assert.ok(Number(s1.mem_total_bytes) > 0 && Number(s1.mem_used_bytes) > 0);
  assert.ok(s1.disk_worst_pct > 0 && s1.disk_worst_pct <= 100);
  assert.ok(Number(s1.uptime_s) > 0);
  assert.equal(s1.config_version, 1);
  assert.equal(s1.replayed, false);

  // Sequence continues across process restarts; each run is a new process.
  await agent(['run', '--once', '--dir', dir]);
  await agent(['run', '--once', '--dir', dir]);
  const seqs = (await db.query('SELECT seq FROM snapshots WHERE node_id = $1 ORDER BY seq', [node.id])).rows.map((r) => Number(r.seq));
  assert.deepEqual(seqs, [1, 2, 3]);

  // The same token cannot enrol a second machine; the message reaches the operator at the terminal.
  const again = await agent(['enrol', '--console', base, '--dir', join(work, 'state2')], { FLEETAGENT_TOKEN: token });
  assert.notEqual(again.code, 0);
  assert.match(again.err, /already been used/);

  // A machine that is already enrolled refuses to enrol again and changes nothing.
  const fresh = await issue();
  const twice = await agent(['enrol', '--console', base, '--dir', dir], { FLEETAGENT_TOKEN: fresh });
  assert.notEqual(twice.code, 0);
  assert.match(twice.err, /already enrolled/);
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM nodes WHERE farm_id = $1`, [farm.id])).rows[0].n), 1);

  // Revocation: the very next heartbeat is refused and the agent says why.
  await db.query('UPDATE node_credentials SET revoked_at = now() WHERE node_id = $1', [node.id]);
  const revoked = await agent(['run', '--once', '--dir', dir]);
  assert.notEqual(revoked.code, 0);
  assert.match(revoked.err, /credential rejected/);
});

test('the agent refuses to run when its state is readable by other users', async (t) => {
  if (!goOk) return t.skip('go toolchain not available');
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farm = (await call(farms, { method: 'POST', cookie, body: { name: 'home', time_zone: 'UTC' } })).body.farm;
  const token = (await call(enrolments, { method: 'POST', cookie, query: { id: farm.id }, body: { platform: 'ubuntu' } })).body.token;
  const dir = join(work, 'perm');
  assert.equal((await agent(['enrol', '--console', base, '--dir', dir], { FLEETAGENT_TOKEN: token })).code, 0);
  execFileSync('chmod', ['644', join(dir, 'credential')]);
  const r = await agent(['run', '--once', '--dir', dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /refusing to run/);
});

test('plain-http consoles other than loopback are refused by the agent', async (t) => {
  if (!goOk) return t.skip('go toolchain not available');
  const r = await agent(['enrol', '--console', 'http://console.example.com', '--dir', join(work, 'x')], { FLEETAGENT_TOKEN: 'fce_x' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /must be https/);
});
