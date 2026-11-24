# US-016 — Error tail with redaction

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want each heartbeat to carry the node's most recent error lines so that I can see a machine's last words even when the home site is unreachable.

**Acceptance criteria**

- Each Snapshot includes up to 20 error-level log lines written since the previous Snapshot, each capped at 500 characters.
- Redaction is applied on the node before sending. Default patterns cover bearer tokens, API keys, passwords in connection strings, and email addresses.
- Redaction patterns and log sources are set through Desired Config.
- A test proves that a seeded secret in a log line never reaches the console.
- The node detail view shows the stored error tail with timestamps, and marks it as the last-known tail when the node is stale.

**Depends on:** US-013, US-020
