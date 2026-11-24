# US-061 — Threshold and condition alerts

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R5

As the operator, I want alerts on the conditions that matter so that I hear about a filling disk or a failed service before it becomes an outage.

**Acceptance criteria**

- The launch rules in ARCH-001 section 13 are implemented.
- Thresholds have farm-level defaults and per-node overrides.
- One alert exists per condition per subject; it opens once and closes when the condition clears.
- Replayed data does not open alerts for conditions that have already cleared.
- I can acknowledge an alert and silence a subject for a set period, for planned maintenance.
- I can disable any rule.

**Depends on:** US-014, US-041, US-060
