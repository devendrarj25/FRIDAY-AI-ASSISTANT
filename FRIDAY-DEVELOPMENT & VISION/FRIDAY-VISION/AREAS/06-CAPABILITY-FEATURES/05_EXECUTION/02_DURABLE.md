# Durable Execution
Persist task state, plan graph, node state, inputs/outputs, artifacts, approvals,
retry counters, leases, policy snapshot and recovery state.
On restart: restore, validate lease, revalidate policy, verify external state,
resume only safe/idempotent nodes and reconcile ambiguous side effects.
