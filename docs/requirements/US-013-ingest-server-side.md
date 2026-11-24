# US-013 Heartbeat and host vitals: requirements, ingest (server) side

Scope of this slice: `POST /api/ingest/snapshot` and what it stores. The agent that sends Snapshots, the footprint measurement, and the 60-second cadence are agent side (R1 step 3, next slice).

## Endpoint

`POST /api/ingest/snapshot`, `Authorization: Bearer fcn_...`, JSON body conforming to `contracts/snapshot.v1.schema.json`.

Order of checks (the order is the defence): credential, per-node rate limit, size-capped body, schema, node identity match, store. Every credential failure (missing, malformed, unknown, revoked, node removed) returns the same `401 {"error":"Unauthorized"}`. Operator session cookies do not authenticate this route.

Response on success: `{ ok, duplicate, last_seq, desired_config_version, commands: [] }`. `commands` is always empty until the command queue exists (US-023); `desired_config_version` lets the agent detect a config change (US-020 adds the fetch endpoint).

## Decisions

- **Limits:** 256 KB per Snapshot; 60 requests per node per minute (live is 1 a minute, the rest is replay headroom: a 24 hour backlog of 1,440 Snapshots drains in about 24 minutes). Over the limit: `429` with `Retry-After`. Rate state is a per-node per-minute counter row in Postgres, pruned after an hour.
- **Body reading:** the route disables Vercel's body parser and reads the stream with a hard cap, so an oversize body is never buffered. The code also accepts an already-parsed body, so it is correct if the platform setting is ignored. Verify with a deploy smoke test.
- **Idempotency:** unique `(node_id, seq)`; a duplicate returns 200 with `duplicate: true` and writes nothing.
- **Sequence recovery:** every response carries `last_seq`. If an agent loses its state and restarts numbering, its Snapshots would collide with stored ones; the agent uses `last_seq` to jump forward. Agent side of this lands with the agent.
- **Ordering:** `received_at` (console clock) is authoritative; `node_time` is stored for diagnosis only. Tested with node clocks in 2001 and 2099.
- **Live versus replayed:** only a new, live Snapshot with the highest sequence so far updates the node's current state (status, hostname, versions, latest vitals). Replays fill history only. Any accepted request, including a duplicate or a replay, refreshes `last_heartbeat_at`, because it proves the node can reach the console. The stale-detection story (US-060) must treat "replay arrived" as reachable but not as healthy; status stays `stale` until a live Snapshot arrives.
- **Status:** a live Snapshot moves `pending`, `stale`, `expected-offline`, `degraded` to `healthy`. It never overwrites `decommissioning` or `removed`. `degraded` is computed from service state with US-014.
- **Storage shape (cost):** one row per Snapshot with columns for the charted vitals (cpu, load1, memory, uptime, worst disk %) and a `detail` JSON for the rest, including the error tail, so rows stay small and a chart does not parse JSON. Unavailable vitals are NULL, never zero. Not measured yet: real bytes per row; measure when the agent produces real Snapshots and update the DEC-005 storage estimate.
- **Not enforced server side:** redaction. ARCH-001 puts it on the node. The console stores error tails as received; the seeded-secret test belongs with the agent (US-016).
- **Not in this slice:** per-IP throttling of unauthenticated floods. Every unauthenticated request costs one indexed lookup. If abuse appears, add a Vercel Firewall rate-limit rule on `/api/ingest/*`; no code change needed.

## Acceptance criteria (US-013)

| Criterion | Status | Proof |
|---|---|---|
| Snapshot of envelope, host, agent health every 60 s by default | Agent side | next slice |
| Outbound HTTPS only, no inbound port | Agent side by design; the server never calls a node | next slice |
| Rejects missing, wrong, revoked credential; unknown schema version; oversize; reveals nothing beyond refusal | Met | tests: 401 matrix identical bodies and nothing stored; revoked takes effect on next request; 413 on declared length, parsed body and raw stream; `unsupported_schema_version`; malformed and extra-field bodies; wrong node id 403 |
| Duplicate or replayed Snapshot produces one record | Met | tests incl. six concurrent identical Snapshots |
| Console orders by its own receipt time, keeps node timestamp | Met | test with 2001 and 2099 node clocks |
| Footprint under 1% CPU and 50 MB, measured and recorded | Agent side. The 50 MB figure was relaxed by Bill; measure and record, no hard gate (DEC-002) | next slice |
| Per-node rate limiting on ingest | Met | test: 429 with Retry-After, other node unaffected |
