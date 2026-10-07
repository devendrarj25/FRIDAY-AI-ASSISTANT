# FRIDAY — Master Operating Flow

**Current shipping version: 1.0.0.2**

The owner loop is indexed in `src/lib/friday/flow-chart.ts`. That module owns no behaviour: every node `resolve()`s a live module. Contract: `core/__tests__/owner-flow-chart.test.ts`. Layer map: [ARCHITECTURE.md](../../../../../ARCHITECTURE.md). Feature files: [FRIDAY_FEATURES.md](../../../../../docs/FRIDAY_FEATURES.md).

## Stages (in chart order)

| Id | Live owners (examples) |
| --- | --- |
| `owner` | Settings / `assistantMode` |
| `entry` | `voiceGate`, `matchWakeWord`, Chat dock |
| `experience` | `stage`, `notifications` |
| `supervisor` | `coreBrain`, `understand`, `resolveContext` |
| `voice-runtime` | `nextVoiceState`, `wakeEngineStatus` |
| `thinking` | `planPipeline`, `classifyPriority` |
| `task-runtime` | `taskGraph`, `backgroundTasks` |
| `orchestrator` | `planPipeline`, `considerCollaboration` |
| `model-router` | `modelRegistry`, `kernel/router.py` |
| `agents` | `listAgentsFromRegistry` |
| `capability-bus` | `capabilityRegistry`, skill/tool/module/connector/workflow routers |
| `permission` | `actionNeedsApproval`, `governance` |
| `execution` | kernel `kernel/tools.py` + desktop IPC |
| `verification` | `verifyResult` (spec) plus live Doctor/ops |
| `memory` | `memory`, `library`, `experiences` |
| `idle` | `autonomousCore` idle |
| `improvement` | `learning`, `devPipeline` (never auto-merges `main`) |

Wiring overlay (`src/lib/friday/wiring.ts` / `src/components/friday/WiringVisualizer.tsx`) reads the same `FLOW_CHART`. Permission, privacy, governance, billing, and tool-authority nodes have no owner toggle.

`core/brain/` graphs are Vitest contracts. The shipped EXE does not import `core/`.
