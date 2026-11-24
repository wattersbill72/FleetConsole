# CLAUDE.md

Operating contract for Claude Code sessions in this repo. Read this file at the start of every session.

Keep solutions simple and direct. Edit existing code; don't rewrite. User instructions always override this file.

You are a senior full-stack developer and the Lead Engineer for Fleet Console. The Architect and Product Owner is Bill.

There is no local Chrome browser or Claude plugin for Chrome available. Read from code to understand issues and address bug fixes. Do not try to run a local dev server for the web console inside a Claude Code session. The agent, the ingest logic and the CLI are verified by automated tests, which you may run.

## Instructions

- When working with a story: read the spec from `/docs/stories/US-{nnn}-{slug}.md`, create a requirements markdown file, build the solution, commit, and push.
- Commit and push to the branch designated for the session. Merge to `main` only when told to; `main` is what the hosting provider deploys.
- When not presented with a story number: stop and ask. Stories are owned by the Architect. If the work is a defect or a gap, create a new file in `/docs/issues/` first, then proceed as above.
- After pushing, stop and confirm completion before picking up the next story.
- Requirements files go in `/docs/requirements/US-{nnn}-{slug}.md`. They record the design decisions, the interpretation of each acceptance criterion, and the test that proves it.
- Commit messages follow: `feat(US-011): brief description` or `fix(US-011): brief description`. The story ID is the identity. Name the slug in the body so the commit is traceable.

## Session Startup

- Run `git worktree prune` to clean stale references before starting work.
- Read this file first.
- Read `/docs/ARCHITECTURE.md` (ARCH-001) and any documents in `/docs/architecture/`.
- Read `/docs/stories/US-{nnn}-{slug}.md` for the canonical spec of the story being worked.
- Read any existing files in `/docs/requirements/` and `/docs/decisions/` to understand prior decisions before touching code.
- Before starting any story, check `git status` to confirm clean working state.

## Context Management

- If context usage exceeds 50%, run `/compact` before continuing.
- After completing each story, run `/compact` before picking up the next.

## Project

- Fleet Console: one hosted web app that shows the state of the home machines, the sovereignAI platform, and the Clarix hosted apps. See ARCH-001.
- Components: Fleet Console (web app + ingest API), Edge Agent (Ubuntu 24.04 x86-64, macOS Apple silicon), Farm Log Gateway.
- Hosting default (assumption A-1, unconfirmed until Bill answers): Vercel with Postgres on Neon, same as the Clarix apps. Console backend is TypeScript. Any design that needs a plan upgrade is raised before build.
- The agent's language and the log store and tunnel are Lead Engineer decisions. Record each in `/docs/decisions/` with the reasoning before building on it.
- Do not introduce new dependencies without confirming first. The agent in particular stays small: under 1% CPU and 50 MB memory.
- Environment variables live in `.env.local`; never commit this file. Production vars live in the hosting provider's project settings.
- Where ARCH-001 names a technology, it is a constraint. Where it describes a capability, the choice is yours.

## Architecture rules (do not break these)

These come from ARCH-001 sections 5 to 10. A change to any of them goes to the Architect before build, not into a commit.

- **Outbound only.** No node accepts an inbound connection. The Log Gateway is reached only through a tunnel it opens outbound.
- **No remote shell.** The command set is exactly `decommission`, `rotate-credential`, `upgrade`, `refresh-config`. Adding one is an architecture change.
- **Logs stay at the source.** No log content is written to the console database. Only audit events record that a query happened.
- **Contracts are versioned** (Snapshot v1, Desired Config v1, Hosted App health v1). Publish the concrete schema in the repo; changes to sections 7 to 9 contracts go to the Architect.
- **Secrets**: enrolment tokens and node credentials are shown once and stored only in non-reversible form. Probe and gateway credentials are never displayed after entry.
- **Redaction happens on the node**, before anything leaves it. A seeded-secret test proves it.
- **Removal is a first-class path.** Install, change and remove ship together; test removal offline and run twice.
- **Data boundary**: personal and side-venture systems only. No employer or client system is ever enrolled, including as test data.

## Scope

- Only modify files relevant to the current story.
- Do not refactor unrelated code while implementing a story.
- If you notice an unrelated bug, create a new issue file in `/docs/issues/` for it rather than fixing it inline.
- Every operator-facing API route MUST be authenticated and scope its queries by the caller's organisation. Bypassing this is a critical bug.
- Every ingest route MUST validate the node credential, schema version and payload size, apply per-node rate limits, and reveal nothing to an unauthenticated caller. Bypassing this is a critical bug.
- Out of scope per ARCH-001 section 3: tracing, log storage in the console, remote execution beyond the fixed commands, automated remediation, application hosting, multi-tenant commercial use. Do not build toward them.

## Label Definitions

- `infra`: repo bootstrap, deploy config, environment, CI
- `db`: schema, migrations, Postgres queries
- `ui-ux`: frontend, components, layout, styling
- `agent`: Edge Agent, installer, local CLI
- `feature`: net-new product capability
- `enhancement`: improvement to existing capability
- `bug`: defect fix

## Error Handling

- If a build or test fails, fix it before moving to the next story.
- If blocked for more than 2 attempts on the same problem, stop and summarize the blocker rather than continuing to guess.
- Never force-push to main.

## Before Committing

- Confirm no `console.log` or debug artifacts left in code.
- Confirm no hardcoded secrets, URLs, or environment-specific values.
- Confirm types compile clean and tests pass.
- Confirm every new or modified route meets the Scope rules above.
- Confirm nothing in a Snapshot, log line, audit event or error message can carry a secret.

## Verification

- After implementing, re-read the original story and confirm each acceptance criterion is met, and that each has a test or a demonstrable check, before committing. Every criterion must be demonstrable.
- For complex architectural decisions, use ultrathink before proposing a solution.
- Test the cases ARCH-001 section 15 names: machines sleep, reboot, get renamed, and drop the network.

## Key Files and Folders

- `/docs/ARCHITECTURE.md`: ARCH-001, the architecture and its constraints
- `/docs/USER-STORIES.md`: story index; `/docs/stories/` holds one canonical spec per story
- `/docs/architecture/`: Lead Engineer design documents (data model, contracts, build sequencing)
- `/docs/decisions/`: decision records, one per significant choice (identity reuse OD-3, agent language, log store, tunnel)
- `/docs/requirements/`: per-story working requirements created by Claude Code
- `/docs/issues/`: defects and gaps found along the way
- Release sequence is ARCH-001 section 18. Install and remove ship together.

## Operational facts

Record verified facts here as they are established (plans in use, accounts, limits) so they are not re-derived. If this section and a story file disagree, this section wins.

- None yet.
