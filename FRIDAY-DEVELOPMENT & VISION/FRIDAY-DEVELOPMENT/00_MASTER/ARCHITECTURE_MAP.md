# FRIDAY Development Architecture Map

| Plane | Canonical responsibility | Typical source owners |
|---|---|---|
| Experience | chat/voice/UI state | `src/routes`, `src/components/friday` |
| Cognition | reasoning/context/planning | `src/lib/friday/brain/*` |
| Task | durable task graph/execution state | `src/lib/friday/self/*`, `kernel/planner.py` |
| Intelligence | model/provider selection | `electron/model-router.cjs`, `electron/provider-registry.cjs`, `src/lib/friday/models-engine.ts` |
| Agents | delegation/lifecycle | `electron/agents.cjs`, `src/lib/friday` agent orchestration |
| Capability | tools/skills/modules/connectors/workflows | `electron/tools.cjs`, `electron/skills.cjs`, `core/registry.ts` |
| Authority | permission/policy | `electron/tool-authority.cjs`, `kernel/authority.py` |
| Execution | side effects | `electron/tools.cjs`, `kernel/tools.py`, browser/runtime owners |
| Verification | postconditions/readiness | `electron/readiness.cjs`, verification/test owners |
| Memory | episodic/semantic/procedural knowledge | `src/lib/friday/brain/*`, `src/lib/friday/self/memory-*`, `kernel/memory.py` |
| Lifecycle | install/update/recovery | packaging/update owners |
| Observability | traces/logs/metrics | runtime logging/tracing owners |

This is a routing map, not permission to move files.
