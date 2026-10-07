# FINAL PACKAGE RULES

This is the single authoritative package for FRIDAY's Capability + Feature area.

## Scope
Only Capability OS + Feature OS and the runtime surfaces required to make them real:
registry, broker, composition, execution, computer use, multimodal artifacts, interop,
devices, memory/evidence interfaces, trust, observability, evaluation and UI.

## Do not merge conflicting earlier packages
If older FRIDAY upgrade packages contain capability/feature documents, this package wins
for this area. Existing FRIDAY source remains the implementation source of truth until
migration is complete.

## Non-goals
Do not redesign model/provider routing, autonomy/self-learning, or the whole FRIDAY OS here.
Integrate with those existing/previous systems through stable contracts.

## Implementation law
1. Inspect actual repository before changing code.
2. Preserve backward compatibility during migration.
3. Create adapters before deleting legacy registries.
4. Run shadow-mode broker before routing cutover.
5. Every side effect is policy-gated.
6. Every long-running task is durable.
7. Every external capability has provenance and verification.
8. No hidden second registry.
9. No hard-coded provider/model/device assumptions.
10. Every new extension uses a versioned contract + conformance tests.
