# US-021 — Local agent command line

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator at a node's terminal, I want a local command to inspect the agent so that I can diagnose a machine that is not reporting.

**Acceptance criteria**

- A local command shows: agent version, node identity, farm, service status, last successful heartbeat, applied configuration version, buffer depth, and last error.
- A connectivity test reports each step separately: name resolution, reach, credential accepted, Snapshot accepted.
- A command prints the applied configuration with secrets masked.
- A self-check validates installation integrity and file permissions and exits non-zero on any failure.
- Help output lists every command, including removal.

**Depends on:** US-011
