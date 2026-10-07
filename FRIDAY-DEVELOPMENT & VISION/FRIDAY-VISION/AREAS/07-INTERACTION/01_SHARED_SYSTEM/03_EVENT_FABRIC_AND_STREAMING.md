# Shared Event Fabric and Streaming

## Event classes
1. interaction accepted/rejected
2. cognition/plan progress
3. capability/model routing
4. approval requested/approved/rejected/expired
5. execution started/progress/completed/failed
6. artifact created/updated/finalized
7. voice audio/partial transcript/barge-in/TTS state
8. mobile connect/reconnect/cursor sync/remote command
9. task checkpoint/recovery/replan
10. notification/proactive suggestion

## Ordering
Events carry monotonic sequence scoped to the authoritative stream/task. Consumers detect gaps and request reconciliation. Events are never treated as durable truth when the authoritative task snapshot is available.

## Delivery classes
- **Ephemeral:** typing indicators, transient partial tokens, audio levels.
- **Durable:** task state, approvals, artifacts, verified outcomes, important errors.
- **Replayable:** events required to reconstruct activity or audit.

## Streaming contract
The producer may emit partial progress, but only terminal/verified events can establish completion. Multiple clients can observe the same task. One client disconnecting must not terminate the task.

## Reconnect
`authenticate → validate session scope → receive snapshot/version → resume from cursor → detect gaps → reconcile → continue stream`.

This follows the same durable-task/streaming principles used by modern task protocols: stateful tasks, separate artifacts, ordered streaming updates and explicit disconnected-client recovery. A2A's current specification makes these distinctions explicit.
