# Coding-agent master implementation prompt — FRIDAY Self-System Upgrade

You are upgrading the existing FRIDAY repository. The repository already has a self subsystem. Do not build a parallel framework.

## Mission
Implement the Self Operating System described in this package so FRIDAY can safely:
- operate autonomously within policy
- learn from verified experience
- grow capabilities through automatic curriculum
- develop skills/tools/workflows/agents/modules
- run controlled self-improvement experiments
- evolve candidate versions in an isolated lab
- evaluate changes with independent evidence
- promote winners through governance
- rollback regressions

## First action — inspect current source
Read:
- `src/lib/friday/self/*`
- `src/lib/friday/brain/*forge.ts`
- `src/lib/friday/brain/workflow-introspection.ts`
- `src/lib/friday/brain/multi-model.ts`
- `electron/self-maintenance.cjs`
- `core/__tests__/*self*`, `*learning*`, `*memory*`, `*maintenance*`, `*agent*`

Then compare against:
- `01_CURRENT_STATE/*`
- `02_ARCHITECTURE/*`
- `14_SCHEMAS/*`

## Implementation rules
1. Extend existing stores instead of creating duplicate stores.
2. Preserve current public APIs and tests where practical.
3. Introduce typed adapters/interfaces before moving logic.
4. All candidate changes must have lineage and version.
5. All generated code must run in a sandbox before production consideration.
6. The evaluator must not be modifiable by the candidate in the same promotion transaction.
7. Never allow self-learning to store credentials or secrets as ordinary memory/training data.
8. Never let an LLM directly self-approve a protected change.
9. Keep rollback available until the canary period ends.
10. Add failure-injection tests.

## New conceptual modules
Implement under `src/lib/friday/self/` unless a better existing location exists:
- `self-os.ts`
- `experience-fabric.ts`
- `capability-graph.ts`
- `curriculum-engine.ts`
- `evaluator-registry.ts`
- `experiment-runner.ts`
- `candidate-registry.ts`
- `evolution-lab.ts`
- `promotion-gate.ts`
- `resource-budget.ts`
- `change-lineage.ts`

Do not create all of these as empty shells. Each must have tests and be wired to a real caller.

## Required flow
`AutonomousCore → SelfOSCoordinator → Observe/Diagnose → Growth/Learning Decision → Candidate/Experiment → Sandbox → Evaluate → PromotionGate → Canary → Monitor → Rollback/Promote → ExperienceFabric`

## Learning requirements
- verified outcomes only for positive procedural promotion
- explicit user corrections are high-priority evidence
- failures remain useful but are not positive truth
- provenance and freshness are mandatory
- policy priors use smoothed statistics, not raw counts

## Growth requirements
Build hierarchical capability nodes from the current capability matrix. Generate curriculum tasks from observed weaknesses. Start with deterministic/sandbox tasks and increase difficulty only after measured improvement.

## Development requirements
Unify existing forge outputs into candidate artifacts. A generated skill/tool/agent/workflow is not production until it passes its artifact-specific tests.

## Evolution requirements
Start with prompt/workflow evolution. Add adapter training only after the experiment/evaluation infrastructure works. Population search must have hard budgets. Keep an archive of parents/winners/near-winners.

## Evaluation requirements
Implement baseline-vs-candidate evaluation, held-out suites, regression thresholds, shadow and canary states. Add independent evaluators for high-impact candidates.

## Safety requirements
Protected files and governance/security code remain always-review. Candidate code cannot disable sandboxing, budgets, rollback or evaluator integrity.

## Completion criteria
The implementation is complete only when:
- all current self tests pass
- new SelfOS tests pass
- a synthetic learning loop works end-to-end
- a synthetic growth/curriculum loop works end-to-end
- a candidate prompt/workflow can be generated, evaluated and rejected/promoted
- rollback works after a simulated regression
- autonomy budgets stop a runaway loop
- evaluator tampering is detected
- restart recovery restores pending experiments
- audit lineage can explain why every promoted change exists
