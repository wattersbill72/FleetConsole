# US-072 — End-to-end acceptance run

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R5

As the operator, I want one command that proves the whole system works so that I can verify a deployment or diagnose a fault quickly.

**Acceptance criteria**

- One run exercises, against a designated test node: enrolment, heartbeat, configuration change and convergence, service-down detection, buffered replay, stale detection and alert, notification, log query, credential rotation, and removal with residue check.
- It also exercises a hosted-app probe against a test endpoint in each of its outcomes.
- Each step reports pass or fail with the reason; the run exits non-zero on any failure.
- The run cleans up everything it created.
- It is safe to run against the live console without affecting real nodes or sending real alerts to the operator.
- Its use is documented in the repository.

**Depends on:** all prior stories
