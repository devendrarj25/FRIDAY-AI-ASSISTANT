# SECRET BOUNDARIES

Model context should receive:
credential handle + allowed operation + redacted metadata.

Execution runtime resolves the secret only when policy allows it.
Secrets never enter:
- capability descriptions
- logs
- telemetry payloads
- artifacts
- long-term memory
- error messages

Revocation invalidates active sessions and cached authority.
