# Mobile Realtime Transport, Streaming and Reconnect

## Transport model

The architecture separates:
- control/API plane
- event/stream plane
- realtime media plane
- artifact/data plane
- optional remote screen/control plane

Do not force voice media, task events, file transfer, and RPC control into one undifferentiated channel.

## Control plane

Authenticated HTTPS is the baseline for session bootstrap, pairing, capability discovery, approvals, task commands, artifact metadata, and reconciliation.

## Event plane

Use the existing shared event fabric with:
- monotonically ordered event sequence/cursor
- event ID
- task/conversation/generation IDs
- server timestamp
- schema version
- durable vs ephemeral classification
- replay/reconciliation rules

The mobile client observes the stream; the server/runtime owns truth.

## Realtime media

For browser voice, use standards-based realtime media where supported, preferably WebRTC for low-latency bidirectional media. WebRTC data channels are encrypted with DTLS; media transport and application authorization remain separate concerns.

Voice media must not wait for slow tool execution or deep reasoning.

## Long-running tasks

Use persistent streaming while connected. For disconnected/background cases, notification/push mechanisms can signal meaningful task changes, after which mobile retrieves authoritative state and artifacts.

Push is an attention mechanism, not canonical task storage.

## Reconnect state machine

`connected → degraded → disconnected → reconnecting → authenticated → snapshot_sync → cursor_reconcile → task_reconcile → stream_resume → connected`

During reconciliation:
- show stale/refreshing state
- disable unsafe duplicate mutations
- keep read-only cached information visibly stale
- reconcile active tasks
- reconcile approvals
- reconcile artifact availability
- restore stream from cursor when possible

## Mutation safety

Every mutating command carries:
- command_id
- idempotency_key
- session_id
- actor/device identity
- task_id when applicable
- policy_version
- capability_version
- client observed cursor/version

Retry only when the command's semantics permit safe retry. If outcome is unknown, query/reconcile before repeating.

## Event loss

If an event gap is detected:
1. stop assuming continuity
2. request authoritative snapshot/task state
3. reconcile artifacts
4. advance cursor
5. resume stream

A missed transient UI event must never become a missed durable task result.
