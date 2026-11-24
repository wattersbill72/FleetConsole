# US-013 — Heartbeat and host vitals

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want each node to report its vitals on a regular interval so that I always know its current state.

**Acceptance criteria**

- The agent sends a Snapshot (ARCH-001 section 9.1: envelope, host, agent health) every 60 seconds by default.
- Only outbound HTTPS is used; no inbound port is opened on the node or the router.
- The console rejects Snapshots with a missing, wrong, or revoked credential, an unknown schema version, or a payload over the size limit, and reveals nothing to the caller beyond the refusal.
- A duplicated or replayed Snapshot produces one stored record.
- The console orders Snapshots by its own receipt time and keeps the node's timestamp alongside.
- Agent footprint on the smallest node stays under 1% average CPU and 50 MB memory, measured and recorded.
- Per-node rate limiting is in place on the ingest interface.

**Depends on:** US-011
