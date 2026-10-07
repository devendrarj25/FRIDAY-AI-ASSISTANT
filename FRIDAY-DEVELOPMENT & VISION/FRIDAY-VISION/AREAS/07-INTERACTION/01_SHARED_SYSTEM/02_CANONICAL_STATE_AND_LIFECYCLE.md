# Canonical State and Lifecycle

## Interaction lifecycle
`created → accepted → normalized → contextualized → understood → planned → governed → executing → observing → verifying → responding → completed`.

A task can branch into `waiting_input`, `waiting_approval`, `paused`, `recovering`, `unknown`, `failed` or `canceled` without losing identity.

## Generation semantics
`generation_id` identifies one answer/stream attempt. A newer generation supersedes older presentation output. Late chunks from an older generation are discarded at the boundary before presentation or task-state mutation.

## Task semantics
A `task_id` survives surface disconnects and renderer reloads. Task version increments on authoritative mutation. A client accepts an event only if its cursor/version is newer or a reconciliation snapshot proves the new state.

## Approval semantics
An approval binds to the exact action envelope or a cryptographically stable action hash, the applicable policy version, scope and expiry. Reusing an approval for changed arguments is forbidden.

## Truth semantics
`verified` means postconditions/evidence were checked. `reported` means an external system reported success but FRIDAY has not independently verified it. `inferred` is model/runtime inference. `unknown` means outcome cannot yet be safely determined. `failed` means a verified failure.

## Durable checkpoint rule
Before a non-idempotent side effect, checkpoint the intended action, idempotency key, policy decision and recovery plan. After the side effect, checkpoint the observed outcome before advancing the task. Unknown outcomes reconcile first; they are never blindly retried.
