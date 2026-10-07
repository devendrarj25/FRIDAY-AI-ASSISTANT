# IDEMPOTENCY + SIDE EFFECT SAFETY

Every side-effecting node declares:
idempotency_key strategy, external transaction identity, compensation strategy,
retry safety, duplicate detection and reconciliation procedure.

Before retry:
1. inspect checkpoint
2. inspect external state if possible
3. determine whether the effect already happened
4. continue/reconcile/compensate
5. never blindly repeat irreversible operations

Exactly-once semantics are not assumed across external systems.
