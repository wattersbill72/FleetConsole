# US-012 — Install the Edge Agent on a macOS node

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want the same one-command install on my Macs so that the Mac mini and MacBook report alongside the Ubuntu machines.

**Acceptance criteria**

- All criteria of US-011 hold on current macOS on Apple silicon, using the platform's native service manager.
- A Mac that sleeps and wakes resumes reporting without intervention and without duplicate records.
- A node flagged intermittent shows `expected-offline` while asleep and raises no stale alert.
- Host vitals that macOS does not expose are reported as unavailable, never as zero.

**Depends on:** US-011
