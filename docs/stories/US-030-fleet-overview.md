# US-030 — Fleet overview

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want one screen showing every node and app with its status so that I know in five seconds whether anything needs me.

**Acceptance criteria**

- The overview lists every node grouped by farm with: display name, status, time since last heartbeat, CPU, memory, worst disk, and agent version.
- Hosted apps appear on the same screen with status, latency, and version once Epic 5 ships.
- Anything not healthy is sorted first and visually distinct without relying on colour alone.
- Open alerts are summarised at the top with a count.
- The screen refreshes itself and shows when it last refreshed.
- With the home site fully offline, the overview loads and shows every node as stale with correct last-seen times.
- The screen is usable on a phone.

**Depends on:** US-013
