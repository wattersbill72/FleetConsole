# US-022 — Upgrade the agent

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want to upgrade agents from the console so that the fleet stays on one version without visiting each machine.

**Acceptance criteria**

- The fleet view shows each node's agent version and marks those behind the current release.
- I can issue an upgrade to one node or to all nodes in a farm.
- The agent upgrades itself, restarts, and reports the new version; configuration, credential, identity, and buffer are preserved.
- A failed upgrade leaves the previous version running and reports the failure.
- Re-running the installer on the node achieves the same result when the console path is unavailable.
- Upgrades are audit events.

**Depends on:** US-020
