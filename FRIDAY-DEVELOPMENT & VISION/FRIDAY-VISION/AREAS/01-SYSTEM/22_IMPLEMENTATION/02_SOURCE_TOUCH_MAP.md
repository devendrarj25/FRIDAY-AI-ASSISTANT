# Source Touch Map

### Brain and routing
- `src/lib/friday/brain-engine.ts`
- `src/lib/friday/brain/core-brain.ts`
- `src/lib/friday/brain/context-engine.ts`
- `src/lib/friday/brain/orchestrator.ts`
- `src/lib/friday/brain/capability-registry.ts`
- `src/lib/friday/brain/*-router.ts`
- `src/lib/friday/brain/turn-trace.ts`
- `src/lib/friday/brain/decision-trace.ts`

### Tasks/self runtime
- `src/lib/friday/self/task-graph.ts`
- `src/lib/friday/self/task-ledger.ts`
- `src/lib/friday/self/task-runners.ts`
- `src/lib/friday/self/background-tasks.ts`
- `src/lib/friday/self/agent-scheduler.ts`
- `src/lib/friday/self/dev-pipeline.ts`
- `src/lib/friday/self/governance.ts`

### Execution/governance
- `electron/tool-authority.cjs`
- `electron/sandbox.cjs`
- `electron/self-maintenance.cjs`
- `kernel/tools.py`
- existing permissions/privacy/network modules

### Models
- `src/lib/friday/model-registry.ts`
- `src/lib/friday/model-catalog.ts`
- `src/lib/friday/models-engine.ts`
- `src/lib/friday/brain/model-registry.ts`
- `kernel/router.py`

### Voice/companion/browser
- `src/lib/friday/voice-*.ts`, `wake-*.ts`
- `src/lib/friday/companion-live.ts`
- `src/lib/friday/bridge.ts`
- `src/lib/friday/browser-engine.ts`
- `src/lib/friday/live-browser.ts`
- `kernel/companion.py`
- `electron/remote-access.cjs`

### UI/event projection
- existing HUD/stage/wiring/flow/notification/live-metrics surfaces
- `src/lib/friday/flow-chart.ts`
- `src/lib/friday/wiring.ts`
- `src/lib/friday/hud.ts`

### Protected unless required
- `electron-builder.yml`
- `.github/workflows/*`
- installer/release scripts
- package scripts/dependency graph

The live inventory is the repository. The 2026-09 machine inventory was removed after `docs/FRIDAY_ARCHITECTURE_BASELINE.md` became the owner.
