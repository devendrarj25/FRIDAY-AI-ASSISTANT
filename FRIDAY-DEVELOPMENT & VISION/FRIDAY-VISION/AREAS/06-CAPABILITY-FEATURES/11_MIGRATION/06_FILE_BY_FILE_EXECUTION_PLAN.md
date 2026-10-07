# FILE-BY-FILE EXECUTION PLAN

1. Extend `core/registry.ts` to register Capability Fabric.
2. Adapt `electron/capabilities.cjs` into the canonical discovery source.
3. Adapt `electron/capability-verify.cjs` into readiness/evidence probes.
4. Adapt `electron/tools.cjs`, `skills.cjs`, `agents.cjs` through adapters.
5. Wrap `electron/mcp-client.cjs` with policy-aware Interop Gateway.
6. Bridge `src/lib/friday/brain/orchestrator.ts` to Broker/Composer.
7. Bridge `src/lib/friday/brain/core-brain.ts` to feature resolution.
8. Bridge `browser-engine.ts` into Browser Capability Provider.
9. Bridge `task-graph.ts` + `kernel/planner.py` into Durable Execution.
10. Bridge `kernel/memory.py` into Artifact/Evidence-aware Memory interfaces.
11. Add renderer routes for Capability Center / Feature Center / Live Task Center.
12. Run shadow routing and compare outcomes.
13. Promote only after release gates.
14. Remove duplicate routing only after soak period.
