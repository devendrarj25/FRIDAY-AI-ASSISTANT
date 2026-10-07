# Final Architecture Principles

1. **One Brain:** all modalities and operating modes converge on the same canonical system state.
2. **One Truth Per Concept:** one owner for memory, task state, capability registry, model registry, governance, events, artifacts and execution truth.
3. **Durability Outside the Model:** model context is disposable; durable state lives in FRIDAY's state/journal stores.
4. **Evidence Over Claims:** tool output, health checks, tests and verification are authoritative; model prose is not.
5. **Lowest-Cost Reliable Control Path:** use native APIs, OS accessibility and deterministic selectors before vision or expensive model calls.
6. **Policy Before Effect:** authorization happens before privileged execution, not after.
7. **Human Activity Awareness:** FRIDAY yields, queues or pauses intrusive actions when the user is actively using the target application unless the task explicitly requires foreground takeover.
8. **Failure Is a State:** waiting, blocked, degraded, ambiguous and recovery-required are explicit states, not hidden exceptions.
9. **Self-Improvement Requires Evidence:** candidate changes are isolated, evaluated against a fixed regression suite, canaried and rollbackable.
10. **Provider Independence:** changing an LLM, STT, TTS or vision provider must not invalidate FRIDAY's durable identity, memory or task state.
11. **Cross-Surface Continuity:** Chat, Voice and Mobile can observe, interrupt, continue and hand off the same run.
12. **No Silent Scope Expansion:** capabilities discovered by research enter a controlled capability lifecycle before production use.
