# US-052 — Query hosted app logs from the console

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R4

As the operator, I want to read a hosted app's logs in the console so that app and machine diagnosis happen in one place.

**Acceptance criteria**

- The story begins with a short investigation of the hosting provider's log interface: what it exposes, retention on the current plan, limits, and cost. Findings are recorded and reviewed with the Architect before build.
- If the interface supports it: from an app's detail view I can read recent logs filtered by time range, severity, and text, streamed through with nothing persisted in the console.
- If it does not, or requires a plan change: the app's detail view links directly to the provider's own log viewer for that app and environment, and the limitation is stated in the console.
- Queries are audit events.

**Depends on:** US-042
