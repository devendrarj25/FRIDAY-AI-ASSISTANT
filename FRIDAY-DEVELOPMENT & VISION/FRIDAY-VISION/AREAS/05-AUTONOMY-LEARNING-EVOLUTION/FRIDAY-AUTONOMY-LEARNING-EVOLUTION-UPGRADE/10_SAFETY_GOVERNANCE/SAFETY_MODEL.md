# Safety Model for Autonomous Improvement

The more FRIDAY can change, the stronger the isolation must become.

## Non-negotiable invariants
1. governance cannot be weakened by the same change it governs
2. rollback remains available
3. credentials are never learned as ordinary memory
4. network scope is explicit
5. code execution for generated candidates is sandboxed
6. production artifacts are immutable during candidate evaluation
7. evaluator and candidate are separated
8. user can inspect what changed and why
9. sensitive data has explicit training/replay policy
10. autonomy has a hard stop

## Capability escalation
More autonomy requires more evidence, not fewer controls.

## Recursive self-improvement boundary
FRIDAY may recursively improve **within the lab**, but each generation is a new versioned artifact evaluated against an independent baseline. No self-modification chain gets unrestricted production privileges.
