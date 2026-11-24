# US-025 — Remove a whole farm

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R5

As the operator, I want to remove an entire farm in one action so that I can tear down a site completely and know nothing is left behind.

**Acceptance criteria**

- Removal requires typing the farm's name to confirm, and shows beforehand exactly what will be removed: node count, gateway, credentials, and data volume.
- I choose between archiving farm data read-only for 30 days and purging it now.
- On confirmation: every node is commanded to decommission; every node credential and outstanding enrolment is revoked; the Log Gateway is removed and its credential revoked; alerts for the farm are closed.
- Nodes that do not confirm within a set time are revoked and listed for local uninstall.
- The console produces a removal report: what was removed automatically, what needs manual follow-up, and the local command for each remaining machine.
- The farm disappears from all views once the report is complete. No orphaned records, credentials, or scheduled work remain; a check proves it.
- The whole operation is an audit event that survives the purge.

**Depends on:** US-023, US-024, US-050
