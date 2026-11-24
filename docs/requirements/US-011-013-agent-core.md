# US-011 / US-013, agent core: requirements

Scope of this slice: the `fleetagent` binary (`/agent`, Go, standard library only, no dependencies): enrol, heartbeat loop, host vitals on Ubuntu and macOS, private on-disk state. Not in this slice: the installer script and service registration, the `/install.sh` and binary download routes on the console, the local CLI (US-021), local uninstall (US-024), store-and-forward (US-015), services (US-014), error tail (US-016).

## What it does

- `fleetagent enrol --console <url>` with the token in `FLEETAGENT_TOKEN` (or `--token`). Exchanges the token for identity, credential and config v1; writes them to the state directory. Refuses to enrol a machine that is already enrolled; prints node, farm and console, never the credential.
- `fleetagent run [--once]`: heartbeat immediately, then every `heartbeat_interval_s` from the applied config (default 60). Stops cleanly on SIGINT/SIGTERM.
- `fleetagent version`.
- State directory: `/var/lib/fleetagent` (Ubuntu), `/usr/local/var/fleetagent` (macOS), or `--dir` / `FLEETAGENT_DIR`. Directory 0700, files 0600, atomic replace. `run` refuses to start if anything is readable by group or others. Enrolment writes the credential and config first and the identity file last; identity is the "enrolled" marker, so a crash mid-write leaves a machine that can enrol again.
- Sequence number is persisted before each send, so it never repeats across restarts or reboots. A corrupt counter is an error, never a silent restart at 1. If the console already holds that number (counter lost), the response's `last_seq` makes the agent jump past it.
- Failure handling: a failed heartbeat is logged when the problem starts or changes and again on recovery, not every minute; a 429 `Retry-After` longer than the interval is honoured; a newer console config version is noticed and logged once (applying config is US-020). Heartbeats lost while the console is unreachable are not kept until US-015.
- Transport: HTTPS only. Plain http is accepted for loopback addresses so tests can run; anything else is refused.

## Vitals

| Vital | Ubuntu | macOS |
|---|---|---|
| CPU % | `/proc/stat` delta between heartbeats (first heartbeat takes a 250 ms second sample) | `top -l 2 -s 1`, second sample |
| Load | `/proc/loadavg` | `sysctl vm.loadavg` |
| Memory | `MemTotal` minus `MemAvailable` | `hw.memsize`; used = active + wired + compressor pages from `vm_stat` (an approximation of Activity Monitor) |
| Uptime | `/proc/uptime` | `kern.boottime` |
| Disks | `statfs` on configured volumes, default `/` | same |
| Addresses | non-loopback IPv4 | same |
| Temperature | hottest thermal zone, null if none | always null (no unprivileged source) |

A vital the platform does not expose is JSON null, never zero (tested).

**macOS status: not verified on a Mac.** The darwin code compiles (`GOOS=darwin GOARCH=arm64 go vet` and `./build.sh`) and the output parsers are tested against fixture text in the documented formats. Nobody has run it on real macOS yet. Treat the first run on the Mac mini as the verification, and expect to fix a parser. `top` adds about a second of wall time to each macOS heartbeat.

## Build

`agent/build.sh <version>` cross-compiles `linux/amd64` and `darwin/arm64` (`CGO_ENABLED=0`, about 6 MB each) into `agent/dist/` with `SHA256SUMS`. Version is injected with `-ldflags -X main.version`.

## Footprint (US-013 criterion: measured and recorded)

Measured on this Ubuntu 24.04 machine: the real binary running against a local stub console at a 30-second interval (twice the default rate) for 97 seconds, 4 heartbeats.

| Measure | Result |
|---|---|
| Resident memory | 7.1 MB (peak equals current) |
| CPU time | under one 10 ms scheduler tick in total, so well under 0.01% average; below the resolution of this measurement |

Bill relaxed the 50 MB budget (DEC-002); the agent is far inside it anyway. macOS footprint not yet measured.

## Acceptance mapping

| Story criterion | Status | Proof |
|---|---|---|
| US-013: Snapshot (envelope, host, agent health) every 60 s by default | Met | Go runner tests; real binary against real console handlers |
| US-013: outbound HTTPS only, no inbound port | Met: the agent opens no listener; http refused except loopback | Go client tests |
| US-013: footprint measured and recorded | Met on Ubuntu | table above |
| US-011: node `pending` then `healthy`; permanent identity; credential private | Met | cross-language test: enrol shows `pending`, first heartbeat `healthy`; modes 0700/0600 asserted; permission check refuses a 0644 credential |
| US-011: installer, service manager, boot start, crash restart, idempotent re-run, rollback on failure, final summary | Not in this slice | next slice |
| US-010: refusal "on the node" for used or expired token | Met | cross-language test: the console's message reaches the agent's stderr |

## Tests

Go: `cd agent && go test ./...` (state, parsers, live Ubuntu collection, client, runner). Cross-language: `console/test/e2e-agent.test.mjs` builds the real Go binary and drives it against the real console handlers over HTTP (enrol, three heartbeats across process restarts with sequence 1, 2, 3, token reuse, second enrol refused, revoked credential, insecure permissions, plain-http refusal). It skips if Go is not installed.
