# One Brain Interaction Runtime

## Runtime model
`Surface ingress → canonical turn → continuity → cognitive context → objective → planner → universal router → capability/model selection → governance → execution → observation → verification → task/artifact state → event publication → surface projection`.

The path is not a fixed linear pipeline. Simple questions may stop after cognition and response composition. Research, browser, computer-use, code, device and long-running jobs branch into task/execution paths. The same identity and governance contracts remain attached.

## Shared state ownership
- Brain/cognition: existing cognitive owners.
- Conversation continuity: existing conversation/session state.
- Goals/commitments: existing goal/commitment engine.
- Tasks: existing task graph/ledger/runners.
- Capabilities: existing capability registry and specialized routers.
- Models: existing model registry/router.
- Memory/knowledge: existing memory/retrieval/knowledge owners.
- Authority: existing governance/action-risk/tool-authority chain.
- Execution: existing Electron/kernel/browser/device/sandbox owners.
- Events: existing event/bridge/streaming owners.
- Presentation: ChatDock/Voice UI/Companion only.

## No second brain rule
A surface may cache presentation state, but it cannot persist a competing task status, model selection, memory record, approval state or execution truth. If local UI state disagrees with the runtime, runtime state wins.

## Realtime synchronization
Every meaningful state transition emits an event with sequence/cursor information. Clients render optimistically only for presentation; authoritative state is reconciled from the runtime. Reconnect uses snapshot + cursor rather than replaying a user action.

## Cross-surface control
Interrupt, cancel, pause, resume, approve, reject, reprioritize, redirect, inspect, request evidence and retrieve latest artifact are runtime commands. Any surface can request them if its authenticated capability scope allows them.
