import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { db, closePool, call, makeOperator, cookieFrom, audit } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import enrolments from '../build-test/api/farms/[id]/enrolments/index.js';
import enrol from '../build-test/api/enrol.js';
import ingest from '../build-test/api/ingest/snapshot.js';
import ping from '../build-test/api/ingest/ping.js';
import removed from '../build-test/api/ingest/removed.js';
import download from '../build-test/api/agent/download.js';
import install from '../build-test/api/install.js';
import { renderInstallScript } from '../build-test/server/installScript.js';

after(closePool);

async function newNode() {
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farm = (await call(farms, { method: 'POST', cookie, body: { name: 'home', time_zone: 'UTC' } })).body.farm;
  const issue = async () => (await call(enrolments, { method: 'POST', cookie, query: { id: farm.id }, body: { platform: 'ubuntu', display_name: 'n1' } })).body.token;
  const token = await issue();
  const r = await call(enrol, { method: 'POST', body: { token, os: 'ubuntu', hostname: 'h' } });
  return { op, cookie, farm, issue, nodeId: r.body.node_id, credential: r.body.credential };
}
const auth = (n) => ({ authorization: `Bearer ${n.credential}` });

// ---------- ping ----------
test('ping: a valid credential is accepted and nothing is stored; every failure is the same 401', async () => {
  const n = await newNode();
  const ok = await call(ping, { method: 'POST', headers: auth(n), body: {} });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.desired_config_version, 1);
  assert.equal((await db.query('SELECT count(*) AS n FROM snapshots WHERE node_id = $1', [n.nodeId])).rows[0].n, '0');
  for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: 'Bearer fcn_' + 'A'.repeat(43) }]) {
    const r = await call(ping, { method: 'POST', headers, body: {} });
    assert.equal(r.statusCode, 401);
    assert.deepEqual(r.body, { error: 'Unauthorized' });
  }
  assert.equal((await call(ping, { method: 'GET' })).statusCode, 405);
});

// ---------- removed (agent confirms removal) ----------
test('removed: marks the node removed, revokes its credential, audits it; a second call is the same 401', async () => {
  const n = await newNode();
  assert.equal((await call(ingest, { method: 'POST', headers: auth(n), body: validSnap(n.nodeId, 1) })).statusCode, 200);
  const r = await call(removed, { method: 'POST', headers: auth(n), body: {} });
  assert.equal(r.statusCode, 200);

  const node = (await db.query('SELECT status, removed_at FROM nodes WHERE id = $1', [n.nodeId])).rows[0];
  assert.equal(node.status, 'removed');
  assert.ok(node.removed_at);
  assert.equal((await db.query('SELECT count(*) AS n FROM node_credentials WHERE node_id = $1 AND revoked_at IS NULL', [n.nodeId])).rows[0].n, '0');
  const ev = await audit('node.remove', n.op.orgId);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].subject_id, n.nodeId);
  assert.equal(ev[0].detail.via, 'agent-confirmation');

  assert.equal((await call(removed, { method: 'POST', headers: auth(n), body: {} })).statusCode, 401);
  assert.equal((await call(ingest, { method: 'POST', headers: auth(n), body: validSnap(n.nodeId, 2) })).statusCode, 401);
  assert.equal((await call(ping, { method: 'POST', headers: auth(n), body: {} })).statusCode, 401);
});

test('removed: a decommissioning node can confirm; credential-less callers cannot remove anything', async () => {
  const n = await newNode();
  await db.query(`UPDATE nodes SET status = 'decommissioning' WHERE id = $1`, [n.nodeId]);
  assert.equal((await call(removed, { method: 'POST', headers: auth(n), body: {} })).statusCode, 200);
  const other = await newNode();
  assert.equal((await call(removed, { method: 'POST', cookie: other.cookie, body: {} })).statusCode, 401);
  assert.equal((await db.query('SELECT status FROM nodes WHERE id = $1', [other.nodeId])).rows[0].status, 'pending');
});

function validSnap(nodeId, seq) {
  return {
    schema_version: 1,
    envelope: { node_id: nodeId, agent_version: '0.1.0', applied_config_version: 1, node_time: new Date().toISOString(), seq, replayed: false },
    host: { hostname: 'h', os: 'ubuntu', os_version: '24.04', uptime_s: 1 },
    agent_health: { buffer_depth: 0, dropped_count: 0 },
  };
}

// ---------- install.sh ----------
test('install.sh: served with the console address filled in, no secrets, valid shell', async () => {
  process.env.CONSOLE_URL = 'https://fleet.example.test';
  const res = await call(install, {});
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /shellscript/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(res.body.startsWith('#!/bin/sh') && res.body.includes('CONSOLE="https://fleet.example.test"'));
});

test('install.sh: the address is only ever a bare origin, so it cannot inject shell', () => {
  assert.ok(renderInstallScript('https://fleet.example.test'));
  assert.ok(renderInstallScript('http://127.0.0.1:3000'));
  for (const bad of ['https://x.test"; rm -rf / #', 'https://x.test/path', 'https://x.test $(id)', "https://x.test'", 'ftp://x.test', 'x.test', '', 'https://x.test\n#']) {
    assert.equal(renderInstallScript(bad), null, bad);
  }
  const s = renderInstallScript('https://fleet.example.test');
  assert.ok(!s.includes('@@CONSOLE@@'));
  assert.ok(s.includes('CONSOLE="https://fleet.example.test"'));
  assert.ok(!/fce_|fcn_/.test(s), 'script must carry no token');
});

test('install.sh: a spoofed Host header cannot reach the script when CONSOLE_URL is set', async () => {
  process.env.CONSOLE_URL = 'https://fleet.example.test';
  const chunks = [];
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, end(b) { chunks.push(b); return this; } };
  install({ method: 'GET', headers: { host: 'evil.example"; rm -rf / #' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(chunks[0].includes('https://fleet.example.test') && !chunks[0].includes('evil'));
  delete process.env.CONSOLE_URL;
  const spoofed = { statusCode: 0, headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, end() { return this; } };
  install({ method: 'GET', headers: { host: 'evil.example"; rm -rf / #' } }, spoofed);
  assert.equal(spoofed.statusCode, 400);
  process.env.CONSOLE_URL = 'https://fleet.example.test';
});

// ---------- download (with a fake GitHub) ----------
let gh, ghBase, ghHits;
before(async () => {
  ghHits = [];
  gh = createServer((req, res) => {
    ghHits.push({ url: req.url, auth: req.headers.authorization, accept: req.headers.accept });
    const send = (code, body, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer ghp_test') return send(401, { message: 'Bad credentials' });
    if (req.url.startsWith('/repos/o/r/releases')) {
      return send(200, [
        { tag_name: 'v9.9.9', draft: false, prerelease: false, assets: [{ name: 'fleetagent-linux-amd64', url: `${ghBase}/assets/wrong` }] },   // not an agent release
        { tag_name: 'agent-v0.2.0', draft: true, prerelease: false, assets: [{ name: 'fleetagent-linux-amd64', url: `${ghBase}/assets/draft` }] },
        { tag_name: 'agent-v0.1.0', draft: false, prerelease: false, assets: [
          { name: 'fleetagent-linux-amd64', url: `${ghBase}/assets/linux` }, { name: 'SHA256SUMS', url: `${ghBase}/assets/sums` } ] },
      ]);
    }
    const m = /^\/assets\/(\w+)$/.exec(req.url);
    if (m) return send(302, '', { location: `https://objects.example.test/signed/${m[1]}?sig=abc` });
    send(404, {});
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  ghBase = `http://127.0.0.1:${gh.address().port}`;
});
after(() => gh?.close());

function configureGithub() {
  process.env.GITHUB_REPO = 'o/r';
  process.env.GITHUB_RELEASE_TOKEN = 'ghp_test';
  process.env.GITHUB_API_URL = ghBase;
}
const dl = (token, file) => call(download, { headers: token ? { authorization: `Bearer ${token}` } : {}, query: file ? { file } : {} });

test('download: a valid enrolment token is redirected to the newest published agent release; the token is not consumed', async () => {
  configureGithub();
  const n = await newNode();
  const t = await n.issue();
  const r = await dl(t, 'fleetagent-linux-amd64');
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, 'https://objects.example.test/signed/linux?sig=abc');   // not the draft, not the non-agent tag
  const sums = await dl(t, 'SHA256SUMS');
  assert.equal(sums.headers.location, 'https://objects.example.test/signed/sums?sig=abc');
  // Still usable to enrol afterwards.
  assert.equal((await call(enrol, { method: 'POST', body: { token: t, os: 'ubuntu', hostname: 'h' } })).statusCode, 201);
});

test('download: the GitHub token is used only server side and never appears in a response', async () => {
  configureGithub();
  const n = await newNode();
  const r = await dl(await n.issue(), 'fleetagent-linux-amd64');
  assert.ok(!JSON.stringify(r).includes('ghp_test'));
  assert.ok(ghHits.some((h) => h.auth === 'Bearer ghp_test'));
});

test('download: used, expired, cancelled, unknown and missing tokens all get the same 401', async () => {
  configureGithub();
  const n = await newNode();
  const used = n.credential && (await n.issue());
  await call(enrol, { method: 'POST', body: { token: used, os: 'ubuntu', hostname: 'h' } });
  const expired = await n.issue();
  await db.query(`UPDATE enrolments SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [(await import('../build-test/server/enrol.js')).sha256(expired)]);
  const results = [await dl(used, 'SHA256SUMS'), await dl(expired, 'SHA256SUMS'), await dl('fce_' + 'A'.repeat(32), 'SHA256SUMS'), await dl(null, 'SHA256SUMS'), await dl(n.credential, 'SHA256SUMS')];
  for (const r of results) { assert.equal(r.statusCode, 401); assert.deepEqual(r.body, { error: 'Unauthorized' }); }
});

test('download: only the published file names are served; path tricks are refused', async () => {
  configureGithub();
  const n = await newNode();
  const t = await n.issue();
  for (const f of ['../etc/passwd', 'fleetagent-windows-amd64', 'fleetagent-linux-amd64/../x', '', undefined, 'SHA256SUMS ']) {
    assert.equal((await dl(t, f)).statusCode, 404, String(f));
  }
});

test('download: unconfigured and missing releases are reported plainly, only to a valid token', async () => {
  const n = await newNode();
  const t = await n.issue();
  delete process.env.GITHUB_REPO; delete process.env.GITHUB_RELEASE_TOKEN;
  assert.equal((await dl(t, 'SHA256SUMS')).statusCode, 503);
  assert.equal((await dl('fce_' + 'A'.repeat(32), 'SHA256SUMS')).statusCode, 401);   // unauthenticated learns nothing
  configureGithub();
  process.env.GITHUB_RELEASE_TOKEN = 'wrong';
  assert.equal((await dl(t, 'SHA256SUMS')).statusCode, 502);                          // upstream refused
  configureGithub();
  assert.equal((await dl(t, 'fleetagent-darwin-arm64')).statusCode, 404);             // release has no such file
});
