# US-040 — Register a hosted app

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R3

As the operator, I want to register a hosted application with its health endpoint so that the console watches it alongside my machines.

**Acceptance criteria**

- I register an app with a name, environment, health endpoint address, and probe credential.
- On save, the console tests the endpoint and reports whether the response conforms to the health contract (ARCH-001 section 9.3), listing any missing fields.
- I can edit an app's settings, pause probing, and remove the app; removal stops probing, revokes nothing on the app side, and tells me the app's credential should be rotated there.
- The probe credential is stored as a secret and never displayed after entry.
- All changes are audit events.

**Depends on:** US-001
