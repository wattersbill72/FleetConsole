# US-032 — sovereignAI view

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want a view of the sovereignAI platform as a whole so that I see the AI stack's health without assembling it from individual nodes.

**Acceptance criteria**

- One view shows each sovereignAI component, the node it runs on, its state, loaded models, memory budget, and throughput.
- Inference nodes known to SISC are listed with their state; one that SISC reports as down is flagged even if its machine is healthy.
- Throughput and memory trends cover the same ranges as US-031.
- Each component links to its node's detail view.
- If no node reports sovereignAI, the view explains how to enable the adapter.

**Depends on:** US-017, US-031
