# Final V2 Audit Ledger

## Preservation
- All 144 files from the supplied V1 package were copied into the V2 working tree before changes.
- Existing Chat/Voice merged source-detail documents were preserved.
- Existing Mobile UI/output/Manual/Auto/Cross-surface/Security/Acceptance material was preserved.
- Existing diagrams and source-reference contracts were preserved.

## Consolidation
- `00_MASTER/` now owns cross-surface invariants and the surface×mode contract.
- `10_CONTRACTS/` is explicitly canonical for implementation.
- `15_INTEGRATED_SOURCE_CONTRACTS/` is explicitly historical/source-reference material, preventing duplicate runtime authority.
- Mobile deep-upgrade documents remain detailed and are linked conceptually to the master architecture rather than replacing it.

## Corrected defects found during audit
- Package manifest counts were stale relative to the actual archive; V2 recomputes counts from the final tree.
- Research documents contained tool-session citation tokens that are not portable inside an offline ZIP; V2 replaces research references with stable source URLs in the dedicated research source document and removes invalid inline tool tokens from those research docs.
- The distinction between browser permission, FRIDAY session authority, capability authorization and action-risk governance is now explicit across the master, mobile and security documents.
- Runtime freshness now explicitly distinguishes metadata/capability synchronization from client renderer/protocol compatibility; refresh cannot magically invent a renderer the client does not contain.

## Non-goals
No FRIDAY source code, desktop visual design, build/installer/release pipeline, or existing working feature is changed by this architecture package.
