# US-010 — Generate a node enrolment

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want the console to give me a one-time enrolment for a new node so that I can add a machine with a single command.

**Acceptance criteria**

- In a farm, I choose "add node", pick the platform (Ubuntu or macOS), and receive one command to run on that machine.
- The enrolment token is single-use and expires after one hour; an expired or used token is refused with a clear message on the node.
- The token is displayed once and cannot be retrieved again; I can generate a new one.
- I can see outstanding enrolments and cancel them.
- I can pre-set the node's display name, intermittent flag, and initial configuration before running the command.

**Depends on:** US-002
