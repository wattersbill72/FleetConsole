import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { db, closePool, call, makeOperator, cookieFrom } from './helpers.mjs';
import login from '../build-test/api/auth/login.js';
import farms from '../build-test/api/farms/index.js';
import ingest from '../build-test/api/ingest/snapshot.js';
import enrolments from '../build-test/api/farms/[id]/enrolments/index.js';
import enrol from '../build-test/api/enrol.js';
import alertsRoute from '../build-test/api/alerts.js';
import notifications from '../build-test/api/notifications/index.js';
import targets from '../build-test/api/notifications/targets/index.js';
import targetById from '../build-test/api/notifications/targets/[id].js';
import testRoute from '../build-test/api/notifications/test.js';
import retryRoute from '../build-test/api/notifications/retry.js';
import cron from '../build-test/api/cron/evaluate.js';
import { evaluateStaleness } from '../build-test/server/evaluate.js';
import { deliverDue, MAX_ATTEMPTS } from '../build-test/server/notify/deliver.js';
import { registerChannel } from '../build-test/server/notify/channels.js';
import { signV4 } from '../build-test/server/notify/sigv4.js';
import { renderAlert, formatDuration } from '../build-test/server/notify/render.js';

after(closePool);

// ---------- SigV4 against AWS's published test vector ----------
test('SigV4 reproduces the signature in AWS\'s published "get-vanilla" test vector', () => {
  const h = signV4({
    method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service', headers: {}, body: '',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(
    h.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, ' +
    'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

// ---------- fake SES ----------
let ses, sesBase, sesCalls, sesBehaviour;
before(async () => {
  sesCalls = [];
  sesBehaviour = () => ({ status: 200, body: { MessageId: 'msg-' + (sesCalls.length) } });
  ses = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    sesCalls.push({ url: req.url, headers: req.headers, body });
    const b = sesBehaviour(sesCalls.length);
    res.writeHead(b.status, { 'content-type': 'application/json', ...(b.headers ?? {}) });
    res.end(JSON.stringify(b.body));
  });
  await new Promise((r) => ses.listen(0, '127.0.0.1', r));
  sesBase = `http://127.0.0.1:${ses.address().port}`;
});
after(() => ses?.close());

function configureSes() {
  process.env.SES_REGION = 'us-west-2'; process.env.SES_ACCESS_KEY_ID = 'AKIATESTKEY'; process.env.SES_SECRET_ACCESS_KEY = 'test-secret';
  process.env.SES_FROM = 'alerts@fleet.example.test'; process.env.SES_ENDPOINT = sesBase; process.env.CONSOLE_URL = 'https://fleet.example.test';
}
beforeEach(() => {
  configureSes();
  sesCalls.length = 0;
  sesBehaviour = () => ({ status: 200, body: { MessageId: 'msg-' + sesCalls.length } });
});

async function org() {
  const op = await makeOperator();
  const cookie = cookieFrom(await call(login, { method: 'POST', body: { username: op.username, password: op.password } }));
  const farm = (await call(farms, { method: 'POST', cookie, body: { name: 'home-kennewick', time_zone: 'America/Los_Angeles' } })).body.farm;
  return { op, cookie, farm };
}
const addTarget = (o, address) => call(targets, { method: 'POST', cookie: o.cookie, body: { channel: 'email', address } });
let n = 0;
async function silentNode(o, name, secs = 500) {
  n++;
  const nd = (await db.query(
    `INSERT INTO nodes (org_id, farm_id, display_name, platform, status, last_heartbeat_at, applied_config_version)
     VALUES ($1,$2,$3,'ubuntu','healthy', now() - make_interval(secs => $4), 1) RETURNING id`, [o.op.orgId, o.farm.id, name, secs])).rows[0];
  await db.query(`INSERT INTO node_configs (node_id, version, config, created_by) VALUES ($1,1,$2,'t')`, [nd.id, JSON.stringify({ schema_version: 1, version: 1, heartbeat_interval_s: 60 })]);
  return nd.id;
}
const notes = async (orgId) => (await db.query('SELECT * FROM notifications WHERE org_id = $1 ORDER BY id', [orgId])).rows;
// Deliver only until this org's work is done, ignoring rows of nobody else (tests run serially, so this is exact).
const drain = async () => { for (let i = 0; i < 5; i++) { const r = await deliverDue(50); if (r.sent + r.retrying + r.failed === 0) break; } };

// ---------- rendering ----------
const baseAlert = {
  id: 'a1', rule: 'node_stale', subject_label: 'UBUNTU-Dell01', farm_name: 'home', farm_time_zone: 'America/Los_Angeles',
  opened_at: new Date('2026-11-24T18:00:00Z'), silent_since: new Date('2026-11-24T17:57:00Z'), closed_at: null, duration_s: null, outage_s: null,
  detail: { threshold_s: 180 },
};
test('render: an opening alert states subject, condition, time in the farm zone, and links to the alert', () => {
  const r = renderAlert({ productName: 'Fleet Console', kind: 'alert_open', alert: baseAlert, link: 'https://fleet.example.test/#alerts/a1' });
  assert.equal(r.subject, '[Fleet Console] ALERT: UBUNTU-Dell01 is not reporting');
  assert.match(r.text, /UBUNTU-Dell01 in farm home: has stopped reporting \(no heartbeat for 3 min\)/);
  assert.match(r.text, /Opened:\s+Nov 24, 2026.*10:00:00 AM PST/);
  assert.match(r.text, /Last heard:\s+.*9:57:00 AM PST/);
  assert.match(r.text, /View: https:\/\/fleet\.example\.test\/#alerts\/a1/);
  assert.match(r.html, /<a href="https:\/\/fleet\.example\.test\/#alerts\/a1">/);
});
test('render: a closing alert gives the outage duration; the product name is a variable', () => {
  const r = renderAlert({ productName: 'Clarix Ops', kind: 'alert_close', link: null, alert: { ...baseAlert, closed_at: new Date('2026-11-24T18:12:00Z'), duration_s: 720, outage_s: 900 } });
  assert.equal(r.subject, '[Clarix Ops] RESOLVED: UBUNTU-Dell01 is reporting again (silent 15 min)');
  assert.match(r.text, /Silent for:\s+15 min/);
  assert.match(r.text, /Alert open:\s+12 min/);
  assert.ok(!r.text.includes('View:'));
});
test('render: farm alert lists the machines; names cannot inject headers or HTML', () => {
  const f = renderAlert({ productName: 'FC', kind: 'alert_open', link: null, alert: { ...baseAlert, rule: 'farm_stale', subject_label: 'home', detail: { nodes: [{ name: 'a' }, { name: 'b' }] } } });
  assert.match(f.text, /no machine is reporting \(a, b\)/);
  const evil = renderAlert({ productName: 'FC\r\nBcc: x@y', kind: 'alert_open', link: null, alert: { ...baseAlert, subject_label: 'x\r\nBcc: evil@example.com <script>alert(1)</script>' } });
  assert.ok(!/[\r\n]/.test(evil.subject));
  assert.ok(!evil.html.includes('<script>'));
  assert.equal(formatDuration(59), '59 s'); assert.equal(formatDuration(3900), '1 h 5 min'); assert.equal(formatDuration(90000), '1 d 1 h');
});

// ---------- targets ----------
test('targets: add, validate, dedupe, cap, delete; scoped to the organisation and audited', async () => {
  const o = await org(), other = await org();
  const ok = await addTarget(o, ' Bill@Example.com ');
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.body.target.address, 'Bill@Example.com');
  assert.equal((await addTarget(o, 'bill@example.com')).statusCode, 409);                    // same address, any case
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'x@y.com\r\nBcc: z@y.com', 'a@b.com,c@d.com', '<a@b.com>', 'a'.repeat(250) + '@b.com']) {
    assert.equal((await addTarget(o, bad)).statusCode, 400, bad.slice(0, 30));
  }
  assert.equal((await call(targets, { method: 'POST', cookie: o.cookie, body: { channel: 'sms', address: 'x' } })).statusCode, 400);
  assert.equal((await addTarget(other, 'bill@example.com')).statusCode, 201);                // another org may use it
  for (let i = 0; i < 9; i++) assert.equal((await addTarget(o, `x${i}@example.com`)).statusCode, 201);
  assert.equal((await addTarget(o, 'eleventh@example.com')).statusCode, 409);

  const list = (await call(notifications, { cookie: o.cookie })).body;
  assert.equal(list.targets.length, 10);
  assert.equal((await call(targetById, { method: 'DELETE', cookie: other.cookie, query: { id: ok.body.target.id } })).statusCode, 404);
  assert.equal((await call(targetById, { method: 'DELETE', cookie: o.cookie, query: { id: ok.body.target.id } })).statusCode, 200);
  assert.equal((await call(targetById, { method: 'DELETE', cookie: o.cookie, query: { id: 'nope' } })).statusCode, 404);
  for (const a of ['notification_target.create', 'notification_target.delete']) {
    assert.ok((await db.query('SELECT 1 FROM audit_events WHERE org_id = $1 AND action = $2', [o.op.orgId, a])).rows.length >= 1);
  }
  assert.equal((await call(targets, { method: 'POST', body: { channel: 'email', address: 'a@b.co' } })).statusCode, 401);
});

// ---------- the whole path ----------
test('US-062: an alert opening sends one email; it closing sends one more; nothing repeats while it stays open', async () => {
  const o = await org();
  await addTarget(o, 'bill@example.com');
  const token = (await call(enrolments, { method: 'POST', cookie: o.cookie, query: { id: o.farm.id }, body: { platform: 'ubuntu', display_name: 'UBUNTU-Dell01' } })).body.token;
  const e = (await call(enrol, { method: 'POST', body: { token, os: 'ubuntu', hostname: 'h' } })).body;
  const snap = (seq) => ({
    schema_version: 1, envelope: { node_id: e.node_id, agent_version: '1', applied_config_version: 1, node_time: new Date().toISOString(), seq, replayed: false },
    host: { hostname: 'h', os: 'ubuntu', os_version: '24.04', uptime_s: 1 }, agent_health: { buffer_depth: 0, dropped_count: 0 } });
  const send = (body) => call(ingest, { method: 'POST', headers: { authorization: `Bearer ${e.credential}` }, body });
  assert.equal((await send(snap(1))).statusCode, 200);

  // The node goes silent for eight minutes.
  await db.query(`UPDATE nodes SET last_heartbeat_at = now() - interval '8 minutes' WHERE id = $1`, [e.node_id]);
  await evaluateStaleness();
  await drain();
  await evaluateStaleness(); await evaluateStaleness(); await evaluateStaleness();   // and stays silent for several more cron runs
  await drain();

  assert.equal(sesCalls.length, 1, 'exactly one email while the alert is open');
  const c = sesCalls[0];
  assert.equal(c.url, '/v2/email/outbound-emails');
  assert.deepEqual(c.body.Destination.ToAddresses, ['bill@example.com']);
  assert.equal(c.body.FromEmailAddress, 'alerts@fleet.example.test');
  assert.equal(c.body.Content.Simple.Subject.Data, '[Fleet Console] ALERT: UBUNTU-Dell01 is not reporting');
  assert.match(c.body.Content.Simple.Body.Text.Data, /in farm home-kennewick/);
  assert.match(c.body.Content.Simple.Body.Text.Data, /View: https:\/\/fleet\.example\.test\/#alerts\/[0-9a-f-]{36}/);
  assert.match(c.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\/\d{8}\/us-west-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(c.body).includes('test-secret'));

  // It reports again through the real ingest path.
  assert.equal((await send(snap(2))).statusCode, 200);
  await drain();
  await evaluateStaleness(); await drain();
  assert.equal(sesCalls.length, 2);
  assert.match(sesCalls[1].body.Content.Simple.Subject.Data, /RESOLVED: UBUNTU-Dell01 is reporting again \(silent \d+ min\)/);
  assert.match(sesCalls[1].body.Content.Simple.Body.Text.Data, /Silent for:\s+\d+ min/);
});

test('US-062: delivery state is recorded: sent with provider id, nothing re-sent on later runs', async () => {
  const o = await org();
  await addTarget(o, 'bill@example.com');
  await silentNode(o, 'dell01');
  await evaluateStaleness();
  const r = await deliverDue(50);
  assert.equal(r.sent, 1);
  const [row] = await notes(o.op.orgId);
  assert.equal(row.status, 'sent'); assert.ok(row.provider_id.startsWith('msg-')); assert.ok(row.sent_at); assert.equal(row.kind, 'alert_open');
  assert.deepEqual(await deliverDue(50), { sent: 0, retrying: 0, failed: 0 });
});

test('US-062: concurrent delivery workers send each message once', async () => {
  const o = await org();
  await addTarget(o, 'a@example.com'); await addTarget(o, 'b@example.com');
  for (let i = 0; i < 3; i++) await silentNode(o, `n${i}`, 5000 + i * 1000);       // far apart: three node alerts, six notifications
  await evaluateStaleness();
  await Promise.all([deliverDue(50), deliverDue(50), deliverDue(50)]);
  assert.equal(sesCalls.length, 6);
  assert.equal((await notes(o.op.orgId)).filter((x) => x.status === 'sent').length, 6);
});

test('US-062: with no recipient configured the notification is recorded as skipped, visibly, not lost silently', async () => {
  const o = await org();
  await silentNode(o, 'dell01');
  await evaluateStaleness();
  const [row] = await notes(o.op.orgId);
  assert.equal(row.status, 'skipped');
  assert.match(row.last_error, /No notification target/);
  assert.equal(sesCalls.length, 0);
  const view = (await call(notifications, { cookie: o.cookie })).body;
  assert.equal(view.recent[0].status, 'skipped');
  assert.equal(view.recent[0].subject_label, 'dell01');
});

test('an address removed while its notification waits is never written to', async () => {
  const o = await org();
  const t = (await addTarget(o, 'gone@example.com')).body.target;
  await silentNode(o, 'dell01');
  await evaluateStaleness();
  await call(targetById, { method: 'DELETE', cookie: o.cookie, query: { id: t.id } });
  await deliverDue(50);
  assert.equal(sesCalls.length, 0);
  const [row] = await notes(o.op.orgId);
  assert.equal(row.status, 'skipped');
  assert.match(row.last_error, /removed before/);
});

// ---------- failures are visible and handled ----------
test('failure: a server error is retried with backoff, then recovers without duplicating', async () => {
  const o = await org();
  await addTarget(o, 'bill@example.com');
  await silentNode(o, 'dell01');
  sesBehaviour = (k) => (k === 1 ? { status: 500, body: { message: 'internal' } } : { status: 200, body: { MessageId: 'ok-2' } });
  await evaluateStaleness();
  assert.deepEqual(await deliverDue(50), { sent: 0, retrying: 1, failed: 0 });
  let [row] = await notes(o.op.orgId);
  assert.equal(row.status, 'pending'); assert.equal(row.attempts, 1);
  assert.match(row.last_error, /HTTP 500/);
  assert.ok(row.next_attempt_at > new Date(Date.now() + 30_000), 'retry is scheduled, not immediate');
  assert.deepEqual(await deliverDue(50), { sent: 0, retrying: 0, failed: 0 });   // not due yet
  await db.query(`UPDATE notifications SET next_attempt_at = now() WHERE id = $1`, [row.id]);
  assert.deepEqual(await deliverDue(50), { sent: 1, retrying: 0, failed: 0 });
  [row] = await notes(o.op.orgId);
  assert.equal(row.status, 'sent'); assert.equal(row.last_error, null); assert.equal(sesCalls.length, 2);
});

test('failure: a rejected message is failed at once and shown in the console with the provider\'s reason; retry re-queues it', async () => {
  const o = await org();
  await addTarget(o, 'bill@example.com');
  await silentNode(o, 'dell01');
  sesBehaviour = () => ({ status: 400, headers: { 'x-amzn-errortype': 'MessageRejected' }, body: { message: 'Email address is not verified.' } });
  await evaluateStaleness();
  assert.deepEqual(await deliverDue(50), { sent: 0, retrying: 0, failed: 1 });
  const view = (await call(notifications, { cookie: o.cookie })).body;
  assert.equal(view.failed_24h, 1);
  assert.equal(view.recent[0].status, 'failed');
  assert.match(view.recent[0].last_error, /MessageRejected.*not verified/);
  assert.ok(!JSON.stringify(view).includes('test-secret'));

  sesBehaviour = () => ({ status: 200, body: { MessageId: 'fixed' } });
  assert.equal((await call(retryRoute, { method: 'POST', cookie: o.cookie })).body.requeued, 1);
  assert.deepEqual(await deliverDue(50), { sent: 1, retrying: 0, failed: 0 });
  assert.equal((await call(notifications, { cookie: o.cookie })).body.failed_24h, 0);
});

test('failure: after the last attempt a retryable error becomes failed and stays visible', async () => {
  const o = await org();
  await addTarget(o, 'bill@example.com');
  await silentNode(o, 'dell01');
  sesBehaviour = () => ({ status: 503, body: { message: 'unavailable' } });
  await evaluateStaleness();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await db.query(`UPDATE notifications SET next_attempt_at = now() WHERE org_id = $1 AND status = 'pending'`, [o.op.orgId]);
    await deliverDue(50);
  }
  const [row] = await notes(o.op.orgId);
  assert.equal(row.status, 'failed'); assert.equal(row.attempts, MAX_ATTEMPTS);
});

test('failure: when email is not configured the message waits and is sent once it is; the cause is visible meanwhile', async () => {
  const o = await org();
  await addTarget(o, 'bill@example.com');
  await silentNode(o, 'dell01');
  delete process.env.SES_FROM;
  await evaluateStaleness();
  await deliverDue(50);
  let [row] = await notes(o.op.orgId);
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /not configured/);
  assert.equal((await call(notifications, { cookie: o.cookie })).body.channels.email.configured, false);
  configureSes();
  await db.query(`UPDATE notifications SET next_attempt_at = now() WHERE id = $1`, [row.id]);
  await deliverDue(50);
  [row] = await notes(o.op.orgId);
  assert.equal(row.status, 'sent');
});

test('failure: an unreachable SES is a retryable failure, not a crash', async () => {
  const o = await org();
  await addTarget(o, 'bill@example.com');
  await silentNode(o, 'dell01');
  process.env.SES_ENDPOINT = 'http://127.0.0.1:1';
  await evaluateStaleness();
  assert.deepEqual(await deliverDue(50), { sent: 0, retrying: 1, failed: 0 });
  assert.match((await notes(o.op.orgId))[0].last_error, /Could not reach SES/);
});

// ---------- test notification ----------
test('test notification: sends to every address now and reports each result; failures are shown; audited', async () => {
  const o = await org();
  assert.equal((await call(testRoute, { method: 'POST', cookie: o.cookie })).statusCode, 400);          // nothing to send to
  await addTarget(o, 'a@example.com'); await addTarget(o, 'b@example.com');
  const ok = await call(testRoute, { method: 'POST', cookie: o.cookie });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.results.map((r) => [r.recipient, r.ok]), [['a@example.com', true], ['b@example.com', true]]);
  assert.equal(sesCalls.length, 2);
  assert.equal(sesCalls[0].body.Content.Simple.Subject.Data, '[Fleet Console] Test notification');

  sesBehaviour = () => ({ status: 400, headers: { 'x-amzn-errortype': 'MessageRejected' }, body: { message: 'Email address is not verified.' } });
  const bad = await call(testRoute, { method: 'POST', cookie: o.cookie });
  assert.equal(bad.statusCode, 200);
  assert.ok(bad.body.results.every((r) => !r.ok && /not verified/.test(r.error)));
  assert.equal((await db.query(`SELECT count(*) AS n FROM notifications WHERE org_id = $1 AND kind = 'test' AND status = 'pending'`, [o.op.orgId])).rows[0].n, '0', 'a test is never left to retry in the background');
  assert.equal((await db.query(`SELECT count(*) AS n FROM audit_events WHERE org_id = $1 AND action = 'notification.test'`, [o.op.orgId])).rows[0].n, '2');
  assert.equal((await call(testRoute, { method: 'POST' })).statusCode, 401);
});

// ---------- a second channel needs no change to the core ----------
test('a second channel is an addition: register it, add a target for it, alerts reach it', async () => {
  const got = [];
  registerChannel({ name: 'stub', configured: () => true, async send(m) { got.push(m); return { id: 'stub-1' }; } });
  const o = await org();
  await db.query(`INSERT INTO notification_targets (org_id, channel, address) VALUES ($1, 'stub', '#ops')`, [o.op.orgId]);
  await addTarget(o, 'bill@example.com');
  await silentNode(o, 'dell01');
  await evaluateStaleness();
  await drain();
  assert.equal(got.length, 1);
  assert.equal(got[0].to, '#ops');
  assert.match(got[0].subject, /ALERT: dell01/);
  assert.equal(sesCalls.length, 1);                                                   // email still delivered alongside
});

// ---------- cron delivers ----------
test('the cron run evaluates, then delivers; a delivery problem cannot stop detection', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  const o = await org();
  await addTarget(o, 'bill@example.com');
  await silentNode(o, 'dell01');
  const r = await call(cron, { headers: { authorization: 'Bearer cron-secret' } });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.nodesStale >= 1);
  assert.ok(r.body.delivery.sent >= 1);
  assert.equal((await db.query(`SELECT count(*) AS n FROM alerts WHERE org_id = $1 AND closed_at IS NULL`, [o.op.orgId])).rows[0].n, '1');
  delete process.env.CRON_SECRET;
});

// ---------- alert history search ----------
test('history: lists open alerts first with durations, searchable by name, state, range, rule; paged; org-scoped', async () => {
  const o = await org(), other = await org();
  const a = await silentNode(o, 'UBUNTU-Dell01'), b = await silentNode(o, 'macmini', 9000);
  await silentNode(other, 'UBUNTU-Dell01');
  await evaluateStaleness();
  await db.query(`UPDATE alerts SET closed_at = now(), duration_s = 600, outage_s = 780, close_reason = 'node reported again', opened_at = now() - interval '10 days' WHERE subject_id = $1`, [b]);
  await db.query(`UPDATE alerts SET opened_at = now() - interval '40 days', closed_at = now() - interval '40 days' + interval '5 min', duration_s = 300 WHERE org_id = $1 AND subject_label = 'zz-old'`, [o.op.orgId]);

  const get = async (query) => (await call(alertsRoute, { cookie: o.cookie, query })).body;
  const all = await get({});
  assert.equal(all.total, 2);
  assert.equal(all.alerts[0].subject_label, 'UBUNTU-Dell01');                          // open first
  assert.equal(all.alerts[0].closed_at, null);
  assert.equal(all.alerts[1].duration_s, 600); assert.equal(all.alerts[1].outage_s, 780);
  assert.equal((await get({ state: 'open' })).total, 1);
  assert.equal((await get({ state: 'closed' })).alerts[0].subject_label, 'macmini');
  assert.deepEqual((await get({ q: 'dell' })).alerts.map((x) => x.subject_label), ['UBUNTU-Dell01']);
  assert.equal((await get({ q: '%' })).total, 0);                                      // wildcard characters are literal
  assert.equal((await get({ range: '24h' })).total, 1);                               // the 10-day-old one is outside
  assert.equal((await get({ range: '30d' })).total, 2);
  assert.equal((await get({ rule: 'farm_stale' })).total, 0);
  assert.equal((await get({ id: a })).total, 0);                                       // a is a node id, not an alert id
  assert.equal((await get({ id: all.alerts[0].id })).total, 1);
  assert.equal((await get({ limit: '1', offset: '1' })).alerts.length, 1);
  assert.equal((await get({ limit: '1' })).total, 2);
  assert.equal((await call(alertsRoute, { cookie: o.cookie, query: { state: 'bogus' } })).statusCode, 400);
  assert.equal((await call(alertsRoute, { cookie: o.cookie, query: { range: 'forever' } })).statusCode, 400);
  assert.equal((await call(alertsRoute, { cookie: o.cookie, query: { q: "'; DROP TABLE alerts; --" } })).statusCode, 200);
  assert.equal((await call(alertsRoute, { cookie: other.cookie })).body.total, 1);
  assert.equal((await call(alertsRoute, {})).statusCode, 401);
});
