# US-001 — Operator sign-in

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want to sign in to the console so that only I can see and change my fleet.

**Acceptance criteria**

- An unauthenticated visitor sees nothing about farms, nodes, or apps and is sent to sign-in.
- After sign-in, every record I see belongs to my organisation.
- Sessions expire after inactivity and I can sign out explicitly.
- Sign-in and sign-out are recorded as audit events.
- The Lead Engineer has assessed reuse of the existing Clarix identity pattern and recorded the decision and reasoning in the repository (OD-3).
