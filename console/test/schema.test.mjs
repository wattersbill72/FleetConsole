import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validate } from '../build-test/server/schema.js';
import { snapshotV1, desiredConfigV1 } from '../build-test/server/contracts.generated.js';

test('generated contracts match /contracts', () => {
  execFileSync('node', ['scripts/build-contracts.mjs', '--check'], { stdio: 'pipe' });
});

const snapshot = () => ({
  schema_version: 1,
  envelope: { node_id: '7f9c1c0e-5a54-4a3a-8c53-0a6a8d3f9e11', agent_version: '0.1.0', applied_config_version: 1, node_time: '2026-11-24T10:00:00Z', seq: 1, replayed: false },
  host: { hostname: 'dell01', os: 'ubuntu', os_version: '24.04', uptime_s: 100, cpu_pct: 3.5, load: [0.1, 0.2, 0.3], mem_used_bytes: 1, mem_total_bytes: 2, disks: [{ mount: '/', used_bytes: 1, total_bytes: 2 }], temperature_c: null },
  agent_health: { buffer_depth: 0, dropped_count: 0 },
});

test('a valid Snapshot v1 passes; unavailable vitals may be null', () => {
  assert.deepEqual(validate(snapshotV1, snapshot()), []);
});

test('Snapshot v1 rejects wrong version, missing fields, extra fields, bad ranges and formats', () => {
  const bad = (mutate) => { const s = snapshot(); mutate(s); return validate(snapshotV1, s); };
  assert.ok(bad((s) => { s.schema_version = 2; }).length);
  assert.ok(bad((s) => { delete s.host; }).length);
  assert.ok(bad((s) => { s.surprise = 1; }).length);
  assert.ok(bad((s) => { s.host.cpu_pct = 101; }).length);
  assert.ok(bad((s) => { s.host.os = 'windows'; }).length);
  assert.ok(bad((s) => { s.envelope.node_id = 'nope'; }).length);
  assert.ok(bad((s) => { s.envelope.node_time = 'yesterday'; }).length);
  assert.ok(bad((s) => { s.error_tail = Array.from({ length: 21 }, () => ({ time: '2026-11-24T10:00:00Z', source: 's', line: 'x' })); }).length);
  assert.ok(bad((s) => { s.error_tail = [{ time: '2026-11-24T10:00:00Z', source: 's', line: 'x'.repeat(501) }]; }).length);
  assert.ok(bad((s) => { s.host.load = [1, 2]; }).length);
});

test('Desired Config v1: bounds and unknown keys', () => {
  const ok = { schema_version: 1, version: 1, heartbeat_interval_s: 60 };
  assert.deepEqual(validate(desiredConfigV1, ok), []);
  assert.ok(validate(desiredConfigV1, { ...ok, heartbeat_interval_s: 29 }).length);
  assert.ok(validate(desiredConfigV1, { ...ok, heartbeat_interval_s: 60.5 }).length);
  assert.ok(validate(desiredConfigV1, { ...ok, extra: true }).length);
  assert.ok(validate(desiredConfigV1, { ...ok, watched_services: [{ name: 'x', kind: 'sovereignai' }] }).length);
});
