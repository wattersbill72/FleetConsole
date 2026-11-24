# DEC-006: Agent privilege and self-maintenance (OPEN; decide when building US-023)

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
