# Event Contract

All cross-runtime events should be versioned and correlate to a task/run.

Minimum envelope:
```json
{
  "event_id": "evt_*",
  "event_type": "namespace.action",
  "schema_version": 1,
  "occurred_at": "ISO-8601",
  "request_id": "req_*",
  "session_id": "ses_*",
  "task_id": "task_*",
  "run_id": "run_*",
  "producer": "component-id",
  "payload": {}
}
```

Rules:
- producers own their event schemas;
- consumers tolerate additive fields;
- no secret-bearing payloads by default;
- retries must be idempotent;
- events are not automatically truth; evidence/state stores remain authoritative.
