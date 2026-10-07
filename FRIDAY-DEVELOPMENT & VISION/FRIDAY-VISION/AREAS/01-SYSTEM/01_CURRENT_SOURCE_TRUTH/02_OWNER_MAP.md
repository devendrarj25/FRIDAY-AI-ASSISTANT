# Canonical Owner Map

| Concern | Existing owner to extend | Rule |
|---|---|---|
| Main intelligence orchestration | `src/lib/friday/brain-engine.ts` | Do not create a second brain loop. |
| Cognitive brain | `src/lib/friday/brain/core-brain.ts` and `src/lib/friday/brain/*` | Add missing contracts around the existing brain. |
| Capability discovery/health | `src/lib/friday/brain/capability-registry.ts` + capability files | One live capability registry. |
| Model federation | `src/lib/friday/model-registry.ts`, `src/lib/friday/brain/model-registry.ts`, `models/`, kernel routing | Reconcile current split deliberately; no third registry. |
| Tool routing | `src/lib/friday/brain/tool-router.ts` | Route through capability/governance fabric. |
| Skill/agent/workflow/connector routing | existing specialized routers | Keep specialized policy but share canonical capability metadata. |
| Tasks | `src/lib/friday/self/task-graph.ts`, `task-ledger.ts`, runners/background tasks | One durable task identity and lifecycle. |
| Self-development | `src/lib/friday/self/dev-pipeline.ts`, `electron/self-maintenance.cjs`, builder | Candidate changes must flow through staged governance. |
| Governance | `src/lib/friday/self/governance.ts`, permissions, `electron/tool-authority.cjs`, sandbox | No bypass path. |
| Memory/knowledge | brain memory/retrieval + self memory + `memory/` | Define clear hot/working/episodic/semantic/archive boundaries. |
| Voice | `voice-stt.ts`, `voice-audio.ts`, `wake-engine.ts`, `voice-state.ts`, character bridge | Voice is a modality, not a second brain. |
| Companion | `companion-live.ts`, bridge, kernel companion, remote access | Same brain/session/task IDs across endpoints. |
| Browser/computer | browser engine/live browser + Electron authority + kernel tools | Computer use is brokered capability execution. |
| UI activity | stage/HUD/wiring/live metrics | UI consumes execution events; it is never the task source of truth. |
| Build/release | package scripts, builder, installer, GitHub workflows | Protected; touch only when required. |
