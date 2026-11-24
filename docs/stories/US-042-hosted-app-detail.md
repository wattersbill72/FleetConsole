# US-042 — Hosted app detail

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R3

As the operator, I want a detail view per app so that I can see its availability and where a problem sits.

**Acceptance criteria**

- The view shows current status, version, response time, and each dependency check with its state.
- Availability and response-time trends cover 24 hours, 7 days, and 30 days.
- Version changes are marked on the timeline so a deploy can be matched to a change in behaviour.
- Alert history for the app is listed.
- A link opens the app's logs (US-052).

**Depends on:** US-041
