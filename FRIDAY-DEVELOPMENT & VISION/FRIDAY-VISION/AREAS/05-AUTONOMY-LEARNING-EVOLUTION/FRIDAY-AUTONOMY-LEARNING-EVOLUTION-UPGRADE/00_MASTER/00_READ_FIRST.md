# Read First

## What the coding AI must understand
FRIDAY already contains a surprisingly complete self subsystem. Do not create a second autonomy loop, second memory database, second governance queue, or second task ledger.

### Existing foundation to extend
- `src/lib/friday/self/autonomy.ts` — autonomy policy
- `src/lib/friday/self/autonomous-core.ts` — background observe/plan/recover loop
- `src/lib/friday/self/self-manager.ts` — lifecycle/monitoring/repair/upgrade/growth orchestration
- `src/lib/friday/self/learning-engine.ts` — outcome → experience/memory learning
- `src/lib/friday/self/task-ledger.ts` — durable task/experience evidence
- `src/lib/friday/self/memory-engine.ts` + `memory-consolidate.ts` — memory fabric
- `src/lib/friday/self/capability-matrix.ts` — measured capability score
- `src/lib/friday/self/mastery.ts` — derived mastery/activity
- `src/lib/friday/self/limitation-loop.ts` — limitations → governance proposals
- `src/lib/friday/self/finetune.ts` — local LoRA/QLoRA proposal path
- `src/lib/friday/self/governance.ts` — approval/dry-run/apply/verify/rollback gate
- `src/lib/friday/self/dev-pipeline.ts` — development/self-maintenance path
- `src/lib/friday/brain/*forge.ts` — skill/tool/module/agent/workflow generation surfaces
- `src/lib/friday/brain/workflow-introspection.ts` — workflow introspection
- `electron/self-maintenance.cjs` — privileged self-maintenance bridge

## Main problem to solve
The current system has many correct primitives, but they are mostly **feature loops**. The upgrade should unify them under one explicit Self-Improvement OS model with:
1. common experience schema
2. explicit hypothesis/candidate/experiment records
3. automatic curriculum
4. evaluator registry
5. shadow/canary promotion
6. evolution archive
7. improvement budgets
8. provenance and confidence
9. cross-domain capability learning
10. model/provider-aware experiment routing

## Do not do
- do not delete working existing self files
- do not create parallel memory stores
- do not let an LLM directly edit production and immediately reload itself
- do not train on unverified failures as if they were correct answers
- do not let self-learning alter protected governance/security policy automatically
- do not use external data as truth without provenance/freshness
