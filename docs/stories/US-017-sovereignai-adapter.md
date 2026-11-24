# US-017 — sovereignAI adapter

Architecture: `../ARCHITECTURE.md` (ARCH-001 REV A)


**Release:** R2

As the operator, I want nodes that run sovereignAI to report its state so that I see the AI platform alongside the machines it runs on.

**Acceptance criteria**

- Where enabled in Desired Config, the agent reads SIS and SISC status from their existing local interfaces and includes the sovereignAI group in the Snapshot (ARCH-001 section 9.1).
- Reported at minimum: component, node role, loaded models, memory budget used and total, request and token throughput, and the inference nodes SISC knows with their state.
- SIS, SISC, and the sovereignAI console are reported as services with up/down state.
- If sovereignAI is installed but stopped, the adapter reports it as down and the agent keeps running normally.
- No change to the sovereignAI codebase is required. If one would materially simplify the adapter, it is proposed to the Architect first.
- The Lead Engineer has reviewed `WB72_SoveriegnAI_Server` and documented which interfaces the adapter uses.

**Depends on:** US-014
