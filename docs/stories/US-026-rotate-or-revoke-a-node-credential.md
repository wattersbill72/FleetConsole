# US-026 — Rotate or revoke a node credential

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want to rotate or revoke a node's credential so that I can respond to a suspected leak without rebuilding the node.

**Acceptance criteria**

- Rotation issues a new credential through the heartbeat response; the old one is revoked once the node confirms the new one.
- A failed rotation leaves the old credential working and reports the failure.
- Revocation takes effect immediately; the next Snapshot from that node is refused.
- A revoked node shows a distinct state and can be restored only by re-enrolment.
- Both actions require confirmation and are audit events.

**Depends on:** US-013
