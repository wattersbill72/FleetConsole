# DEC-006: Agent privilege and self-maintenance (ACCEPTED, implemented for decommission in US-023; upgrade still open)

Status: Proposed by the Lead Engineer. No Architect decision needed unless the recommendation is rejected; ARCH-001 s10 already requires least privilege.

## Facts

- The installer runs the service as the unprivileged account `fleetagent`. State is owned by that account; the program and unit are root-owned.
- Two console commands need to change root-owned things: `decommission` (US-023: remove program, unit, account, state) and `upgrade` (US-022: replace the program). An unprivileged agent cannot do either.
- Local `fleetagent uninstall` and `fleetagent install --upgrade` already exist and work under sudo.

## Options

| Option | Benefit | Cost | Risk |
|---|---|---|---|
| A. Run the service as root | Simplest; agent does everything itself | Every agent bug or console compromise runs as root | Largest blast radius; contradicts least privilege |
| B. Unprivileged agent plus a root-owned systemd path unit that runs a fixed maintenance action when the agent drops a request file | Agent stays unprivileged; the root part is a few lines that run the root-owned binary with a fixed verb | Two more units to install and remove | The helper must never trust files the agent can write: for `decommission` it needs nothing staged; for `upgrade` it must download and checksum the new binary itself from the console |
| C. A sudoers rule letting the service account run `fleetagent maintenance <verb>` | Small | Edits to /etc/sudoers.d, which is more invasive to install and remove cleanly | Same trust issue for upgrade as B |

## Recommendation

B. Build `decommission` through it in US-023 (nothing is staged, so there is no way for the agent account to smuggle in code). Revisit `upgrade` in US-022: the helper does its own authenticated download and checksum check, and never executes anything the agent staged.

Accepted regardless of option: the console can already make a node run a new program via `upgrade`, so the console is inside the node's trust boundary. Privilege separation protects against a bug in the agent, not against a hostile console.

## Update 2026-11-24: option B built for `decommission`

Implemented as recommended: unprivileged agent, root-owned path unit watching one request file, root oneshot service running a fixed `maintenance decommission` action. Hardening added: the helper acts only if the request is a regular file (a link is refused), reads nothing from it, and the uninstall never follows links in the agent-controlled state directory. Details in `docs/requirements/US-023-remove-a-node-from-the-console.md`.

Still open for US-022 (`upgrade`): the helper must download and checksum the new binary itself from the console, authenticated with the node credential, and never execute anything the agent staged. Not built.
