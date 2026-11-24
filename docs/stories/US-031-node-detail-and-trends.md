# US-031 — Node detail and trends

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want a detail view per node so that I can see how it has behaved over time and what is running on it.

**Acceptance criteria**

- The view shows current vitals, hardware and OS attributes, watched services with state, agent health, desired versus applied configuration, and the error tail.
- Trend charts for CPU, memory, disk, and load cover the last hour, 24 hours, 7 days, and 30 days.
- Gaps in reporting are shown as gaps, never as zero or as a connecting line.
- Periods filled by replayed data are marked.
- The node's alert history and lifecycle audit events are listed.
- From this view I can edit configuration, open logs, rotate the credential, upgrade, and remove the node.

**Depends on:** US-014, US-020, US-030
