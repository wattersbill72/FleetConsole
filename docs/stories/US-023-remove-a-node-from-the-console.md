# US-023 — Remove a node from the console

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want to remove a node from the console and have the agent uninstall itself so that retiring a machine takes one action.

**Acceptance criteria**

- Removing a node requires explicit confirmation naming the node.
- The node moves to `decommissioning`. On its next heartbeat it receives the decommission command, stops reporting, uninstalls, and sends a final confirmation.
- After confirmation the node shows `removed` and its credential is revoked.
- On the machine, nothing of the agent remains: program, service registration, configuration, credential, buffer, and agent logs are all gone. Nothing else on the machine is touched. A verification step proves this.
- If the node does not confirm within a set time, the console says so, revokes the credential anyway, and tells me to run the local uninstall.
- I can choose to keep the node's history for the retention period or purge it immediately.
- Removal is an audit event.

**Depends on:** US-013
