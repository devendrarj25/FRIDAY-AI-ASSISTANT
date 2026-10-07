# Performance Plan

- Registry indexes by intent tag, capability type, platform and readiness.
- Store embeddings separately from canonical metadata.
- Cache compact capability cards.
- Use progressive schema expansion.
- Batch health probes.
- Debounce noisy device events.
- Stream task events instead of polling.
- Use bounded concurrency.
- Prefer local deterministic actions before model calls.
- Route small subtasks to smaller/local models.
- Cache deterministic browser plans and document conversions.
- Use speculative multi-action only where live state validation exists.
