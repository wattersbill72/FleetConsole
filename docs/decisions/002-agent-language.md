# DEC-002: Edge Agent language

Status: Accepted (Bill may overrule). Date: 2026-11-24.

Decision: Go. One static binary per platform (linux/amd64, darwin/arm64), cross-compiled from one codebase.

Reasoning: the 50 MB memory budget was arbitrary and is lifted; the deciding factors are now install, run and maintain. Go ships with no runtime on the node, so the one-command install, self-upgrade, and clean removal are a file copy plus a service registration. Node/TypeScript would give one language across the repo but would require a runtime on every machine, with its own upgrade and removal footprint. Cost accepted: a second language in the repo.

Mitigation: Snapshot and Desired Config are defined once as JSON Schema in `/contracts`; the console (TypeScript) and agent (Go) both validate against them, so the languages do not drift.

Footprint: still measured and recorded (US-013), no longer a hard gate. Target stays modest, not enforced.
