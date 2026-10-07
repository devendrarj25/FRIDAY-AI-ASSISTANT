# Durable Execution

Persist:
- task graph
- node state
- input hashes
- output artifact references
- checkpoint
- retry count
- lease
- approval state
- policy snapshot
- selected capability version
- evidence

A renderer restart must not kill a task.

Use idempotency keys for side effects.
