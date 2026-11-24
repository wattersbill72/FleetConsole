# DEC-003: Repository layout, distribution, naming

Status: Accepted. Date: 2026-11-24.

- Single repo: `/console` (web app + ingest API), `/agent` (Go), `/contracts` (JSON Schema), `/docs`.
- Agent binaries are built by CI and published to this repo's private GitHub Releases. The repo stays private. The install command therefore cannot fetch from GitHub unauthenticated; the console serves the binary and installer to enrolling nodes, authenticated by the single-use enrolment token (the console proxies the release asset using a server-side GitHub token). Nodes never hold a GitHub credential.
- Product name: "Fleet Console" is a runtime setting, not a constant. It is stored on the organisation record (`product_name`, default "Fleet Console") and read by the UI, email templates, and installer output. Logos and colours are out of scope until branding is wanted. Code identifiers, the agent binary name and the CLI command use a fixed neutral internal name (`fleetagent`).
