# Source Integration Map — Existing FRIDAY Owners

| Interaction requirement | Existing authoritative owner | Integration intent |
|---|---|---|
| Chat surface | `src/components/friday/ChatDock.tsx` | presentation/session wiring only |
| Brain entry | `src/lib/friday/brain-engine.ts` | shared turn ingress |
| Core cognition | `src/lib/friday/brain/core-brain.ts` | no duplication |
| Context | `src/lib/friday/brain/context-engine.ts`, conversation state, retrieval | bounded context |
| Orchestration | `src/lib/friday/brain/orchestrator.ts` | plan/execute/observe/verify |
| Routing | capability/model/specialized routers | extend, do not replace |
| Memory | existing memory/knowledge modules | shared across surfaces |
| Tasks | `src/lib/friday/self/task-graph.ts`, ledger/runners | durable truth |
| Background/autonomy | existing background/autonomous modules | Manual/Auto policy bridge |
| Voice | `voice-audio.ts`, `voice-stt.ts`, `voice-state.ts`, wake modules | media plane over shared runtime |
| Voice runtime | `electron/stt.cjs`, `kernel/stt.py` | provider/media execution |
| Companion | `companion-live.ts`, `bridge.ts`, `remote-access.cjs` | remote endpoint |
| Authority | governance/action-risk/tool-authority | one gate |
| Execution | Electron/kernel/sandbox/browser/device owners | actual side effects |
| Events | existing event bus/bridge/streaming | one fabric |
| Models/providers | model registry/engine/provider registry | health-aware routing |
| Health | doctor/service-health/provider health | evidence, not UI claims |
| Artifacts | existing artifact/presentation owners | surface-specific rendering |

## Touch rule
Before adding any module, search the repository for an existing owner. Extend it if possible. New code is justified only when there is no authoritative owner or the current owner cannot satisfy the contract without unsafe coupling.
