# FRIDAY — Master Operating Flow

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

**Current shipping version: 1.2.5.7**

🔁 The owner loop is indexed in `src/lib/friday/flow-chart.ts`. That module owns no behaviour: every node `resolve()`s a live module. Contract: `core/__tests__/owner-flow-chart.test.ts`. Layer map: [ARCHITECTURE.md](../ARCHITECTURE.md). Feature files: [FRIDAY_FEATURES.md](FRIDAY_FEATURES.md).

## Stages (in chart order)

| Id               | Live owners (examples)                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `owner`          | Settings / `assistantMode`                                                                             |
| `entry`          | `voiceGate`, `matchWakeWord`, Chat dock                                                                |
| `experience`     | `stage`, `notifications`                                                                               |
| `supervisor`     | `coreBrain`, `understand`, `resolveContext`, cognitive control and the cognitive mind inside `cognize` |
| `voice-runtime`  | `nextVoiceState`, `wakeEngineStatus`                                                                   |
| `thinking`       | `planPipeline`, `classifyPriority`                                                                     |
| `task-runtime`   | `taskGraph`, `backgroundTasks`                                                                         |
| `orchestrator`   | `planPipeline`, `considerCollaboration`                                                                |
| `model-router`   | `modelRegistry`, `kernel/router.py`                                                                    |
| `agents`         | `listAgentsFromRegistry`                                                                               |
| `capability-bus` | `capabilityRegistry`, skill/tool/module/connector/workflow routers                                     |
| `permission`     | `actionNeedsApproval`, `governance`                                                                    |
| `execution`      | kernel `kernel/tools.py` + desktop IPC                                                                 |
| `verification`   | `verifyResult` (spec) plus live Doctor/ops                                                             |
| `memory`         | `memory`, `memory-fabric.ts`, `library`, `experiences`                                                 |
| `idle`           | `autonomousCore` idle                                                                                  |
| `improvement`    | `learning`, `devPipeline` (never auto-merges `main`)                                                   |

Stop everything (`src/lib/friday/self/autonomy.ts` `stopEverything`) is one fan-out: it sets `halted`, pauses every running background graph, cancels open kernel tasks and terminal runs, and halts MCP calls; the tool gate and the task graph read `halted`. The goal runner maps kernel state, so a task waiting for approval is not done. The terminal classifier is an allowlist (`SAFE_COMMANDS`, kept identical in `src/lib/friday/terminal-command.ts` and `electron/terminal.cjs`); credential-entry detection folds NFKC and Devanagari text, and a graph outcome is announced by voice. Tests: `core/__tests__/stop-everything-fanout.test.ts`, `core/__tests__/goal-runner-approval-state.test.ts`, `core/__tests__/terminal-command-allowlist.test.ts`. UNVERIFIED: the process-tree kill of a terminal run on Windows. The agent shell classifier splits the line into arguments the way sh, PowerShell and cmd would and checks each argument against a per-command rule table (allowed flags, value flags, positionals); anything else is exec: unknown or quoted flags, URLs, UNC paths, shell metacharacters, chains other than `&&`, and network commands (ping, Test-Connection, npm view, winget, choco and scoop search). In a folder with its own repo or project files only cmd built-ins pass. Both copies (`electron/terminal.cjs`, `src/lib/friday/terminal-command.ts`) run one shared case-table test (`core/__tests__/terminal-argv-classifier.test.ts`). Main learns `halted` synchronously over the sync channel `autonomy:halt-sync` (`ipcMain.on` in `electron/main.cjs`, not an invoke channel, so it is not in the IPC budget table); a corrupt or unreadable autonomy state file reads as Stop everything (halted), and only the main window's main frame can send `autonomy:halt-sync`. Restart and shutdown asks refuse while halted, before and after the ask. The Brain is a stop participant and Approve while halted denies; the stop report says when the kernel did not answer. Tests: `core/__tests__/terminal-command-bypass.test.ts`, `core/__tests__/halt-sync-main.test.ts`, `core/__tests__/brain-halt-approve.test.ts`, `core/__tests__/stop-everything-kernel-silent.test.ts`. UNVERIFIED on Windows.

Wiring overlay (`src/lib/friday/wiring.ts` / `src/components/friday/WiringVisualizer.tsx`) reads the same `FLOW_CHART`. Permission, privacy, governance, billing, and tool-authority nodes have no owner toggle.

Flow Studio (`src/lib/friday/flow-graph.ts`) is that same chart as a version-1 graph. The Flow button opens the slice for the page you are on. Boxes can be dragged and wires reconnected. A real wire can change a setting or the router strategy. A box whose file is missing is shown as unwired. The list, the blocks, the canvas, and the code tab read this graph. A live watch paints only stages the current turn recorded, and a replay does not run them again.

`scripts/flow-registry.cjs` writes `src/lib/friday/flow-registry.gen.ts` from the routes, preferences, capability packs, IPC channels, kernel routes, and the eleven workflow files. `npm run docs:check` fails if that module drifts. Canvas modes are projections of one graph. A phone snapshot does not mutate it.

`core/brain/` graphs are Vitest contracts. The shipped EXE does not import `core/`.
