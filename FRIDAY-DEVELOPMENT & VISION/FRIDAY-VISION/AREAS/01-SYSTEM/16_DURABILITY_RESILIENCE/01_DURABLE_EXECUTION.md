# Durable Execution

## Purpose
Long-running tasks survive app restarts, network interruptions, model failures and human approval waits.

## Canonical flow
Start task → checkpoint before side effect → execute → checkpoint result → next node.

## Required contracts
Checkpoint includes plan state, completed nodes, pending nodes, idempotency keys, compensation state and event cursor.

## Failure and recovery
A task resumes from the last verified checkpoint, never by blindly replaying an unsafe action.

## Implementation guidance
Extend task graph/ledger/background tasks and persistence.
