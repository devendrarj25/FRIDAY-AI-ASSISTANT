# Implementation Phases

## Phase 0 — Baseline lock
Capture source hash, current build commands, current docs, existing registries and protected files. No feature changes.

## Phase 1 — Contracts and IDs
Introduce shared typed envelopes and compatibility adapters. Wire existing turn/task/action/event data into the contracts without changing behavior.

## Phase 2 — Event fabric and trace propagation
Make actual runtime events authoritative for activity/wiring views. Add correlation IDs through renderer → Electron → kernel → model/tool/task paths.

## Phase 3 — Governance hardening
Verify policy root at boot and privileged-action boundaries. Normalize risk/approval decisions around the existing authority gate.

## Phase 4 — Durable execution
Attach checkpoints/idempotency/recovery to existing task graph/ledger/background runtime.

## Phase 5 — Universal routing
Unify model/capability health and routing decisions without deleting specialized routers.

## Phase 6 — Capability fabric
Normalize tool/skill/agent/workflow/module/connector metadata and lifecycle into the existing capability registry.

## Phase 7 — Multimodal artifact fabric
Add generators/analyzers/validators as capabilities. Preserve existing attachment/library/workspace ownership.

## Phase 8 — One-brain continuity
Complete Chat/Voice/Mobile shared turn/task/memory contracts.

## Phase 9 — Computer/external execution
Harden browser/device/code/external connector execution under the authority broker.

## Phase 10 — Self-learning
Add outcome-driven learning and learned routing with strict policy separation.

## Phase 11 — Self-development/evolution
Add sandboxed candidate pipeline, evaluation, canary and rollback around existing dev/build owners.

## Phase 12 — Optimization
Resource budgets, latency intelligence, evaluation dashboards and failure-injection acceptance.

Never skip directly to self-modifying production code before phases 1–5 are stable.
