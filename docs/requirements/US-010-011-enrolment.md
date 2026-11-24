# US-010 Generate a node enrolment, US-011 (server side only): requirements

Scope of this slice: everything the console does so that a node can enrol. The installer script, the agent binary, its service registration, and the binary download path are the agent side of US-011 and arrive in R1 step 3 with US-013. Until then the command shown to the operator cannot be run end to end; the enrol API is tested directly.

## Decisions

- **Token**: `fce_` + 24 random bytes (192 bits, base64url). Single use, valid 60 minutes. Stored as SHA-256 only. SHA-256 (unkeyed) is deliberate for both enrolment tokens and node credentials: they are high-entropy random values, so a slow or keyed hash adds nothing, and an unkeyed hash means rotating `SESSION_SECRET` never invalidates the fleet.
- **Node credential**: `fcn_` + 32 random bytes. Returned once, in the enrol response. Stored as SHA-256 in `node_credentials`; revocable per node (`revoked_at`).
- **Node identity**: a UUID generated when the token is redeemed. Hostname is an attribute only. An enrolment is not a node; the node row appears at redemption with status `pending` (ARCH-001 s6), moving to `healthy` on the first heartbeat (US-013).
- **Initial configuration**: validated against `contracts/desired-config.v1.schema.json` and stored as version 1 in `node_configs` (US-020 later adds editing and history on the same table). Defaults: 60 s interval. The intermittent flag is part of Desired Config, so it lives there and nowhere else.
- **Schema validation without a new dependency**: a small JSON Schema subset validator (`server/schema.ts`) reads the contracts, which will also validate Snapshots in US-013. Vercel deploys only `/console`, so the contracts are copied into `server/contracts.generated.ts` by `npm run contracts:build`; a test fails if the copy is stale.
- **Refusals on the enrol endpoint**: a token that matches nothing returns one generic refusal. A token that matches a stored hash but is used, expired or cancelled returns a specific message, as US-010 requires; knowing that requires holding the real 192-bit token, so it leaks nothing to a guesser.
- **Platform check**: the agent reports its OS at redemption. A mismatch with the platform chosen in the console refuses the enrolment without consuming the token.
- **Install command**: `curl -fsSL <CONSOLE_URL>/install.sh | sudo bash -s -- --token <token>`. `CONSOLE_URL` env var is authoritative; the request origin is the fallback.
- **Limits**: at most 20 outstanding enrolments per farm; enrol request bodies over 8 KB are refused.
- **Not in this slice**: per-IP rate limiting of the enrol endpoint (192-bit tokens are not guessable; per-node ingest limits arrive with US-013), the installer, the binary download path.

## Acceptance criteria

### US-010
| Criterion | How it is met | Proof |
|---|---|---|
| Choose add node, pick platform, receive one command | `POST /api/farms/:id/enrolments`; UI Add node form | tests: response carries token and command; UI by typecheck/build only |
| Single use, one hour, clear refusal when expired or used | atomic claim inside a transaction; distinct codes `token_used`, `token_expired`, `token_cancelled` | tests, including two simultaneous redemptions of one token |
| Displayed once, cannot be retrieved, can generate new | only the hash is stored; list endpoint never returns the token | tests: no token in any table or audit event; list response has no token field |
| See outstanding enrolments and cancel them | `GET .../enrolments`, `DELETE .../enrolments/:eid` | tests |
| Pre-set display name, intermittent flag, initial configuration | validated at creation, applied at redemption | tests: node and config v1 reflect the presets; invalid config refused at creation |

### US-011, server side
| Criterion | How it is met | Proof |
|---|---|---|
| Installer enrols it; node `pending` at enrolment | `POST /api/enrol` creates node `pending` | test |
| Generated permanent identity; rename changes nothing else | node id is a UUID independent of hostname | test: identity stable, hostname stored as attribute |
| Credential shown once, stored non-reversibly | see decisions | test |
| Everything else in US-011 (service manager, permissions, idempotent installer, rollback, summary) | agent side, R1 step 3 | not in this slice |

Audit events: `enrolment.issue`, `enrolment.cancel`, `enrolment.use` (actor label `enrolment`, subject = the new node). None contains a token or credential.
