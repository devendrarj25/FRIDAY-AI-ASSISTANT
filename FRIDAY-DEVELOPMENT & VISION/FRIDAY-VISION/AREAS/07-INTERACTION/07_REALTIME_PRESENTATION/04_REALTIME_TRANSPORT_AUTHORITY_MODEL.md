# Realtime Transport and Authority Model

## Planes
1. Control: authenticated request/response and commands.
2. Event: ordered state events with cursor/version.
3. Media: realtime audio/video.
4. Artifact: durable result transfer.
5. Attention: notifications/deep links.

## Ordering
Each durable event has a monotonic stream position/cursor within its authority scope. Clients detect gaps and request reconciliation. Ephemeral media/UI events are not promoted to durable task truth.

## Backpressure
High-rate streams must have bounded buffers, prioritization and safe coalescing. Never allow a mobile browser queue to grow without bound. Durable events are replayable by cursor; ephemeral events can be skipped when a newer state supersedes them.

## Reconnect
`connected → degraded → disconnected → authenticating → snapshot → cursor catch-up → live → degraded`.
A mutation is retried only when its idempotency contract allows it. Otherwise its outcome is reconciled before any new mutation is issued.

## Authority
Transport proves connectivity, not permission. Session proves authenticated identity, not action authorization. Capability scope proves feature authorization, not risk approval. Governance proves whether the requested action may execute.
