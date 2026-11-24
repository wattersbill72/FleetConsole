# US-001 Operator sign-in, US-002 Register a farm: requirements

Built together because US-002 cannot be exercised without US-001 and the first slice needs the project skeleton, schema, audit writer and org scoping.

## Baseline dependencies (approved by Bill's "go" on the KPTR-equivalent stack; nothing else added without asking)

Runtime: `pg` (Postgres driver), `react`, `react-dom`. Build/dev: `typescript`, `vite`, `@vitejs/plugin-react`, `@vercel/node` (types), `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom`.
Not added: Tailwind, react-router (two screens do not need them; add with confirmation when routes multiply), any auth library (Node `crypto` only, per DEC-001).
`pg` rather than the Neon HTTP driver: it runs identically against the pooled Neon endpoint and a local Postgres, so the integration tests exercise the real code path.

## Decisions

- Layout: everything for the web app lives in `/console` (Vercel project root directory = `console`).
- Single org at launch. `users.org_id` carries ownership directly; no membership table until a second user or org exists.
- Passwords: scrypt (Node built-in), minimum 12 characters. Sessions: opaque random token, stored as HMAC-SHA256 (keyed by `SESSION_SECRET`), HttpOnly SameSite=Lax cookie, Secure in production.
- Session expiry: idle timeout 8 hours (`SESSION_IDLE_MINUTES`), absolute limit 30 days. Activity is stamped at most once a minute. Open point for US-030: the self-refreshing overview polls the API, which would keep a session alive forever; the poll will need to be excluded from the activity stamp.
- No self sign-up. The first operator is created by `npm run bootstrap`.
- Login throttle: 5 failed attempts per username in 15 minutes locks that username for the window. Unknown and wrong-password cases return the same message and take the same time (a dummy hash is verified).
- State-changing requests are refused when an `Origin` header is present and its host differs from the request host.
- Failed sign-ins are audited (outcome `failure`); the attempted username is not stored for unknown users, because a mistyped password in the username field would land in the audit trail.
- Product name: `organisations.product_name`, default "Fleet Console" (DEC-003). Read by the UI via `GET /api/branding` (returns the name only) and `/api/auth/me`. No edit screen yet; set it in SQL until the settings story exists.
- Farm time zone is validated against the runtime's IANA list. Farm name: 1 to 80 chars, trimmed, unique per org ignoring case.
- Audit writer (`server/audit.ts`) is the single entry point for audit events and takes the caller's transaction, so a change and its audit record commit or fail together.

## Acceptance criteria

### US-001
| Criterion | How it is met | Proof |
|---|---|---|
| Unauthenticated visitor sees nothing about farms, nodes, apps and is sent to sign-in | Every data route is wrapped in `withAuth` (401, no body detail); the SPA shows only the sign-in screen without a session | test: unauthenticated list/get/create/patch all 401; unauthenticated `me` 401 |
| After sign-in every record belongs to my organisation | All queries filter by `ctx.orgId` | test: second org's user cannot list, read or edit the first org's farm (404) |
| Sessions expire after inactivity; explicit sign-out | Idle and absolute limits checked on every request; logout deletes the session row and clears the cookie | tests: aged session 401; logout then reuse of token 401 |
| Sign-in and sign-out are audit events | `auth.sign_in` (success and failure), `auth.sign_out` | tests read `audit_events` |
| OD-3 decision recorded | `docs/decisions/001-identity.md` | file exists (written before this story) |

### US-002
| Criterion | How it is met | Proof |
|---|---|---|
| Create with name, site description, time zone | `POST /api/farms` | test |
| Names unique within org | unique index on `(org_id, lower(name))`; 409 with a clear message | test incl. different case; same name allowed in another org |
| Rename / edit description without affecting nodes | `PATCH /api/farms/:id` touches the farm row only; there are no node rows yet, and nodes reference the farm by id, never by name | test that the id is stable; node-side check lands with US-010 |
| New farm shows an empty state leading to enrolling the first node | Farm view shows the empty state with an "Add node" action. The action is a stub until US-010 delivers enrolment. **Partially met until US-010.** | UI only; cannot be proven by test here |
| Creation and edits are audit events | `farm.create`, `farm.update` with before/after of changed fields | tests |

## Not covered, deliberately
- Editing the product name from the UI.
- Password change/reset (single operator; use the bootstrap script with `--reset`).
- UI behaviour is verified by typecheck and `vite build` only; per CLAUDE.md no dev server is run in this environment.

## Running and deploying (for Bill)

- Tests: `cd console && npm install && npm test`. Starts a throwaway local Postgres, migrates, runs 23 integration tests, tears down. Needs Postgres server binaries (present in the Claude Code container).
- Vercel: new project from this repo, **Root Directory = `console`**. Environment variables: `DATABASE_URL` (pooled string from the new Neon project, DEC-005), `DATABASE_URL_UNPOOLED` (for migrations, optional), `SESSION_SECRET` (`openssl rand -hex 32`).
- First deploy, by hand: `DATABASE_URL_UNPOOLED=... npm run migrate`, then `FLEET_OPERATOR_PASSWORD='...' DATABASE_URL_UNPOOLED=... npm run bootstrap -- --username <you> --org "<name>"`.
- Accepted tradeoff: the login lockout is per username, so someone who knows the username can lock the operator out for 15 minutes by failing five times. Chosen over per-IP limits, which Vercel's shared proxy headers make unreliable. Reset path: wait, or `npm run bootstrap -- --reset`.
