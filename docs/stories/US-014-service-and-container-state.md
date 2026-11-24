# US-014 — Service and container state

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want each node to report the state of the services I care about so that I see what is running, stopped, or flapping.

**Acceptance criteria**

- For each watched service the Snapshot carries name, kind, state, since-when, and restart count.
- Operating-system services and containers are both supported on Ubuntu; operating-system services on macOS.
- The watch list comes from Desired Config. With no list configured, the agent reports all running containers and no OS services.
- A watched service that does not exist on the node is reported as `not-found`, distinct from `stopped`.
- A node with any watched service down shows `degraded`.

**Depends on:** US-013, US-020
