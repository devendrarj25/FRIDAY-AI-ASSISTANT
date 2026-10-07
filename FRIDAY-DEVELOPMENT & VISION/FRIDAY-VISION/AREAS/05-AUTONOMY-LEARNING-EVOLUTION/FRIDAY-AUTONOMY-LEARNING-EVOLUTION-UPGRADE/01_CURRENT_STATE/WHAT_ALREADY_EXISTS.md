# Current FRIDAY Self-System — Source Truth

## Existing autonomy
`src/lib/friday/self/autonomy.ts` already persists:
- autonomyEnabled
- approvalLevel = strict | balanced | trusted
- researchEnabled + allowed researchSources
- researchDepth
- modelPreference
- parallelSpecialists + maxParallelModels
- learningEnabled
- learnVerifiedOnly
- memoryRetentionDays
- sandboxRequired
- securityScopeLocalOnly
- updatePolicy
- backupsEnabled / autoRollback
- maxConcurrentTasks / idleCycleMinutes

This is a strong policy base. The upgrade should add **capability-scoped autonomy budgets**, not replace the global policy.

## Existing autonomous core
`autonomous-core.ts` already expresses:
`observe → understand → plan → authorize → act → monitor → verify → recover → learn`.

The upgrade should turn that conceptual loop into a typed event/state machine and connect it to the new Experiment/Evolution layer.

## Existing learning
`learning-engine.ts` already:
- records experiences
- stores episodic history
- promotes verified success
- treats explicit user corrections as high-value evidence
- records model/tool/strategy evidence

Upgrade: add provenance, task fingerprints, counterfactuals, verifier results, replayability, privacy classification and promotion lineage.

## Existing local fine-tuning
`finetune.ts` already creates a local LoRA/QLoRA path from verified experiences and keeps adapter versions. It is already governance-gated.

Upgrade: add dataset lineage, holdout split, baseline-vs-candidate evaluation, adapter registry, drift checks, automatic rollback and minimum improvement thresholds.

## Existing capability learning
`capability-matrix.ts` already computes measured capability from real task outcomes. This is valuable and should become the source of truth for curriculum selection and routing priors.

Upgrade: move from coarse domains to a hierarchical capability graph and confidence intervals.

## Existing self-development
`module-forge.ts`, `skill-forge.ts`, `tool-forge.ts`, `agent-forge.ts` and `workflow-introspection.ts` already provide building blocks.

Upgrade: all generated artifacts should become **versioned candidates** evaluated in a sandbox before promotion.

## Existing governance
`governance.ts` already provides dry-run, approval, apply, verify and rollback, and protects critical policy files from auto-approval.

Upgrade: add a typed change-class matrix and promotion gates for prompts, memory rules, workflows, skills, tools, agents, code, adapters and provider/model policies.

## Existing tests
The repository already contains tests for:
- autonomous-core
- experience-learning-loop
- learned procedures
- memory fabric
- self diagnosis
- self maintenance
- self management
- agent forge/router/scheduler

The new work should add tests around the *closed-loop improvement system*, not duplicate these suites.
