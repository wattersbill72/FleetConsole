# US-024 — Remove a node locally

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want to uninstall the agent at the machine itself so that I can remove it when the node is offline, the console is unreachable, or the machine is being repurposed.

**Acceptance criteria**

- One local command removes everything listed in US-023 with no network connection required.
- When the network is available, the command also notifies the console so the node is marked `removed`.
- When it is not, the console eventually shows the node as stale, and I can mark it removed manually, which revokes its credential.
- Running the command a second time reports that nothing is installed and exits cleanly.
- The command prints a summary of what was removed.
- After local removal, the machine can be enrolled again as a new node.

**Depends on:** US-011
