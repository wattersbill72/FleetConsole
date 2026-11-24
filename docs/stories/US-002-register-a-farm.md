# US-002 — Register a farm

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want to create a named farm so that nodes at one site are grouped and managed together.

**Acceptance criteria**

- I can create a farm with a name, a site description, and a time zone.
- Farm names are unique within my organisation.
- I can rename a farm and edit its description without affecting its nodes.
- A new farm shows an empty state that leads directly to enrolling the first node.
- Creation and edits are audit events.

**Depends on:** US-001
