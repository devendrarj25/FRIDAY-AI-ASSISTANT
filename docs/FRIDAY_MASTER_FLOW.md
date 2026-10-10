# FRIDAY — Master Operating Flow

**Current shipping version: 1.0.1.2**

🔁 The owner loop is indexed in `src/lib/friday/flow-chart.ts`. That module owns no behaviour: every node `resolve()`s a live module. Contract: `core/__tests__/owner-flow-chart.test.ts`. Layer map: [ARCHITECTURE.md](../ARCHITECTURE.md). Feature files: [FRIDAY_FEATURES.md](FRIDAY_FEATURES.md).

## Stages (in chart order)

| Id | Live owners (examples) |
| --- | --- |
| `owner` | Settings / `assistantMode` |
| `entry` | `voiceGate`, `matchWakeWord`, Chat dock |
| `experience` | `stage`, `notifications` |
| `supervisor` | `coreBrain`, `understand`, `resolveContext`, cognitive control and the cognitive mind inside `cognize` |
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
| `memory` | `memory`, `memory-fabric.ts`, `library`, `experiences` |
| `idle` | `autonomousCore` idle |
| `improvement` | `learning`, `devPipeline` (never auto-merges `main`) |

Wiring overlay (`src/lib/friday/wiring.ts` / `src/components/friday/WiringVisualizer.tsx`) reads the same `FLOW_CHART`. Permission, privacy, governance, billing, and tool-authority nodes have no owner toggle.

Flow Studio (`src/lib/friday/flow-graph.ts`) is that same chart as a version-1 graph. The Flow button opens the slice for the page you are on. Boxes can be dragged and wires reconnected. A real wire can change a setting or the router strategy. A box whose file is missing is shown as unwired. The list, the blocks, the canvas, and the code tab read this graph. A live watch paints only stages the current turn recorded, and a replay does not run them again.

`scripts/flow-registry.cjs` writes `src/lib/friday/flow-registry.gen.ts` from the routes, preferences, capability packs, IPC channels, kernel routes, and the eleven workflow files. `npm run docs:check` fails if that module drifts. Canvas modes are projections of one graph. A phone snapshot does not mutate it.

`core/brain/` graphs are Vitest contracts. The shipped EXE does not import `core/`.
