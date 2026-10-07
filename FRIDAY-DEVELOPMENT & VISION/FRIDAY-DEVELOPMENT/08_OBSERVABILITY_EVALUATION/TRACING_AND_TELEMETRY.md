# Observability Contract

Trace one end-to-end task.

Suggested span hierarchy:
`task → turn → agent → model generation → tool → guardrail → handoff → verification`

Attach:
- task/run IDs;
- component/provider/capability IDs;
- latency;
- retries;
- policy decisions;
- token/cost estimates;
- verification outcome.

Sensitive payloads are redacted or hashed according to privacy policy.

OpenTelemetry-style semantic consistency is preferred so FRIDAY telemetry can be exported without redesign.
