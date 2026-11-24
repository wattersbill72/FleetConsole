# US-015 — Store and forward through outages

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want a node to keep its telemetry through a connectivity loss so that I can see what happened while it was cut off.

**Acceptance criteria**

- When the console is unreachable, the agent buffers Snapshots locally for at least 24 hours.
- When the buffer is full, the oldest Snapshots are dropped first and the count dropped is reported.
- On reconnection, buffered Snapshots are sent oldest-first, marked as replayed, at a rate that respects ingest limits, while live Snapshots continue.
- Replayed Snapshots fill the gap in the node's trend charts and do not raise alerts for conditions that have already cleared.
- The buffer survives an agent restart and a machine reboot.
- Buffer depth is visible in the node's agent health.

**Depends on:** US-013
