# US-041 — Scheduled app health probing

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R3

As the operator, I want the console to check each app on a schedule so that I learn about an outage before a user tells me.

**Acceptance criteria**

- Each registered app is probed at a configurable interval, one minute by default.
- Each probe records status, response time, reported version, and each dependency check.
- A timeout, a non-conforming response, and an explicit `down` are recorded as distinct outcomes.
- Probing continues when the home site is offline.
- Probe volume stays within the hosting plan's limits; the calculation is documented.

**Depends on:** US-040
