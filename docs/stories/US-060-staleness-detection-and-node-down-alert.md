# US-060 — Staleness detection and node-down alert

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R1

As the operator, I want to be told when a node stops reporting so that silence never goes unnoticed.

**Acceptance criteria**

- A node that misses three consecutive intervals moves to `stale` and an alert opens.
- Detection runs in the console and works when every node is silent at once.
- A dead node is flagged within four minutes at default settings.
- When the node reports again, the alert closes and its duration is recorded.
- A node flagged intermittent moves to `expected-offline` and opens no alert.
- If every node in a farm goes stale within a short window, one farm-level alert opens in place of one per node.

**Depends on:** US-013
