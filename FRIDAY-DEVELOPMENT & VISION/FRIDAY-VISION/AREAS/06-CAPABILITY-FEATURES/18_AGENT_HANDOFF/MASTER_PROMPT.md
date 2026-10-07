# Master Implementation Prompt

Inspect the actual FRIDAY repository first. Do not rebuild it.

Implement:
CapabilityRegistry, Normalizer, Broker, Composer, FeatureCatalog, FeatureResolver,
ReadinessEngine, Health, EvidenceEngine, ExecutionFabric, DurableTaskStore, Scheduler,
DeviceRegistry, InteropGateway, PolicyEngine, AuthorityManager, ArtifactRegistry,
TraceStore and EvaluationHarness.

Rules:
- existing registries become adapters
- no model-to-shell/credential bypass
- progressive tool disclosure
- durable checkpoints
- tiered computer use
- MCP/A2A governed by the same policy
- provenance-aware memory
- bounded autonomy
- full traces/evidence
- feature flags and rollback
- tests before routing cutover

Definition of done:
one canonical capability registry, one broker, one feature graph, durable tasks,
verified computer use, governed interop, provenance-aware memory, bounded background work,
observable traces, UI control plane, automated regression and no critical policy bypass.
