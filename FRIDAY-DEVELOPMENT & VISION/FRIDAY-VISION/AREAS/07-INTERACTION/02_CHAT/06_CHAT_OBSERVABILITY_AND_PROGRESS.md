# Chat Observability and Progress

The user-facing progress state is a projection of runtime events. A spinner is never evidence of work; “completed” is never derived from a model response alone.

Trace fields connect turn → plan → route → action → task → artifact. Important events are timestamped. Long-running work exposes meaningful milestones without leaking sensitive data.

Metrics include turn acceptance latency, model first token, tool latency, task queue delay, verification latency, fallback count, cancellation latency, stale-output drops, reconnect count and resource pressure. Existing observability/doctor systems own collection.
