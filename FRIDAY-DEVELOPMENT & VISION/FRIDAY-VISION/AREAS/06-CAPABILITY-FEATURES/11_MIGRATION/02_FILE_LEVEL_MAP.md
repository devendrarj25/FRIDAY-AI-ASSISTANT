# File-Level Migration Map

## Add
`core/capabilities/contract.ts`
`core/capabilities/registry.ts`
`core/capabilities/broker.ts`
`core/capabilities/composer.ts`
`core/capabilities/health.ts`
`core/capabilities/evidence.ts`
`core/capabilities/telemetry.ts`
`core/features/catalog.ts`
`core/features/readiness.ts`
`core/runtime/task-state.ts`
`core/runtime/event-stream.ts`
`core/runtime/checkpoint.ts`
`electron/capability-fabric.cjs`
`electron/capability-adapters.cjs`
`electron/capability-evaluator.cjs`
`electron/feature-runtime.cjs`
`electron/task-runtime.cjs`
`kernel/capability_router.py`
`kernel/task_runtime.py`

## Extend, do not replace
`electron/capabilities.cjs` → legacy discovery adapter
`electron/capability-verify.cjs` → verification adapter
`electron/tools.cjs` → tool adapter + policy hook
`electron/skills.cjs` → skill adapter
`electron/agents.cjs` → agent adapter
`electron/mcp-client.cjs` → MCP adapter
`electron/readiness.cjs` → readiness provider
`electron/service-health.cjs` → health provider
`electron/tool-authority.cjs` → policy engine integration
`electron/sandbox.cjs` → execution isolation provider
`core/registry.ts` → boot new Fabric before brain router
`src/lib/friday/brain/orchestrator.ts` → ask Broker/Composer rather than maintaining separate candidate logic
`src/lib/friday/brain/core-brain.ts` → surface FeatureRuntime
`kernel/planner.py` → persist canonical task graph/checkpoints
