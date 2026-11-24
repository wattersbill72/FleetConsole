import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closePool, call, makeOperator, cookieFrom, audit } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import farmNodes from '../build-test/api/farms/[id]/nodes.js';
import enrolments from '../build-test/api/farms/[id]/enrolments/index.js';
import enrol from '../build-test/api/enrol.js';
import ingest from '../build-test/api/ingest/snapshot.js';
import removed from '../build-test/api/ingest/removed.js';
import removeNode from '../build-test/api/nodes/[id]/remove.js';
import markRemoved from '../build-test/api/nodes/[id]/mark-removed.js';
import overview from '../build-test/api/overview.js';
import cron from '../build-test/api/cron/evaluate.js';
import { evaluateStaleness } from '../build-test/server/evaluate.js';
import { expireDecommissions, DECOMMISSION_TIMEOUT_MINUTES } from '../build-test/server/decommission.js';
import { deliverDue } from '../build-test/server/notify/deliver.js';
import { renderAlert } from '../build-test/server/notify/render.js';

after(closePool);

async function org() {
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farm = (await call(farms, { method: 'POST', cookie, body: { name: 'home', time_zone: 'UTC' } })).body.farm;
  return { op, cookie, farm };
}
async function node(o, name = 'UBUNTU-Dell01') {
  const token = (await call(enrolments, { method: 'POST', cookie: o.cookie, query: { id: o.farm.id }, body: { platform: 'ubuntu', display_name: name } })).body.token;
  const r = await call(enrol, { method: 'POST', body: { token, os: 'ubuntu', hostname: 'h' } });
  return { id: r.body.node_id, credential: r.body.credential, name };
}
let seq = 100;
const snap = (nd, extra = {}) => ({
  schema_version: 1,
  envelope: { node_id: nd.id, agent_version: '0.1.0', applied_config_version: 1, node_time: new Date().toISOString(), seq: ++seq, replayed: false },
  host: { hostname: 'h', os: 'ubuntu', os_version: '24.04', uptime_s: 5, cpu_pct: 3 },
  agent_health: { buffer_depth: 0, dropped_count: 0, ...extra },
});
const beat = (nd, extra) => call(ingest, { method: 'POST', headers: { authorization: `Bearer ${nd.credential}` }, body: snap(nd, extra) });
const remove = (o, nd, body, cookie = o.cookie) => call(removeNode, { method: 'POST', cookie, query: { id: nd.id }, body });
const row = async (id) => (await db.query('SELECT * FROM nodes WHERE id = $1', [id])).rows[0];
const cmds = async (id) => (await db.query('SELECT * FROM node_commands WHERE node_id = $1 ORDER BY id', [id])).rows;
const confirm = (nd, body = { verified: true, residue: [] }) => call(removed, { method: 'POST', headers: { authorization: `Bearer ${nd.credential}` }, body });

test('US-023: removal needs the node\'s name typed exactly and a history choice; nothing changes on a refusal', async () => {
  const o = await org(), nd = await node(o);
  for (const body of [{}, { history: 'keep' }, { confirm_name: 'ubuntu-dell01', history: 'keep' }, { confirm_name: 'UBUNTU-Dell01' }, { confirm_name: 'UBUNTU-Dell01', history: 'maybe' }, { confirm_name: '', history: 'keep' }]) {
    assert.equal((await remove(o, nd, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await row(nd.id)).status, 'pending');
  assert.deepEqual(await cmds(nd.id), []);
  assert.equal((await audit('node.decommission.request', o.op.orgId)).length, 0);
});

test('US-023: a confirmed request moves the node to decommissioning, queues the command, and is audited', async () => {
  const o = await org(), nd = await node(o);
  await beat(nd);
  const r = await remove(o, nd, { confirm_name: ' UBUNTU-Dell01 ', history: 'purge' });
  assert.equal(r.statusCode, 202);
  assert.deepEqual([r.body.status, r.body.already_requested], ['decommissioning', false]);
  const n = await row(nd.id);
  assert.equal(n.status, 'decommissioning'); assert.equal(n.decommission_purge, true); assert.ok(n.decommission_requested_at);
  const c = await cmds(nd.id);
  assert.equal(c.length, 1); assert.deepEqual([c[0].command, c[0].status], ['decommission', 'queued']);
  const ev = await audit('node.decommission.request', o.op.orgId);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].actor_label, ev[0].subject_label, ev[0].detail.history], [o.op.username, 'UBUNTU-Dell01', 'purge']);
  // Repeating the request is harmless: still one command, one audit event.
  const again = await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'purge' });
  assert.equal(again.body.already_requested, true);
  assert.equal((await cmds(nd.id)).length, 1);
  assert.equal((await audit('node.decommission.request', o.op.orgId)).length, 1);
});

test('US-023: only the owning organisation can remove a node; unauthenticated and malformed requests are refused', async () => {
  const a = await org(), b = await org(), nd = await node(a);
  assert.equal((await remove(b, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' }, b.cookie)).statusCode, 404);
  assert.equal((await call(removeNode, { method: 'POST', query: { id: nd.id }, body: { confirm_name: 'x', history: 'keep' } })).statusCode, 401);
  assert.equal((await call(removeNode, { method: 'POST', cookie: a.cookie, query: { id: 'nope' }, body: {} })).statusCode, 404);
  assert.equal((await call(removeNode, { method: 'GET', cookie: a.cookie, query: { id: nd.id } })).statusCode, 405);
  assert.equal((await call(markRemoved, { method: 'POST', cookie: b.cookie, query: { id: nd.id }, body: { confirm_name: 'UBUNTU-Dell01', history: 'keep' } })).statusCode, 404);
  assert.equal((await row(nd.id)).status, 'pending');
});

test('US-023: the next heartbeat carries the decommission command, repeated until the agent settles it; the node is not revived', async () => {
  const o = await org(), nd = await node(o), other = await node(o, 'other');
  await beat(nd);
  assert.deepEqual((await beat(nd)).body.commands, []);
  await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  const hb = await beat(nd);
  assert.equal(hb.statusCode, 200);
  assert.equal(hb.body.commands.length, 1);
  assert.equal(hb.body.commands[0].command, 'decommission');
  assert.match(hb.body.commands[0].id, /^\d+$/);
  assert.equal((await beat(nd)).body.commands.length, 1);                 // still pending: delivered again
  assert.equal((await cmds(nd.id))[0].status, 'delivered');
  assert.equal((await row(nd.id)).status, 'decommissioning');            // live Snapshots never overwrite it
  assert.deepEqual((await beat(other)).body.commands, []);               // commands are per node
});

test('US-023: when the agent reports it could not remove itself, the reason is recorded and shown; the operator can ask again', async () => {
  const o = await org(), nd = await node(o);
  await beat(nd);
  await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  await beat(nd);
  const failed = await beat(nd, { last_command_result: { command: 'decommission', ok: false, reason: 'the maintenance helper did not respond' } });
  assert.deepEqual(failed.body.commands, [], 'a failed command is not sent again');
  assert.deepEqual([(await cmds(nd.id))[0].status, (await cmds(nd.id))[0].result], ['failed', 'the maintenance helper did not respond']);
  const listed = (await call(farmNodes, { cookie: o.cookie, query: { id: o.farm.id } })).body.nodes[0];
  assert.equal(listed.removal_error, 'the maintenance helper did not respond');
  const ov = (await call(overview, { cookie: o.cookie })).body.farms[0].nodes[0];
  assert.deepEqual([ov.status, ov.removal_error], ['decommissioning', 'the maintenance helper did not respond']);

  const retry = await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  assert.equal(retry.body.already_requested, false);
  assert.equal((await beat(nd)).body.commands.length, 1);
  assert.equal((await cmds(nd.id)).length, 2);
});

test('US-023: the agent\'s confirmation marks the node removed, revokes its credential, settles the command, records its verification', async () => {
  const o = await org(), nd = await node(o);
  await beat(nd);
  await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  await beat(nd);
  const r = await confirm(nd);
  assert.equal(r.statusCode, 200);
  const n = await row(nd.id);
  assert.deepEqual([n.status, n.removed_via], ['removed', 'agent']);
  assert.ok(n.removed_at);
  assert.deepEqual(n.removal_report, { verified: true, residue: [] });
  assert.equal((await cmds(nd.id))[0].status, 'confirmed');
  assert.equal((await db.query('SELECT count(*) AS n FROM node_credentials WHERE node_id = $1 AND revoked_at IS NULL', [nd.id])).rows[0].n, '0');
  const ev = (await audit('node.remove', o.op.orgId))[0];
  assert.deepEqual([ev.detail.via, ev.detail.history, ev.detail.verified, ev.detail.residue], ['agent-confirmation', 'kept', true, []]);
  assert.equal((await confirm(nd)).statusCode, 401);                      // a second confirmation is the same refusal as any revoked credential
  assert.equal((await beat(nd)).statusCode, 401);
  assert.deepEqual((await call(farmNodes, { cookie: o.cookie, query: { id: o.farm.id } })).body.nodes, []);   // not listed once removed
  assert.equal((await call(overview, { cookie: o.cookie })).body.summary.nodes_total, 0);
});

test('US-023: history is kept by default and purged when the operator chose to; the name, alerts and audit trail always remain', async () => {
  const o = await org(), keep = await node(o, 'keeper'), purge = await node(o, 'goner');
  for (const nd of [keep, purge]) { await beat(nd); await beat(nd); }
  await remove(o, keep, { confirm_name: 'keeper', history: 'keep' });
  await remove(o, purge, { confirm_name: 'goner', history: 'purge' });
  await confirm(keep); await confirm(purge);
  const count = async (id) => Number((await db.query('SELECT count(*) AS n FROM snapshots WHERE node_id = $1', [id])).rows[0].n);
  assert.equal(await count(keep.id), 2);
  assert.equal(await count(purge.id), 0);
  assert.equal((await db.query('SELECT count(*) AS n FROM node_configs WHERE node_id = $1', [purge.id])).rows[0].n, '0');
  assert.equal((await db.query('SELECT count(*) AS n FROM node_configs WHERE node_id = $1', [keep.id])).rows[0].n, '1');
  const p = await row(purge.id);
  assert.deepEqual([p.display_name, p.status, p.latest, p.hostname], ['goner', 'removed', null, null]);
  assert.equal((await audit('node.remove', o.op.orgId)).length, 2);       // the trail survives a purge
});

test('US-023: a verification that found leftovers is recorded, not hidden', async () => {
  const o = await org(), nd = await node(o);
  await beat(nd);
  await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  await confirm(nd, { verified: false, residue: ['/var/lib/fleetagent', 'user fleetagent'] });
  const ev = (await audit('node.remove', o.op.orgId))[0];
  assert.deepEqual([ev.detail.verified, ev.detail.residue], [false, ['/var/lib/fleetagent', 'user fleetagent']]);
});

test('US-023: removal closes the node\'s open alerts and leaves no stale alert behind', async () => {
  const o = await org(), nd = await node(o);
  await beat(nd);
  await db.query(`UPDATE nodes SET last_heartbeat_at = now() - interval '20 minutes' WHERE id = $1`, [nd.id]);
  await evaluateStaleness();
  assert.equal((await db.query(`SELECT count(*) AS n FROM alerts WHERE org_id = $1 AND closed_at IS NULL`, [o.op.orgId])).rows[0].n, '1');
  await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  await evaluateStaleness();                                              // a decommissioning node raises no new stale alert
  await confirm(nd);
  assert.equal((await db.query(`SELECT count(*) AS n FROM alerts WHERE org_id = $1 AND closed_at IS NULL`, [o.op.orgId])).rows[0].n, '0');
});

// ---- the agent never confirms ----
test('US-023: if the node does not confirm in time the credential is revoked anyway, the console says so, and an alert tells the operator', async () => {
  const o = await org(), nd = await node(o);
  await beat(nd);
  await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });

  await db.query(`UPDATE nodes SET decommission_requested_at = now() - make_interval(mins => $2) WHERE id = $1`, [nd.id, DECOMMISSION_TIMEOUT_MINUTES - 1]);
  assert.equal(await expireDecommissions(), 0, 'not before the time is up');
  assert.equal((await beat(nd)).statusCode, 200);

  await db.query(`UPDATE nodes SET decommission_requested_at = now() - make_interval(mins => $2) WHERE id = $1`, [nd.id, DECOMMISSION_TIMEOUT_MINUTES + 1]);
  assert.equal(await expireDecommissions(), 1);
  assert.equal(await expireDecommissions(), 0, 'only once');
  const n = await row(nd.id);
  assert.equal(n.status, 'decommissioning');                              // never `removed` without the agent's word or the operator's
  assert.ok(n.decommission_unconfirmed_at);
  assert.equal((await cmds(nd.id))[0].status, 'expired');
  assert.equal((await beat(nd)).statusCode, 401);                         // credential revoked anyway
  assert.equal((await audit('node.decommission.timeout', o.op.orgId)).length, 1);

  const ov = (await call(overview, { cookie: o.cookie })).body.farms[0].nodes[0];
  assert.deepEqual([ov.status, ov.decommission_unconfirmed], ['decommissioning', true]);

  const [alert] = (await db.query(`SELECT * FROM alerts WHERE org_id = $1 AND rule = 'removal_unconfirmed' AND closed_at IS NULL`, [o.op.orgId])).rows;
  assert.ok(alert);
  assert.equal(alert.subject_label, 'UBUNTU-Dell01');
  assert.equal((await db.query(`SELECT count(*) AS n FROM notifications WHERE alert_event_id IN (SELECT id FROM alert_events WHERE alert_id = $1)`, [alert.id])).rows[0].n, '1');
  await evaluateStaleness();
  assert.equal((await db.query(`SELECT count(*) AS n FROM alerts WHERE org_id = $1 AND rule = 'node_stale'`, [o.op.orgId])).rows[0].n, '0');

  // Asking again cannot help; the message says what will.
  const again = await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  assert.equal(again.statusCode, 409);
  assert.match(again.body.error, /sudo fleetagent uninstall/);

  // The operator finishes it by marking the node removed.
  const m = await call(markRemoved, { method: 'POST', cookie: o.cookie, query: { id: nd.id }, body: { confirm_name: 'UBUNTU-Dell01', history: 'keep' } });
  assert.equal(m.statusCode, 200);
  assert.deepEqual([(await row(nd.id)).status, (await row(nd.id)).removed_via], ['removed', 'operator']);
  assert.equal((await db.query(`SELECT count(*) AS n FROM alerts WHERE org_id = $1 AND closed_at IS NULL`, [o.op.orgId])).rows[0].n, '0');
  assert.equal((await audit('node.remove', o.op.orgId))[0].detail.via, 'operator');
});

test('the unconfirmed-removal email tells the operator what to run', () => {
  const alert = { id: 'a', rule: 'removal_unconfirmed', subject_label: 'UBUNTU-Dell01', farm_name: 'home', farm_time_zone: 'UTC',
    opened_at: new Date('2026-11-24T18:00:00Z'), silent_since: null, closed_at: null, duration_s: null, outage_s: null, detail: { minutes: 15 } };
  const r = renderAlert({ productName: 'Fleet Console', kind: 'alert_open', alert, link: null });
  assert.equal(r.subject, '[Fleet Console] ALERT: UBUNTU-Dell01 removal was not confirmed');
  assert.match(r.text, /did not confirm within 15 minutes/);
  assert.match(r.text, /sudo fleetagent uninstall/);
  assert.match(renderAlert({ productName: 'Fleet Console', kind: 'alert_close', alert: { ...alert, closed_at: new Date() }, link: null }).subject, /RESOLVED: UBUNTU-Dell01 is now marked removed/);
});

// ---- operator marks a node removed ----
test('US-024: the operator can mark a node removed: confirmation required, credential revoked, commands cancelled, audited', async () => {
  const o = await org(), nd = await node(o);
  await beat(nd);
  await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  const mark = (body) => call(markRemoved, { method: 'POST', cookie: o.cookie, query: { id: nd.id }, body });
  assert.equal((await mark({ history: 'keep' })).statusCode, 400);
  assert.equal((await mark({ confirm_name: 'wrong', history: 'keep' })).statusCode, 400);
  assert.equal((await mark({ confirm_name: 'UBUNTU-Dell01' })).statusCode, 400);
  assert.equal((await row(nd.id)).status, 'decommissioning');
  assert.equal((await mark({ confirm_name: 'UBUNTU-Dell01', history: 'purge' })).statusCode, 200);
  assert.deepEqual([(await row(nd.id)).status, (await cmds(nd.id))[0].status], ['removed', 'cancelled']);
  assert.equal((await beat(nd)).statusCode, 401);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM snapshots WHERE node_id = $1', [nd.id])).rows[0].n), 0);
  assert.equal((await mark({ confirm_name: 'UBUNTU-Dell01', history: 'keep' })).statusCode, 409);
});

test('US-024: a stale node whose machine is gone can be marked removed without ever having been asked to uninstall', async () => {
  const o = await org(), nd = await node(o);
  await beat(nd);
  await db.query(`UPDATE nodes SET last_heartbeat_at = now() - interval '3 days' WHERE id = $1`, [nd.id]);
  await evaluateStaleness();
  assert.equal((await row(nd.id)).status, 'stale');
  assert.equal((await call(markRemoved, { method: 'POST', cookie: o.cookie, query: { id: nd.id }, body: { confirm_name: 'UBUNTU-Dell01', history: 'keep' } })).statusCode, 200);
  assert.equal((await db.query(`SELECT count(*) AS n FROM alerts WHERE org_id = $1 AND closed_at IS NULL`, [o.op.orgId])).rows[0].n, '0');
});

test('the cron run expires overdue removals and reports it', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  const o = await org(), nd = await node(o);
  await beat(nd);
  await remove(o, nd, { confirm_name: 'UBUNTU-Dell01', history: 'keep' });
  await db.query(`UPDATE nodes SET decommission_requested_at = now() - interval '1 hour' WHERE id = $1`, [nd.id]);
  const r = await call(cron, { headers: { authorization: 'Bearer cron-secret' } });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.decommissionsExpired >= 1);
  assert.ok((await row(nd.id)).decommission_unconfirmed_at);
  await deliverDue(50);
  delete process.env.CRON_SECRET;
});
