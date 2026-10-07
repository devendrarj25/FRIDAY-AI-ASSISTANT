# Feature Registry

Feature manifest fields:
`id, version, name, intentTags, surfaces, requirements, composition, permissions, risk, readinessChecks, successCriteria, evalSuite, rollout, lifecycle, telemetry`.

Feature activation must be dynamic:
- detect request
- match feature
- verify readiness
- compose missing pieces
- ask only necessary configuration
- run
- verify
- learn
