# US-011 (installer), US-021 (local CLI), US-024 (local removal): requirements

## What was built

**Console** (`/console`)
- `GET /install.sh` (rewritten to `api/install.ts`): the installer, served with the console address filled in. Source is `console/install/install.sh`, copied to `server/installScript.generated.ts` by `npm run contracts:build` (a test fails if stale). The address must be a bare `scheme://host[:port]` because it is spliced into shell; anything else is refused, so a spoofed Host header cannot inject commands. `CONSOLE_URL` is authoritative.
- `GET /api/agent/download?file=...`: authenticated by a valid, unused, unexpired enrolment token (not consumed). Serves only `fleetagent-linux-amd64`, `fleetagent-darwin-arm64` and `SHA256SUMS`. Finds the newest published, non-draft, non-prerelease release tagged `agent-v*` in the private repo with the console's GitHub token, and answers 302 to the short-lived signed URL. The binary is not proxied (no size limit, and the GitHub token never leaves the console). Every credential failure is one identical 401.
- `POST /api/ingest/ping`: lets `fleetagent test` check a credential, stores nothing.
- `POST /api/ingest/removed`: the agent's confirmation that it is gone. Marks the node `removed`, revokes its credentials, audits `node.remove`. A second call gets the same 401.
- `.github/workflows/agent-release.yml`: on tag `agent-v*`, tests, builds, publishes the binaries and checksums to Releases.

**Agent** (`/agent`)
- `fleetagent install`: copies itself to `/usr/local/bin/fleetagent`, creates the `fleetagent` system account, enrols, writes the systemd unit, enables and starts it, waits up to 30 s for the first heartbeat, prints identity, farm, console, service state and how to remove. Any failure undoes what that run did (LIFO), tells the console if it had already enrolled, and says whether anything was left. `--upgrade` swaps the program and unit and restarts, keeping identity, credential, configuration and sequence; a failed upgrade restores the previous program. `--reinstall` removes then enrols again (needs a new token).
- `fleetagent uninstall`: notifies the console while the credential still exists (best effort), stops and removes the service, then removes only the agent's own named files, the logs, the program and the account, and removes the state directory only if nothing else is in it. Then verifies: any leftover is listed and the exit is non-zero. Works with no network. Safe to run twice.
- Local diagnostics: `status`, `test` (DNS, reach, credential, snapshot, each its own line, later steps skipped after a failure), `config` (secrets masked at any depth), `selfcheck` (program, unit, service, permissions, ownership, identity, credential, config; non-zero on any failure), `help` (lists every command including removal).
- The agent logs to its own rotating file under its state directory (2 MiB ceiling), so removing the state directory removes the logs. The unit sends stdout and stderr nowhere.
- Flags `--dir --bin --unit --no-service --no-user` move paths or skip the service manager and account. They exist for containers, packaging and tests.

## Decisions

- Install logic lives in the Go binary, not the shell script. The script only downloads, verifies the checksum, and hands over; everything with branching and rollback is in tested Go.
- The enrolment token travels to curl on stdin and to the agent in the environment, never in a process argument list (tested by polling `/proc` during an install). The operator's own one-line command still contains it on the `sh` command line; that is the documented one-liner.
- The checksum file comes from the same release as the binary, so it catches corruption, not a compromised release store. Trust rests on TLS to the console and on the private repo.
- Service runs unprivileged. How `decommission` and `upgrade` get the privilege they need is DEC-006 (open, proposed).
- macOS install is US-012 (R2). On macOS `install` says so and stops.

## Acceptance

### US-011 (agent side)
| Criterion | Status | Proof |
|---|---|---|
| One command installs, enrols, starts; no prompts beyond privilege | Met with the service manager and account switched off; **real systemd, useradd and chown not yet run** (no systemd in the build container) | `e2e-install.test.mjs` runs the served script, real download and checksum, real binary |
| Registered with the service manager, starts at boot, restarts after a crash | Unit contents tested (`Restart=always`, `WantedBy=multi-user.target`, unprivileged, hardened). **Not run under real systemd** | unit test |
| `pending` at enrolment, `healthy` after the first heartbeat, within five minutes | Met | e2e test: pending after install, healthy after first heartbeat; installer waits for the service's first heartbeat |
| Permanent identity; rename changes only the hostname | Met earlier | |
| Credential and configuration readable only by the agent's account | Modes 0700/0600 asserted; ownership by the service account is fake-tested, real `chown` untested; `selfcheck` checks both | Go tests |
| Re-run reports the existing installation, changes nothing | Met | byte-identical file tree before and after; no second enrolment |
| Ends by printing identity, farm, console, service status, removal | Met | Go and e2e tests |
| Failed install leaves nothing behind | Met for failures at enrolment, account creation, chown and service start; console is told so no orphan stays `pending` | Go tests |

### US-021
All five met: status fields, step-by-step connectivity test, masked config, non-zero self-check on any failure, help listing every command including removal. Go tests for each failure mode; e2e runs them against the real console.

### US-024
| Criterion | Status |
|---|---|
| One local command removes everything in US-023's list with no network | Met (offline test) |
| Notifies the console when the network is available, node becomes `removed` | Met (e2e: console status `removed`, credentials revoked, audit event) |
| Otherwise the console shows the node stale and I can mark it removed manually, which revokes its credential | **Not in this slice.** Needs stale detection (US-060) and a manual "mark removed" action (with US-023) |
| Second run reports nothing installed and exits cleanly | Met |
| Prints a summary of what was removed | Met |
| Machine can be enrolled again as a new node afterwards | Met (e2e) |

## Not yet verified, and where it will be
1. **Real systemd, useradd, userdel, chown, boot start, crash restart**: first real run is UBUNTU-Dell01. Expect small fixes.
2. **The GitHub release path**: the workflow and the console's use of the real GitHub API are untested against GitHub (tests use a fake store). First real tag will prove them.
3. **`/install.sh` rewrite on Vercel** is untested until deploy.

## To run it on UBUNTU-Dell01
1. In Vercel set `CONSOLE_URL` (the console's public https address), `GITHUB_REPO` (`wattersbill72/FleetConsole`), `GITHUB_RELEASE_TOKEN` (fine-grained token, repository read access to Contents for this repo).
2. Tag and push: `git tag agent-v0.1.0 && git push origin agent-v0.1.0`; the workflow publishes the release.
3. In the console: farm, Add node, Ubuntu, copy the command, run it on the machine.
