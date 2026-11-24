# US-023 Remove a node from the console (and the rest of US-024): requirements

## What was built

**Console**
- `POST /api/nodes/:id/remove` `{ confirm_name, history: keep|purge }`: the operator must type the node's name exactly. The node becomes `decommissioning`, a `decommission` command is queued, the history choice is stored, and `node.decommission.request` is audited. Repeating it is harmless (one command, one audit event). If the agent reported it could not remove itself, asking again queues a new command and restarts the clock.
- **Command queue** (`node_commands`, migration 0006): at most one live command of each kind per node. The heartbeat response carries live commands and re-sends them until the agent settles them; the agent reports a failure in `agent_health.last_command_result`, which the console records with its reason and stops re-sending. Only `decommission` is implemented; the agent reports the other three as "not supported by this agent version".
- **The agent's confirmation** (`POST /api/ingest/removed`, now with a body `{ verified, residue[] }`): marks the node `removed`, revokes every credential, settles the command as confirmed, closes the node's alerts, applies the history choice, and audits `node.remove` with the agent's own verification. A second call is the same 401 as any revoked credential.
- **History**: keep (default) leaves snapshots and configuration for the retention job (US-070). Purge deletes the node's snapshots, rate counters and configuration history and clears its attributes; the node's name, its alerts and the audit trail always remain (US-025, US-071).
- **No confirmation in 15 minutes**: the cron run (`expireDecommissions`) revokes the credential anyway, expires the command, audits `node.decommission.timeout`, and opens a `removal_unconfirmed` alert, so you are told by email like any other alert, with the instruction to run `sudo fleetagent uninstall` and then mark the node removed. The node stays `decommissioning`: the console never says `removed` without the agent's confirmation or the operator's word. Asking again is refused with the same instruction, because the credential is gone.
- **Operator override** (`POST /api/nodes/:id/mark-removed`, same confirmation): for a machine that is gone, was wiped, or had the local uninstall run (this completes US-024's manual path). Revokes credentials, cancels commands, closes alerts, audits `node.remove` with `via: operator`. Works on any node, including stale and pending ones.
- Overview and farm node lists show removal state: "Removing", "Removal not confirmed", and the agent's own reason when it could not comply. The farm page has the Remove and Mark removed flows, with the name typed to confirm and the history choice.

**Agent**
- Handles `decommission` from a heartbeat response: stops heartbeating, removes itself, and exits. A failure is reported once in the next heartbeat and heartbeats continue.
- **Removal order** (`Uninstall`): read the credential, remove everything, verify nothing remains, then tell the console with the verification result. The console therefore hears "removed" only after the machine has been checked, and a leftover is recorded rather than hidden.
- **DEC-006 option B, implemented.** The service stays unprivileged. When it cannot remove itself, it writes `decommission.request` in its own state directory and waits to be stopped. Two root-owned units, installed with the agent: `fleetagent-maint.path` watches that one file and starts `fleetagent-maint.service` (`Type=oneshot`, `User=root`), which runs `fleetagent maintenance decommission`. That command acts only if the request is a regular file (a link is refused), reads nothing from it, and runs the same uninstall as the local command. If nothing removes the agent within 2 minutes it takes its request back, reports why, and carries on.
- When the agent already runs as root it removes itself in-process, which is the path the end-to-end test uses.
- The uninstall never follows a link planted in the state directory (it can run as root against a directory the unprivileged agent controls): a linked state directory or `logs` directory is removed as a link and nothing behind it is touched. Tested.
- Install writes the two maintenance units; uninstall, rollback and `selfcheck` account for them.

## Acceptance

### US-023
| Criterion | Status | Proof |
|---|---|---|
| Removal requires explicit confirmation naming the node | Met | tests: missing, wrong-case, empty name and missing history choice are refused and change nothing |
| `decommissioning`; next heartbeat delivers the command; agent stops reporting, uninstalls, confirms | Met against the real binary, with the service manager off | e2e: command delivered in the heartbeat response, agent removes itself and confirms, sends no further heartbeats (Go test) |
| After confirmation `removed`, credential revoked | Met | tests, including that a second confirmation and any later heartbeat are the same 401 |
| Nothing of the agent remains; nothing else touched; a verification proves it | Met in-process | e2e: files gone, bystander files beside the program and the state directory untouched, agent's own verification `{verified: true}` recorded; Go tests for links, partial installs and leftovers |
| No confirmation in time: console says so, revokes anyway, tells me to run the local uninstall | Met | test: nothing before 15 minutes; then credential revoked, alert opened and queued for email, screen shows "Removal not confirmed" with the command to run |
| Keep or purge history | Met | tests for both; audit trail survives a purge |
| Removal is an audit event | Met | request, timeout and removal are each audited with actor, history choice and the agent's verification |

### US-024 (remaining parts)
Met: the operator can mark a node removed (revokes its credential); a stale node whose machine is gone can be marked removed with no uninstall ever requested.

## Not verified, and what that means

1. **The privileged path has never run under real systemd.** The path unit firing on the request file, the root service running the uninstall, the helper stopping the agent's own service, and the unprivileged agent exiting cleanly are tested with fakes and unit text only. The first real run is UBUNTU-Dell01, and I expect to adjust something there. If it fails, the agent reports "the maintenance helper did not remove the agent", the screen shows it, and "Try again" and "Mark removed" remain available.
2. The 15-minute timeout and the 2-minute helper wait are my choices; heartbeat intervals go to 5 minutes, so the console's window is three of them.
3. UI not run in a browser (see US-030 note).

## R1 status
Every R1 story is now built: US-001, 002, 010, 011, 013, 021, 023, 024, 030, 060, 062. What remains for R1 is proof on real machines.
