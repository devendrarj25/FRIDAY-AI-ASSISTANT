# Realtime Streaming

Every task exposes a stream:
- status
- progress
- reasoning summary (never raw hidden chain-of-thought)
- tool action summary
- artifacts
- warnings
- approvals
- verification
- cost/latency counters

Transport options:
IPC event bus, WebSocket/SSE bridge, local event store, remote event adapter.

Requirements:
backpressure, reconnect, replay-from-sequence, deduplication, cancellation, heartbeats.
