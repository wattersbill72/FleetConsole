# US-071 — Audit trail

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R5

As the operator, I want a record of every lifecycle and administrative action so that I can reconstruct what changed and when.

**Acceptance criteria**

- Audit events are recorded for: sign-in and sign-out; farm, node, app, and gateway create, change, and remove; enrolment issue and use; configuration changes; commands issued and their results; credential rotation and revocation; log queries; alert acknowledgements and silences.
- Each event records actor, action, subject, time, and outcome.
- Events cannot be edited or deleted through the console.
- The trail is searchable by subject, action, and time.
- Audit events for a removed farm survive a data purge.

**Depends on:** US-001
