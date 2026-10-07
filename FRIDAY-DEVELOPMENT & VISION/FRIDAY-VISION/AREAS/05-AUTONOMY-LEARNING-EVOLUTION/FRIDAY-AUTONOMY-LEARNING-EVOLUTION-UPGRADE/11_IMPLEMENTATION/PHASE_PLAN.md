# Implementation Phases

## Phase 0 — Inventory and contracts
- freeze current self subsystem behavior with tests
- define event/candidate/evaluation schemas
- no behavior change

## Phase 1 — SelfOS kernel
- event bus adapter
- ExperienceEvent normalization
- Candidate Registry
- Evaluator Registry
- Experiment Runner interface
- Promotion Gate interface

## Phase 2 — Learning upgrade
- provenance-aware memory promotion
- failure signatures
- policy priors
- replay-safe experience records

## Phase 3 — Growth engine
- hierarchical CapabilityGraph
- automatic curriculum
- weakness/recurrence scoring
- growth queue

## Phase 4 — Development forge
- unify skill/tool/module/agent/workflow candidate contracts
- sandboxed candidate workspaces
- deterministic test harness

## Phase 5 — Evolution lab
- candidate population/archive
- prompt/workflow evolution
- Pareto selection
- MCTS/BO adapters

## Phase 6 — Local training
- dataset lineage
- holdout/benchmark gate
- adapter registry
- canary/rollback

## Phase 7 — Autonomy upgrade
- scoped autonomy budgets
- scheduled lab windows
- compute/network/file quotas
- pause/resume/recovery

## Phase 8 — UI
- Self dashboard: Current capability, learning, growth queue, experiments, evolution archive, safety state

## Phase 9 — Hardening
- failure injection
- evaluator-gaming tests
- prompt injection tests
- crash/restart recovery
- rollback drills
