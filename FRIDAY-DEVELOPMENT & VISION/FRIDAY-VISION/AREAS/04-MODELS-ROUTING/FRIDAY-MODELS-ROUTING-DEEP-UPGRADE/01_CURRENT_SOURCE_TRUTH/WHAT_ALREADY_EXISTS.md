# Current source truth — what FRIDAY already has

The supplied `FRIDAY-main.zip` is **not a blank model system**. It already has a serious foundation. The upgrade must extend it rather than replace it with another parallel model system.

## Existing strengths

1. `electron/models.cjs` already knows how to perform real catalogue discovery and local inventory.
2. `electron/provider-registry.cjs` already defines the canonical provider state and the modes `local-only`, `cloud-only`, `hybrid`, `auto`, `multi`.
3. `electron/model-capabilities.cjs` already uses an evidence hierarchy: provider/runtime declaration → curated registry → heuristic.
4. `electron/model-access.cjs` separates configured/authenticated/catalogue/live-chat/stream validation.
5. `electron/model-router.cjs` already has access checks, capability checks, error classification and fallback concepts.
6. `kernel/router.py` already has an explicit wire taxonomy rather than blindly treating every provider as OpenAI-compatible.
7. Existing tests cover model routing, provider parity, live health, endpoint contracts, backend diversity, paid-only policy and multi-model collaboration.

## Why the next upgrade is still necessary

The current code is **provider-aware**, but the target needs to be a **provider federation operating system**. The difference is important:

- Current: provider IDs are embedded in several runtime tables.
- Target: provider behavior comes from versioned provider manifests and adapters.
- Current: catalogue metadata is mostly normalized at discovery time.
- Target: every field carries provenance, freshness, confidence and verification status.
- Current: routing is primarily rule/policy based.
- Target: routing is a policy-constrained decision engine with learned local performance profiles, value-of-information checks, diversity awareness, task decomposition and ensemble plans.
- Current: local install is runtime-specific but fragmented.
- Target: a lifecycle manager treats runtime, model artifact, quantization, hardware fit, tokenizer, adapter, checksum and load state as separate resources.
- Current: fallback exists.
- Target: fallback is classified, budgeted, idempotent, diversity-aware and observable.
