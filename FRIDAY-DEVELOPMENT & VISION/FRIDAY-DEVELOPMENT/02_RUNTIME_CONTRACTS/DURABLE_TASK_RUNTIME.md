# Durable Task Runtime Contract

Canonical lifecycle:

`created → planned → waiting_approval → ready → running → waiting_external → verifying → succeeded`

Failure/recovery:
`failed → recovering → recovered`
or `failed → quarantined`

Required identity:
`request_id, session_id, task_id, run_id, action_id`

Required semantics:
- checkpoints at meaningful transitions;
- idempotency for side effects;
- bounded retries;
- lease/heartbeat for workers;
- cancellation propagation;
- approval pauses are resumable;
- external waits are resumable;
- recovery never fabricates success.

The existing task graph/self systems remain the first implementation candidates.
