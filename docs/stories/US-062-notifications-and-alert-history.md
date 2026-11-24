# US-062 — Notifications and alert history

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want alerts delivered to me and kept in a history so that I can act on them and review patterns later.

**Acceptance criteria**

- I receive an email when an alert opens and when it closes, stating subject, condition, time, and a link to the relevant view.
- No repeat notifications are sent while an alert stays open.
- A test notification can be sent from settings.
- The console lists open alerts and a searchable history with durations.
- Notification failures are visible in the console.
- The design allows a second channel to be added later without rework (OD-2).

**Depends on:** US-060
