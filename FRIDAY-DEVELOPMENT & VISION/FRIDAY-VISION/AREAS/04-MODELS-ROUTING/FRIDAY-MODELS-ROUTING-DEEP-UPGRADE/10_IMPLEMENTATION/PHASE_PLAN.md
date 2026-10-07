# Implementation phases

## Phase 0 — freeze and audit

- freeze current model/provider behavior;
- run all existing model/provider tests;
- snapshot current provider/model inventories;
- identify duplicate provider tables;
- define migration feature flag.

## Phase 1 — canonical resource contracts

Implement:

- ProviderManifest
- ProviderAccount
- ProviderEndpoint
- ModelResource
- ModelDeployment
- ModelArtifact
- CapabilityEvidence
- HealthSnapshot
- PerformanceProfile
- RoutePlan

## Phase 2 — provider adapter registry

Move provider-specific behavior behind adapters. Initially wrap existing `electron/models.cjs` and `kernel/router.py` instead of rewriting them.

## Phase 3 — catalogue + evidence engine

- native discovery;
- official docs references;
- lifecycle normalization;
- capability evidence;
- atomic snapshots;
- stale detection.

## Phase 4 — local lifecycle manager

- runtime detection;
- hardware fit;
- download/resume/checksum;
- register/load/unload;
- repair/rollback.

## Phase 5 — route planner

Implement hard filters first. Then deterministic scoring. Then optional learned estimation.

## Phase 6 — Multi engine

Add parallel/critic/verifier/panel/judge/pipeline plans.

## Phase 7 — self-healing

Add retry classification, cooldown, fallback, recovery probes and migration from deprecated models.

## Phase 8 — UI

Upgrade Models page to show:

- provider cards;
- connection state;
- model catalogue;
- model details;
- capabilities with evidence;
- install/download state;
- modes;
- manual multi-select;
- auto policy controls;
- route preview;
- why-this-model explanation;
- health/performance.

## Phase 9 — learned routing

Only after telemetry and offline evaluation exist. Do not ship a learned router before deterministic routing is reliable.

## Phase 10 — remove duplicate truth

After parity tests pass, deprecate old provider/model tables one at a time. Do not delete the existing implementation at Phase 1.
