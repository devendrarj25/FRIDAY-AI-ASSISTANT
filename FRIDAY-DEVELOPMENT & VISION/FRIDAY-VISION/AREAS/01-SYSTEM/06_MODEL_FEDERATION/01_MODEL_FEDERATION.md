# Model Federation

## Purpose
Treat models as replaceable reasoning engines selected per subtask. Local and cloud models can coexist with privacy, quality, cost and latency policies.

## Canonical flow
Subtask profile → candidate models → capability compatibility → policy/data boundary → health → quality history → cost/latency → selection.

## Required contracts
Model profile contains modality support, context limit, tool calling, structured output, privacy class, local/remote location, cost, latency, reliability and known failure modes.

## Failure and recovery
Model failure triggers bounded fallback. Sensitive data cannot silently move to a cloud provider merely because the local model fails.

## Implementation guidance
Reconcile existing model registry/catalogs into one authoritative registry with adapters.
