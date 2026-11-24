# US-050 — Farm Log Gateway: install, configure, remove

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R4

As the operator, I want a log gateway at each farm so that I can query home logs from the console without storing them in the console.

**Acceptance criteria**

- One command installs the gateway on a node I choose, registers it with the farm, and establishes its outbound tunnel. No inbound port is opened on the router.
- Agents in the farm ship logs to the gateway once log shipping is enabled in their configuration; sources are operating-system service logs and container logs.
- The gateway answers read-only queries by node, service, time range, severity, and text filter, with a cap on result size.
- The gateway is reachable only with its service credential, which the console holds as a server-side secret.
- Retention at the farm is configurable, 14 days by default, and old logs are deleted automatically.
- The gateway's health appears in the console; an unreachable gateway raises an alert.
- I can change its settings from the console and move it to a different node.
- I can remove it: the tunnel is closed, the credential revoked, stored logs deleted, and nothing remains on the host. A local uninstall achieves the same offline.
- The Lead Engineer documents the chosen log store and tunnel with the reasoning.

**Depends on:** US-020
