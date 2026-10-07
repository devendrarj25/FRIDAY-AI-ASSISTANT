# Non-negotiable implementation laws

1. Preserve current working behavior unless the new contract intentionally supersedes it.
2. One canonical provider registry; no duplicate provider truth in UI, Python and Electron.
3. Provider manifests describe discovery, auth, transport, metadata, health, install and lifecycle.
4. Every model record carries evidence/provenance and freshness timestamps.
5. Never fabricate model IDs, endpoints, context lengths, prices or capabilities.
6. Never silently convert a native provider protocol to an OpenAI-compatible call unless the provider officially documents that compatibility layer.
7. A successful `/models` call does not prove inference entitlement.
8. A configured API key does not prove authentication.
9. A reachable provider does not prove a specific model is callable.
10. A model's existence does not prove a capability.
11. Local-only means **no user prompt payload may leave the device**.
12. Cloud-only means local model execution is excluded unless explicitly allowed by a separate system operation.
13. Multi mode must declare whether results are parallel, staged, debate, critic, verifier or judge aggregation.
14. Fallback is allowed only within the same privacy, modality, tool, context and output constraints.
15. Retries must classify the error first; never blindly retry 4xx or deterministic validation errors.
16. Every automatic decision must be explainable in an internal decision trace.
17. Provider adapters must be independently testable without the UI.
18. Provider credentials are secrets; logs store references, never secret material.
19. Catalogue refresh must be atomic: old valid snapshot remains usable while new data is being validated.
20. Model download/install must be resumable, checksummed and recoverable.
21. A future provider should be addable by a manifest + adapter package without rewriting the router.
22. Tests must include provider failure injection and mode/privacy boundary tests.
