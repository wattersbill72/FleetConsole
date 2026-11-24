// The whole chain, for real: the served install.sh downloads the real Go binary from a fake private
// release store through the console's authenticated redirect, verifies its checksum, installs it, and
// the installed binary enrols, heartbeats, reports, and uninstalls, all against the real console handlers.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { db, closePool, call, makeOperator, cookieFrom } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import enrolments from '../build-test/api/farms/[id]/enrolments/index.js';
import enrol from '../build-test/api/enrol.js';
import ingest from '../build-test/api/ingest/snapshot.js';
import ping from '../build-test/api/ingest/ping.js';
import removed from '../build-test/api/ingest/removed.js';
import download from '../build-test/api/agent/download.js';
import installRoute from '../build-test/api/install.js';
import removeNode from '../build-test/api/nodes/[id]/remove.js';

let skip = null, work, binSrc, sums, consoleSrv, ghSrv, base, ghBase, tamper = false;

const adaptRes = (raw) => ({
  setHeader: (k, v) => raw.setHeader(k, v),
  status(c) { raw.statusCode = c; return this; },
  json(b) { raw.setHeader('content-type', 'application/json'); raw.end(JSON.stringify(b)); return this; },
  end(b) { raw.end(b); return this; },
});

before(async () => {
  if (platform() !== 'linux' || arch() !== 'x64') { skip = 'script test targets linux/amd64'; return; }
  try { execFileSync('go', ['version'], { stdio: 'pipe' }); execFileSync('curl', ['--version'], { stdio: 'pipe' }); }
  catch { skip = 'needs go and curl'; return; }

  work = mkdtempSync(join(tmpdir(), 'fleet-install-'));
  binSrc = join(work, 'fleetagent-linux-amd64');
  execFileSync('go', ['build', '-ldflags', '-X main.version=0.0.1-e2e', '-o', binSrc, './cmd/fleetagent'],
    { cwd: join(import.meta.dirname, '..', '..', 'agent'), stdio: 'pipe', env: { ...process.env, CGO_ENABLED: '0' } });
  const hash = createHash('sha256').update(readFileSync(binSrc)).digest('hex');
  sums = `${hash}  fleetagent-linux-amd64\n`;

  // Fake private release store (GitHub): requires the console's token, redirects to a "signed" blob URL.
  ghSrv = createServer((req, res) => {
    const send = (c, b, h = {}) => { res.writeHead(c, { 'content-type': 'application/json', ...h }); res.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b)); };
    if (req.url.startsWith('/blob/')) {
      if (req.headers.authorization) return send(400, { error: 'signed URL must not receive credentials' });
      if (req.url === '/blob/sums') return send(200, tamper ? sums.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) : sums);
      return send(200, readFileSync(binSrc));
    }
    if (req.headers.authorization !== 'Bearer ghp_e2e') return send(401, {});
    if (req.url.startsWith('/repos/o/r/releases')) {
      return send(200, [{ tag_name: 'agent-v0.0.1', draft: false, prerelease: false, assets: [
        { name: 'fleetagent-linux-amd64', url: `${ghBase}/assets/bin` }, { name: 'SHA256SUMS', url: `${ghBase}/assets/sums` }] }]);
    }
    const m = /^\/assets\/(\w+)$/.exec(req.url);
    if (m) return send(302, '', { location: `${ghBase}/blob/${m[1]}` });
    send(404, {});
  });
  await new Promise((r) => ghSrv.listen(0, '127.0.0.1', r));
  ghBase = `http://127.0.0.1:${ghSrv.address().port}`;

  consoleSrv = createServer(async (req, res) => {
    const out = adaptRes(res);
    const u = new URL(req.url, 'http://x');
    req.query = Object.fromEntries(u.searchParams);
    if (u.pathname === '/install.sh') return installRoute(req, out);
    if (u.pathname === '/api/agent/download') return download(req, out);
    if (u.pathname === '/api/ingest/snapshot') return ingest(req, out);
    if (u.pathname === '/api/ingest/ping') return ping(req, out);
    if (u.pathname === '/api/ingest/removed') return removed(req, out);
    if (u.pathname === '/api/enrol') {
      const chunks = []; for await (const c of req) chunks.push(c);
      req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      return enrol(req, out);
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => consoleSrv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${consoleSrv.address().port}`;
  process.env.CONSOLE_URL = base;
  process.env.GITHUB_REPO = 'o/r';
  process.env.GITHUB_RELEASE_TOKEN = 'ghp_e2e';
  process.env.GITHUB_API_URL = ghBase;
});

after(async () => {
  consoleSrv?.close(); ghSrv?.close();
  if (work) rmSync(work, { recursive: true, force: true });
  await closePool();
});

function sh(script, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-s', '--', ...args], { env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(script);
  });
}
function run(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

async function setup() {
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farm = (await call(farms, { method: 'POST', cookie, body: { name: 'home', time_zone: 'UTC' } })).body.farm;
  const issue = async () => (await call(enrolments, { method: 'POST', cookie, query: { id: farm.id }, body: { platform: 'ubuntu', display_name: 'dell01' } })).body.token;
  const paths = (() => {
    const d = mkdtempSync(join(work, 'm-'));
    return { dir: join(d, 'state'), bin: join(d, 'bin', 'fleetagent'), unit: join(d, 'fleetagent.service'), root: d };
  })();
  const flags = ['--dir', paths.dir, '--bin', paths.bin, '--unit', paths.unit, '--no-service', '--no-user'];
  const files = () => [paths.bin, paths.unit, paths.dir].filter(existsSync);
  const fetchScript = async () => (await fetch(`${base}/install.sh`)).text();
  return { op, cookie, farm, issue, paths, flags, files, fetchScript };
}
const nodes = async (farmId) => (await db.query('SELECT * FROM nodes WHERE farm_id = $1', [farmId])).rows;

test('install.sh installs the agent end to end, and the installed agent reports, diagnoses and uninstalls', async (t) => {
  if (skip) return t.skip(skip);
  const s = await setup();
  const token = await s.issue();
  const script = await s.fetchScript();

  const r = await sh(script, ['--token', token, ...s.flags]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Installed\./);
  assert.match(r.out, /Node identity:\s+[0-9a-f-]{36}/);
  assert.match(r.out, /Farm:\s+home/);
  assert.ok(r.out.includes(base));
  assert.match(r.out, /fleetagent uninstall/);
  assert.ok(!r.out.includes('fcn_') && !r.out.includes(token), 'secrets must not be printed');
  assert.deepEqual(s.files().length, 3);

  const [node] = await nodes(s.farm.id);
  assert.equal(node.status, 'pending');
  assert.equal(node.agent_version, '0.0.1-e2e');          // the binary that came through the release store
  assert.equal(node.display_name, 'dell01');
  const unit = readFileSync(s.paths.unit, 'utf8');
  assert.match(unit, /Restart=always/);
  assert.match(unit, /ExecStart=.*fleetagent run --dir .* --log .*logs\/agent\.log/);

  // The installed program works: heartbeat makes the node healthy.
  const hb = await run(s.paths.bin, ['run', '--once', '--dir', s.paths.dir]);
  assert.equal(hb.code, 0, hb.err);
  assert.equal((await nodes(s.farm.id))[0].status, 'healthy');

  // Local diagnostics (US-021).
  const st = await run(s.paths.bin, ['status', ...s.flags]);
  assert.equal(st.code, 0, st.err);
  assert.match(st.out, new RegExp(node.id));
  assert.match(st.out, /Agent version:\s+0\.0\.1-e2e/);
  assert.match(st.out, /Last heartbeat:\s+\d{4}-/);
  assert.match(st.out, /Last error:\s+none/);
  const tst = await run(s.paths.bin, ['test', ...s.flags]);
  assert.equal(tst.code, 0, tst.out + tst.err);
  for (const step of ['Name resolution', 'Console reachable', 'Credential accepted', 'Snapshot accepted']) assert.match(tst.out, new RegExp(`\\[PASS\\] ${step}`));
  const cfg = await run(s.paths.bin, ['config', ...s.flags]);
  assert.match(cfg.out, /"heartbeat_interval_s": 60/);
  assert.ok(!cfg.out.includes('fcn_'));
  const sc = await run(s.paths.bin, ['selfcheck', ...s.flags]);
  assert.equal(sc.code, 0, sc.out + sc.err);
  const help = await run(s.paths.bin, ['help']);
  assert.match(help.out, /fleetagent uninstall/);

  // Re-running the installer on an installed machine reports and changes nothing (the token is already used).
  const before = readFileSync(s.paths.bin);
  const again = await sh(script, ['--token', await s.issue(), ...s.flags]);
  assert.equal(again.code, 0);
  assert.match(again.out, /already installed/);
  assert.deepEqual(readFileSync(s.paths.bin), before);
  assert.equal((await nodes(s.farm.id)).length, 1);

  // Uninstall (US-024): removes everything, tells the console, verifies, and is safe to run twice.
  const un = await run(s.paths.bin, ['uninstall', ...s.flags]);
  assert.equal(un.code, 0, un.out + un.err);
  assert.match(un.out, /Console: notified/);
  assert.match(un.out, /Verified: nothing of the agent remains/);
  assert.deepEqual(s.files(), []);
  const after = (await nodes(s.farm.id)).find((n) => n.id === node.id);
  assert.equal(after.status, 'removed');
  assert.equal((await db.query('SELECT count(*) AS n FROM node_credentials WHERE node_id = $1 AND revoked_at IS NULL', [node.id])).rows[0].n, '0');
  assert.equal((await db.query(`SELECT count(*) AS n FROM audit_events WHERE action = 'node.remove' AND subject_id = $1`, [node.id])).rows[0].n, '1');

  // The binary deleted itself while running; run the remaining checks with a copy.
  const copy = join(s.paths.root, 'copy');
  writeFileSync(copy, readFileSync(binSrc), { mode: 0o755 });
  const second = await run(copy, ['uninstall', ...s.flags]);
  assert.equal(second.code, 0);
  assert.match(second.out, /Nothing is installed/);

  // After local removal the machine can be enrolled again as a new node.
  const re = await sh(script, ['--token', await s.issue(), ...s.flags]);
  assert.equal(re.code, 0, re.err + re.out);
  const all = await nodes(s.farm.id);
  assert.equal(all.length, 2);
  assert.notEqual(all.find((n) => n.status === 'pending').id, node.id);
});

test('install.sh refuses a tampered download and installs nothing; the token stays usable', async (t) => {
  if (skip) return t.skip(skip);
  const s = await setup();
  const token = await s.issue();
  tamper = true;
  const r = await sh(await s.fetchScript(), ['--token', token, ...s.flags]);
  tamper = false;
  assert.notEqual(r.code, 0);
  assert.match(r.err, /checksum mismatch/);
  assert.deepEqual(s.files(), []);
  assert.equal((await nodes(s.farm.id)).length, 0);
  const used = (await db.query('SELECT used_at FROM enrolments WHERE farm_id = $1', [s.farm.id])).rows[0].used_at;
  assert.equal(used, null);
});

test('install.sh with a used, expired or missing token fails clearly and leaves nothing behind', async (t) => {
  if (skip) return t.skip(skip);
  const s = await setup();
  const script = await s.fetchScript();

  const none = await sh(script, [...s.flags]);
  assert.notEqual(none.code, 0);
  assert.match(none.err, /no enrolment token/);

  const bogus = await sh(script, ['--token', 'fce_' + 'A'.repeat(32), ...s.flags]);
  assert.notEqual(bogus.code, 0);
  assert.match(bogus.err, /could not download/);

  // Used: consumed by an earlier enrol, so the download itself is refused.
  const used = await s.issue();
  await call(enrol, { method: 'POST', body: { token: used, os: 'ubuntu', hostname: 'x' } });
  const r = await sh(script, ['--token', used, ...s.flags]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /could not download/);
  assert.deepEqual(s.files(), []);

  // Expired between download and enrol is the installer's own rollback path (covered in Go); here: expired up front.
  const exp = await s.issue();
  await db.query(`UPDATE enrolments SET expires_at = now() - interval '1 second' WHERE farm_id = $1 AND used_at IS NULL`, [s.farm.id]);
  const r2 = await sh(script, ['--token', exp, ...s.flags]);
  assert.notEqual(r2.code, 0);
  assert.deepEqual(s.files(), []);
});

test('the token never appears in any process argument list during an install', async (t) => {
  if (skip) return t.skip(skip);
  const s = await setup();
  const token = await s.issue();
  const script = await s.fetchScript();
  const seen = new Set();
  let polling = true;
  const poll = (async () => {
    while (polling) {
      for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        try { const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); if (cmd.includes(token)) seen.add(cmd.replaceAll('\0', ' ')); } catch { /* process ended */ }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  const r = await sh(script, ['--token', token, ...s.flags]);
  polling = false; await poll;
  assert.equal(r.code, 0, r.err);
  assert.ok(seen.size >= 1, 'the poller must at least have seen the operator\'s own sh command line, or it proves nothing');
  // The only place it may appear is the sh process that was given --token on its own command line by the
  // operator (the documented one-liner). curl and the agent must never carry it.
  const leaks = [...seen].filter((c) => /^(\S*\/)?(curl|fleetagent)\s/.test(c));
  assert.deepEqual(leaks, []);
});

test('US-023 end to end: the console asks, the real agent removes itself and confirms, nothing else on the machine is touched', async (t) => {
  if (skip) return t.skip(skip);
  if (process.getuid() !== 0) return t.skip('direct removal path needs root; the unprivileged path is covered by Go tests with a fake helper');
  const s = await setup();
  const script = await s.fetchScript();
  const r = await sh(script, ['--token', await s.issue(), ...s.flags]);
  assert.equal(r.code, 0, r.err + r.out);
  const [node] = await nodes(s.farm.id);
  assert.equal((await run(s.paths.bin, ['run', '--once', '--dir', s.paths.dir])).code, 0);
  assert.equal((await nodes(s.farm.id))[0].status, 'healthy');

  // Things that are not the agent's: a sibling of the program, and a neighbour of the state directory.
  const bystanderBin = join(s.paths.bin, '..', 'other-tool');
  const bystanderState = join(s.paths.dir, '..', 'someone-elses-data');
  writeFileSync(bystanderBin, 'keep'); writeFileSync(bystanderState, 'keep');

  // The operator removes it: the name must be typed, and history is purged.
  const bad = await call(removeNode, { method: 'POST', cookie: s.cookie, query: { id: node.id }, body: { confirm_name: 'nope', history: 'purge' } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await call(removeNode, { method: 'POST', cookie: s.cookie, query: { id: node.id }, body: { confirm_name: 'dell01', history: 'purge' } })).statusCode, 202);
  assert.equal((await nodes(s.farm.id))[0].status, 'decommissioning');
  assert.equal(s.files().length, 3, 'nothing happens on the machine until the agent hears from the console');

  // Its next heartbeat carries the command; the agent removes itself and says so.
  const out = await run(s.paths.bin, ['run', '--once', '--dir', s.paths.dir, '--bin', s.paths.bin, '--unit', s.paths.unit, '--no-service', '--no-user']);
  assert.equal(out.code, 0, out.err + out.out);
  assert.match(out.out, /remove itself, and it has/);
  assert.match(out.out, /Verified: nothing of the agent remains/);
  assert.deepEqual(s.files(), []);
  assert.ok(existsSync(join(s.paths.dir, '..', 'someone-elses-data')) && readFileSync(bystanderState, 'utf8') === 'keep');
  assert.equal(readFileSync(bystanderBin, 'utf8'), 'keep');
  assert.ok(![join(s.paths.bin, '..', 'fleetagent-maint.path')].some(existsSync));

  // The console agrees: removed by the agent's own confirmation, credential revoked, command settled, history purged.
  const n = (await db.query('SELECT * FROM nodes WHERE id = $1', [node.id])).rows[0];
  assert.deepEqual([n.status, n.removed_via], ['removed', 'agent']);
  assert.deepEqual(n.removal_report, { verified: true, residue: [] });
  assert.equal((await db.query('SELECT count(*) AS n FROM node_credentials WHERE node_id = $1 AND revoked_at IS NULL', [node.id])).rows[0].n, '0');
  assert.equal((await db.query('SELECT status FROM node_commands WHERE node_id = $1', [node.id])).rows[0].status, 'confirmed');
  assert.equal((await db.query('SELECT count(*) AS n FROM snapshots WHERE node_id = $1', [node.id])).rows[0].n, '0');
  const ev = (await db.query(`SELECT detail FROM audit_events WHERE action = 'node.remove' AND subject_id = $1`, [node.id])).rows[0].detail;
  assert.deepEqual([ev.via, ev.history, ev.verified], ['agent-confirmation', 'purged', true]);

  // The machine can be enrolled again as a new node.
  const re = await sh(script, ['--token', await s.issue(), ...s.flags]);
  assert.equal(re.code, 0, re.err + re.out);
  assert.equal((await nodes(s.farm.id)).filter((x) => x.status === 'pending').length, 1);
});
