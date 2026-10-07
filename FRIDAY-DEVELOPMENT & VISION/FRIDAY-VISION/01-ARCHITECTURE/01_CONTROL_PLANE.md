# FRIDAY Control Plane

The Control Plane coordinates the system; it is not the LLM itself.

## Responsibilities
- lifecycle state
- component discovery
- runtime health
- model availability
- task/run identity
- policy and authority
- install/update transactions
- recovery
- telemetry/diagnostics
- event routing

## Event envelope
```json
{
  "eventId": "stable-id",
  "type": "component.install.completed",
  "timestamp": "ISO-8601",
  "runId": "stable-run-id",
  "source": "install-manager",
  "payload": {},
  "schemaVersion": 1
}
```

Events should be append-only evidence where practical. Derived indexes may be rebuilt.
