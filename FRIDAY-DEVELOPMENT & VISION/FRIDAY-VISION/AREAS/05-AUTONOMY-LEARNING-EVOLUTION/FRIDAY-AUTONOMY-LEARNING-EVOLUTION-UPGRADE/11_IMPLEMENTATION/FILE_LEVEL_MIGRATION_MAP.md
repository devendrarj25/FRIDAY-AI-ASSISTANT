# File-Level Migration Map

## Extend, do not duplicate

### `src/lib/friday/self/autonomy.ts`
Add scoped policies and resource budgets. Preserve existing public API where possible.

### `src/lib/friday/self/autonomous-core.ts`
Keep the idle loop. Replace ad-hoc improvement decisions with a `SelfOSCoordinator` that dispatches observe/diagnose/learn/grow/evolve passes.

### `src/lib/friday/self/learning-engine.ts`
Emit normalized experience events and lesson candidates. Keep current memory promotion behavior as a compatibility path.

### `src/lib/friday/self/task-ledger.ts`
Add trajectory IDs, verifier evidence and strategy/model/provider dimensions.

### `src/lib/friday/self/capability-matrix.ts`
Back the new CapabilityGraph with existing scores so current UI/tests do not break.

### `src/lib/friday/self/finetune.ts`
Wrap current local training in ExperimentRunner + CandidateRegistry + holdout gate.

### `src/lib/friday/self/governance.ts`
Promote from generic risk gate to typed PromotionGate. Preserve protected-policy detection.

### `src/lib/friday/self/self-manager.ts`
Remain facade/UI store; move heavy logic into new engines.

### `src/lib/friday/self/limitation-loop.ts`
Emit ImprovementOpportunity records into GrowthEngine.

### `src/lib/friday/brain/*forge.ts`
Return versioned candidate artifacts instead of directly mutating production registries.

### `src/lib/friday/brain/workflow-introspection.ts`
Produce workflow mutation candidates + replay suites.

### `electron/self-maintenance.cjs`
Remain the privileged executor. Only PromotionGate-approved changes reach it.

### `core/__tests__`
Add self-improvement integration tests while preserving existing suites.
