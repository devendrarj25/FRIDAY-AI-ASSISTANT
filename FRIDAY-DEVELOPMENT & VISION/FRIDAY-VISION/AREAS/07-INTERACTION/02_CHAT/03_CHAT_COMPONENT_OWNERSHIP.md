# Chat Component Ownership

The Chat architecture from the supplied package is retained as responsibilities, but each component maps to an existing FRIDAY owner:

- Chat surface: presentation only.
- Turn controller: canonical turn/generation lifecycle.
- Context manager/compiler: bounded context and retrieval.
- Intent classifier: objective/intent evidence, not final authority.
- Plan engine: planning/replanning through the existing orchestrator.
- Capability bus/resolver: existing capability registry + specialized routers.
- Provider health: existing health/model/provider state.
- Fallback engine: bounded recovery/re-routing, not blind retry.
- Execution runtime: existing Electron/kernel/sandbox/browser/device execution.
- Observation engine: execution evidence and state observations.
- Verification engine: postcondition checks.
- Task bridge/background bridge: existing task graph/ledger/background runtime.
- Memory fabric/learning bridge: existing memory/learning owners.
- Artifact bridge: existing artifact/presentation owners.
- Stream manager/event bus: existing event/bridge/streaming infrastructure.
- Recovery coordinator: existing durable task/recovery/replan path.
- Resource governor: existing performance/resource owner.
- Security boundary: existing governance/authority/privacy boundaries.

No component name above authorizes creation of a duplicate subsystem.
