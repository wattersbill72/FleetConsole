# Fleet Console — User Stories

Companion to `ARCHITECTURE.md` (ARCH-001, REV A). Section references below point to that document.

**How to read these.** Each story states an outcome and the conditions that prove it. Design, technology choice, and implementation belong to the Lead Engineer within the architecture's constraints. Acceptance criteria are the definition of done; every criterion must be demonstrable.

**Roles.** *Operator*: Bill, the single user who runs the fleet. *Node*: a home machine running the Edge Agent. *Console*: the hosted web application.

**Release tags** follow ARCH-001 section 18.

---

## Epic 1 — Foundation

## US-001 — Operator sign-in

**Release:** R1

As the operator, I want to sign in to the console so that only I can see and change my fleet.

**Acceptance criteria**

- An unauthenticated visitor sees nothing about farms, nodes, or apps and is sent to sign-in.
- After sign-in, every record I see belongs to my organisation.
- Sessions expire after inactivity and I can sign out explicitly.
- Sign-in and sign-out are recorded as audit events.
- The Lead Engineer has assessed reuse of the existing Clarix identity pattern and recorded the decision and reasoning in the repository (OD-3).

## US-002 — Register a farm

**Release:** R1

As the operator, I want to create a named farm so that nodes at one site are grouped and managed together.

**Acceptance criteria**

- I can create a farm with a name, a site description, and a time zone.
- Farm names are unique within my organisation.
- I can rename a farm and edit its description without affecting its nodes.
- A new farm shows an empty state that leads directly to enrolling the first node.
- Creation and edits are audit events.

**Depends on:** US-001

---

## Epic 2 — Enrolment and the Edge Agent

## US-010 — Generate a node enrolment

**Release:** R1

As the operator, I want the console to give me a one-time enrolment for a new node so that I can add a machine with a single command.

**Acceptance criteria**

- In a farm, I choose "add node", pick the platform (Ubuntu or macOS), and receive one command to run on that machine.
- The enrolment token is single-use and expires after one hour; an expired or used token is refused with a clear message on the node.
- The token is displayed once and cannot be retrieved again; I can generate a new one.
- I can see outstanding enrolments and cancel them.
- I can pre-set the node's display name, intermittent flag, and initial configuration before running the command.

**Depends on:** US-002

## US-011 — Install the Edge Agent on an Ubuntu node

**Release:** R1

As the operator, I want one command to install and start the agent on Ubuntu 24.04 so that a machine reports within minutes.

**Acceptance criteria**

- Running the command from US-010 on a clean Ubuntu 24.04 machine installs the agent, enrols it, and starts it with no further prompts beyond privilege elevation.
- The agent is registered with the operating system's service manager, starts at boot, and restarts after a crash.
- The node appears in the console as `pending` at enrolment and `healthy` after the first heartbeat, within five minutes of running the command.
- The node receives a generated permanent identity. Renaming the machine afterward changes the displayed hostname and nothing else.
- The agent's credential and configuration are readable only by the agent's own account.
- Running the installer on a machine that already has an agent reports the existing installation and changes nothing unless I ask for reinstall or upgrade.
- The installer ends by printing: node identity, farm, console address, service status, and how to remove the agent.
- A failed install leaves no partial installation behind.

**Depends on:** US-010

## US-012 — Install the Edge Agent on a macOS node

**Release:** R2

As the operator, I want the same one-command install on my Macs so that the Mac mini and MacBook report alongside the Ubuntu machines.

**Acceptance criteria**

- All criteria of US-011 hold on current macOS on Apple silicon, using the platform's native service manager.
- A Mac that sleeps and wakes resumes reporting without intervention and without duplicate records.
- A node flagged intermittent shows `expected-offline` while asleep and raises no stale alert.
- Host vitals that macOS does not expose are reported as unavailable, never as zero.

**Depends on:** US-011

## US-013 — Heartbeat and host vitals

**Release:** R1

As the operator, I want each node to report its vitals on a regular interval so that I always know its current state.

**Acceptance criteria**

- The agent sends a Snapshot (ARCH-001 section 9.1: envelope, host, agent health) every 60 seconds by default.
- Only outbound HTTPS is used; no inbound port is opened on the node or the router.
- The console rejects Snapshots with a missing, wrong, or revoked credential, an unknown schema version, or a payload over the size limit, and reveals nothing to the caller beyond the refusal.
- A duplicated or replayed Snapshot produces one stored record.
- The console orders Snapshots by its own receipt time and keeps the node's timestamp alongside.
- Agent footprint on the smallest node stays under 1% average CPU and 50 MB memory, measured and recorded.
- Per-node rate limiting is in place on the ingest interface.

**Depends on:** US-011

## US-014 — Service and container state

**Release:** R2

As the operator, I want each node to report the state of the services I care about so that I see what is running, stopped, or flapping.

**Acceptance criteria**

- For each watched service the Snapshot carries name, kind, state, since-when, and restart count.
- Operating-system services and containers are both supported on Ubuntu; operating-system services on macOS.
- The watch list comes from Desired Config. With no list configured, the agent reports all running containers and no OS services.
- A watched service that does not exist on the node is reported as `not-found`, distinct from `stopped`.
- A node with any watched service down shows `degraded`.

**Depends on:** US-013, US-020

## US-015 — Store and forward through outages

**Release:** R2

As the operator, I want a node to keep its telemetry through a connectivity loss so that I can see what happened while it was cut off.

**Acceptance criteria**

- When the console is unreachable, the agent buffers Snapshots locally for at least 24 hours.
- When the buffer is full, the oldest Snapshots are dropped first and the count dropped is reported.
- On reconnection, buffered Snapshots are sent oldest-first, marked as replayed, at a rate that respects ingest limits, while live Snapshots continue.
- Replayed Snapshots fill the gap in the node's trend charts and do not raise alerts for conditions that have already cleared.
- The buffer survives an agent restart and a machine reboot.
- Buffer depth is visible in the node's agent health.

**Depends on:** US-013

## US-016 — Error tail with redaction

**Release:** R2

As the operator, I want each heartbeat to carry the node's most recent error lines so that I can see a machine's last words even when the home site is unreachable.

**Acceptance criteria**

- Each Snapshot includes up to 20 error-level log lines written since the previous Snapshot, each capped at 500 characters.
- Redaction is applied on the node before sending. Default patterns cover bearer tokens, API keys, passwords in connection strings, and email addresses.
- Redaction patterns and log sources are set through Desired Config.
- A test proves that a seeded secret in a log line never reaches the console.
- The node detail view shows the stored error tail with timestamps, and marks it as the last-known tail when the node is stale.

**Depends on:** US-013, US-020

## US-017 — sovereignAI adapter

**Release:** R2

As the operator, I want nodes that run sovereignAI to report its state so that I see the AI platform alongside the machines it runs on.

**Acceptance criteria**

- Where enabled in Desired Config, the agent reads SIS and SISC status from their existing local interfaces and includes the sovereignAI group in the Snapshot (ARCH-001 section 9.1).
- Reported at minimum: component, node role, loaded models, memory budget used and total, request and token throughput, and the inference nodes SISC knows with their state.
- SIS, SISC, and the sovereignAI console are reported as services with up/down state.
- If sovereignAI is installed but stopped, the adapter reports it as down and the agent keeps running normally.
- No change to the sovereignAI codebase is required. If one would materially simplify the adapter, it is proposed to the Architect first.
- The Lead Engineer has reviewed `WB72_SoveriegnAI_Server` and documented which interfaces the adapter uses.

**Depends on:** US-014

---

## Epic 3 — Configuration and lifecycle

## US-020 — Central node configuration

**Release:** R2

As the operator, I want to change a node's configuration from the console so that I never have to log in to a machine to adjust what it reports.

**Acceptance criteria**

- For each node I can edit: heartbeat interval (30 to 300 seconds), watched services, reported disk volumes, sovereignAI adapter settings, log shipping settings, redaction patterns, intermittent flag, and alert threshold overrides.
- Each saved change creates a new configuration version. I can view the history and restore a previous version.
- The node learns of the new version in its next heartbeat response, applies it, and reports the applied version; the console shows desired and applied versions side by side.
- A healthy node converges within two heartbeat intervals.
- A configuration the agent cannot apply is rejected; the agent continues on the last good version and the console shows the rejection reason and raises an alert.
- I can define a farm-level default configuration that new nodes inherit, and apply one change to several nodes at once.
- Every change is an audit event recording what changed.

**Depends on:** US-013

## US-021 — Local agent command line

**Release:** R1

As the operator at a node's terminal, I want a local command to inspect the agent so that I can diagnose a machine that is not reporting.

**Acceptance criteria**

- A local command shows: agent version, node identity, farm, service status, last successful heartbeat, applied configuration version, buffer depth, and last error.
- A connectivity test reports each step separately: name resolution, reach, credential accepted, Snapshot accepted.
- A command prints the applied configuration with secrets masked.
- A self-check validates installation integrity and file permissions and exits non-zero on any failure.
- Help output lists every command, including removal.

**Depends on:** US-011

## US-022 — Upgrade the agent

**Release:** R2

As the operator, I want to upgrade agents from the console so that the fleet stays on one version without visiting each machine.

**Acceptance criteria**

- The fleet view shows each node's agent version and marks those behind the current release.
- I can issue an upgrade to one node or to all nodes in a farm.
- The agent upgrades itself, restarts, and reports the new version; configuration, credential, identity, and buffer are preserved.
- A failed upgrade leaves the previous version running and reports the failure.
- Re-running the installer on the node achieves the same result when the console path is unavailable.
- Upgrades are audit events.

**Depends on:** US-020

## US-023 — Remove a node from the console

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

## US-024 — Remove a node locally

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

## US-025 — Remove a whole farm

**Release:** R5

As the operator, I want to remove an entire farm in one action so that I can tear down a site completely and know nothing is left behind.

**Acceptance criteria**

- Removal requires typing the farm's name to confirm, and shows beforehand exactly what will be removed: node count, gateway, credentials, and data volume.
- I choose between archiving farm data read-only for 30 days and purging it now.
- On confirmation: every node is commanded to decommission; every node credential and outstanding enrolment is revoked; the Log Gateway is removed and its credential revoked; alerts for the farm are closed.
- Nodes that do not confirm within a set time are revoked and listed for local uninstall.
- The console produces a removal report: what was removed automatically, what needs manual follow-up, and the local command for each remaining machine.
- The farm disappears from all views once the report is complete. No orphaned records, credentials, or scheduled work remain; a check proves it.
- The whole operation is an audit event that survives the purge.

**Depends on:** US-023, US-024, US-050

## US-026 — Rotate or revoke a node credential

**Release:** R2

As the operator, I want to rotate or revoke a node's credential so that I can respond to a suspected leak without rebuilding the node.

**Acceptance criteria**

- Rotation issues a new credential through the heartbeat response; the old one is revoked once the node confirms the new one.
- A failed rotation leaves the old credential working and reports the failure.
- Revocation takes effect immediately; the next Snapshot from that node is refused.
- A revoked node shows a distinct state and can be restored only by re-enrolment.
- Both actions require confirmation and are audit events.

**Depends on:** US-013

---

## Epic 4 — Console views

## US-030 — Fleet overview

**Release:** R1

As the operator, I want one screen showing every node and app with its status so that I know in five seconds whether anything needs me.

**Acceptance criteria**

- The overview lists every node grouped by farm with: display name, status, time since last heartbeat, CPU, memory, worst disk, and agent version.
- Hosted apps appear on the same screen with status, latency, and version once Epic 5 ships.
- Anything not healthy is sorted first and visually distinct without relying on colour alone.
- Open alerts are summarised at the top with a count.
- The screen refreshes itself and shows when it last refreshed.
- With the home site fully offline, the overview loads and shows every node as stale with correct last-seen times.
- The screen is usable on a phone.

**Depends on:** US-013

## US-031 — Node detail and trends

**Release:** R2

As the operator, I want a detail view per node so that I can see how it has behaved over time and what is running on it.

**Acceptance criteria**

- The view shows current vitals, hardware and OS attributes, watched services with state, agent health, desired versus applied configuration, and the error tail.
- Trend charts for CPU, memory, disk, and load cover the last hour, 24 hours, 7 days, and 30 days.
- Gaps in reporting are shown as gaps, never as zero or as a connecting line.
- Periods filled by replayed data are marked.
- The node's alert history and lifecycle audit events are listed.
- From this view I can edit configuration, open logs, rotate the credential, upgrade, and remove the node.

**Depends on:** US-014, US-020, US-030

## US-032 — sovereignAI view

**Release:** R2

As the operator, I want a view of the sovereignAI platform as a whole so that I see the AI stack's health without assembling it from individual nodes.

**Acceptance criteria**

- One view shows each sovereignAI component, the node it runs on, its state, loaded models, memory budget, and throughput.
- Inference nodes known to SISC are listed with their state; one that SISC reports as down is flagged even if its machine is healthy.
- Throughput and memory trends cover the same ranges as US-031.
- Each component links to its node's detail view.
- If no node reports sovereignAI, the view explains how to enable the adapter.

**Depends on:** US-017, US-031

---

## Epic 5 — Hosted apps

## US-040 — Register a hosted app

**Release:** R3

As the operator, I want to register a hosted application with its health endpoint so that the console watches it alongside my machines.

**Acceptance criteria**

- I register an app with a name, environment, health endpoint address, and probe credential.
- On save, the console tests the endpoint and reports whether the response conforms to the health contract (ARCH-001 section 9.3), listing any missing fields.
- I can edit an app's settings, pause probing, and remove the app; removal stops probing, revokes nothing on the app side, and tells me the app's credential should be rotated there.
- The probe credential is stored as a secret and never displayed after entry.
- All changes are audit events.

**Depends on:** US-001

## US-041 — Scheduled app health probing

**Release:** R3

As the operator, I want the console to check each app on a schedule so that I learn about an outage before a user tells me.

**Acceptance criteria**

- Each registered app is probed at a configurable interval, one minute by default.
- Each probe records status, response time, reported version, and each dependency check.
- A timeout, a non-conforming response, and an explicit `down` are recorded as distinct outcomes.
- Probing continues when the home site is offline.
- Probe volume stays within the hosting plan's limits; the calculation is documented.

**Depends on:** US-040

## US-042 — Hosted app detail

**Release:** R3

As the operator, I want a detail view per app so that I can see its availability and where a problem sits.

**Acceptance criteria**

- The view shows current status, version, response time, and each dependency check with its state.
- Availability and response-time trends cover 24 hours, 7 days, and 30 days.
- Version changes are marked on the timeline so a deploy can be matched to a change in behaviour.
- Alert history for the app is listed.
- A link opens the app's logs (US-052).

**Depends on:** US-041

## US-043 — Health endpoint for the Clarix apps

**Release:** R3

As the operator, I want a reference health endpoint I can add to each Clarix app so that every app reports the same way.

**Acceptance criteria**

- A reference implementation conforming to the health contract is delivered with instructions for adding it to an existing app on the current Clarix stack.
- It checks the app's database connection at minimum and supports adding further dependency checks.
- It refuses requests without the probe credential and exposes no secrets, configuration values, or user data.
- It answers within the contract's time limit even when a dependency hangs.
- It is added to ClarixECP first and shown working in the console; a short checklist covers rolling it to the other apps.

**Depends on:** US-040

---

## Epic 6 — Logs

## US-050 — Farm Log Gateway: install, configure, remove

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

## US-051 — Query node logs from the console

**Release:** R4

As the operator, I want to read and filter a node's logs in the console so that I can diagnose a problem without opening a terminal.

**Acceptance criteria**

- From a node or service I open logs filtered to that subject, and can change time range, severity, and text filter.
- Results stream into the view and can be followed live.
- No log content is written to the console's database; a test proves it.
- Each query is an audit event recording who, which subject, and which filters, without the results.
- When the farm is unreachable, the view says so plainly and shows the stored error tails for the subject.
- Large result sets are paged or capped with a clear message; the browser stays responsive.

**Depends on:** US-050

## US-052 — Query hosted app logs from the console

**Release:** R4

As the operator, I want to read a hosted app's logs in the console so that app and machine diagnosis happen in one place.

**Acceptance criteria**

- The story begins with a short investigation of the hosting provider's log interface: what it exposes, retention on the current plan, limits, and cost. Findings are recorded and reviewed with the Architect before build.
- If the interface supports it: from an app's detail view I can read recent logs filtered by time range, severity, and text, streamed through with nothing persisted in the console.
- If it does not, or requires a plan change: the app's detail view links directly to the provider's own log viewer for that app and environment, and the limitation is stated in the console.
- Queries are audit events.

**Depends on:** US-042

---

## Epic 7 — Alerts

## US-060 — Staleness detection and node-down alert

**Release:** R1

As the operator, I want to be told when a node stops reporting so that silence never goes unnoticed.

**Acceptance criteria**

- A node that misses three consecutive intervals moves to `stale` and an alert opens.
- Detection runs in the console and works when every node is silent at once.
- A dead node is flagged within four minutes at default settings.
- When the node reports again, the alert closes and its duration is recorded.
- A node flagged intermittent moves to `expected-offline` and opens no alert.
- If every node in a farm goes stale within a short window, one farm-level alert opens in place of one per node.

**Depends on:** US-013

## US-061 — Threshold and condition alerts

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

## US-062 — Notifications and alert history

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

---

## Epic 8 — Operations

## US-070 — Retention and rollups

**Release:** R5

As the operator, I want old data rolled up and purged automatically so that cost stays flat as the fleet grows.

**Acceptance criteria**

- Raw Snapshots and probe results older than 30 days are purged; hourly rollups are kept 13 months.
- Trend charts move from raw to rollup data without a visible seam.
- Retention periods are configurable.
- The console shows current data volume and its growth rate.
- Purge and rollup work is safe to re-run and reports its results.
- A projection at 8 nodes and 6 apps is documented against the database plan in use.

**Depends on:** US-013

## US-071 — Audit trail

**Release:** R5

As the operator, I want a record of every lifecycle and administrative action so that I can reconstruct what changed and when.

**Acceptance criteria**

- Audit events are recorded for: sign-in and sign-out; farm, node, app, and gateway create, change, and remove; enrolment issue and use; configuration changes; commands issued and their results; credential rotation and revocation; log queries; alert acknowledgements and silences.
- Each event records actor, action, subject, time, and outcome.
- Events cannot be edited or deleted through the console.
- The trail is searchable by subject, action, and time.
- Audit events for a removed farm survive a data purge.

**Depends on:** US-001

## US-072 — End-to-end acceptance run

**Release:** R5

As the operator, I want one command that proves the whole system works so that I can verify a deployment or diagnose a fault quickly.

**Acceptance criteria**

- One run exercises, against a designated test node: enrolment, heartbeat, configuration change and convergence, service-down detection, buffered replay, stale detection and alert, notification, log query, credential rotation, and removal with residue check.
- It also exercises a hosted-app probe against a test endpoint in each of its outcomes.
- Each step reports pass or fail with the reason; the run exits non-zero on any failure.
- The run cleans up everything it created.
- It is safe to run against the live console without affecting real nodes or sending real alerts to the operator.
- Its use is documented in the repository.

**Depends on:** all prior stories
