# US-020 — Central node configuration

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want to change a node's configuration from the console so that I never have to log in to a machine to adjust what it reports.

**Acceptance criteria**

- For each node I can edit: heartbeat interval (30 to 300 seconds), watched services, reported disk volumes, sovereignAI adapter settings, log shipping settings, redaction patterns, intermittent flag, and alert threshold overrides.
- Each saved change creates a new configuration version. I can view the history and restore a previous version.
- The node learns of the new version in its next heartbeat response, applies it, and reports the applied version; the console shows desired and applied versions side by side.
- A healthy node converges within two heartbeat intervals.
- A configuration the agent cannot apply is rejected; the agent continues on the last good version and the console shows the rejection reason and raises an alert.
- I can define a farm-level default configuration that new nodes inherit, and apply one change to several nodes at once.
- Every change is an audit event recording what changed.

**Depends on:** US-013
