# US-070 — Retention and rollups

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R5

As the operator, I want old data rolled up and purged automatically so that cost stays flat as the fleet grows.

**Acceptance criteria**

- Raw Snapshots and probe results older than 30 days are purged; hourly rollups are kept 13 months.
- Trend charts move from raw to rollup data without a visible seam.
- Retention periods are configurable.
- The console shows current data volume and its growth rate.
- Purge and rollup work is safe to re-run and reports its results.
- A projection at 8 nodes and 6 apps is documented against the database plan in use.

**Depends on:** US-013
