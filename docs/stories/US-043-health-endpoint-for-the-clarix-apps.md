# US-043 — Health endpoint for the Clarix apps

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R3

As the operator, I want a reference health endpoint I can add to each Clarix app so that every app reports the same way.

**Acceptance criteria**

- A reference implementation conforming to the health contract is delivered with instructions for adding it to an existing app on the current Clarix stack.
- It checks the app's database connection at minimum and supports adding further dependency checks.
- It refuses requests without the probe credential and exposes no secrets, configuration values, or user data.
- It answers within the contract's time limit even when a dependency hangs.
- It is added to ClarixECP first and shown working in the console; a short checklist covers rolling it to the other apps.

**Depends on:** US-040
