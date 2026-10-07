# Current-to-Target Integration Map

| Existing FRIDAY area | Keep | Upgrade connection |
|---|---|---|
| `self/autonomy.ts` | Yes | add scoped autonomy, budgets, quiet hours, improvement classes |
| `self/autonomous-core.ts` | Yes | become scheduler-facing SelfOS loop |
| `self/learning-engine.ts` | Yes | emit normalized ExperienceEvent |
| `self/task-ledger.ts` | Yes | become evidence/trajectory store |
| `self/memory-engine.ts` | Yes | connect semantic/procedural memory promotion |
| `self/memory-consolidate.ts` | Yes | add provenance/decay/contradiction scoring |
| `self/capability-matrix.ts` | Yes | become CapabilityGraph backend |
| `self/mastery.ts` | Yes | derive mastery from capability graph + verified evals |
| `self/limitation-loop.ts` | Yes | emit ImprovementOpportunity |
| `self/finetune.ts` | Yes | connect to Evolution Lab candidate evaluation |
| `self/governance.ts` | Yes | become Promotion Gate |
| `self/dev-pipeline.ts` | Yes | become Change Compiler/Release pipeline |
| `self/self-manager.ts` | Yes | become orchestration facade, not a second engine |
| `brain/skill-forge.ts` | Yes | candidate generation + sandbox eval |
| `brain/tool-forge.ts` | Yes | tool contract tests + permission manifest |
| `brain/module-forge.ts` | Yes | module candidate graph + eval |
| `brain/agent-forge.ts` | Yes | agent candidate population |
| `brain/workflow-introspection.ts` | Yes | workflow trace → mutation proposals |
| `brain/multi-model.ts` | Yes | evaluator / critic / proposer roles |
| `core/ai/model-router/*` | Yes | route experiments to best model(s) |
| `electron/self-maintenance.cjs` | Yes | privileged apply/rollback only |
| `kernel/planner.py` | Yes | optional planner backend; do not create duplicate planner |
| `kernel/memory.py` | Yes | bridge to durable evidence stores |
