# Runtime Registry Contract

Registry record minimum:

- id
- type
- owner
- version
- source
- install root
- executable/runtime entrypoints
- architecture
- OS compatibility
- dependencies
- SHA-256
- install timestamp
- lifecycle state
- enabled state
- compatibility range
- uninstall policy
- health/readiness result

Lifecycle states:
`planned -> downloading -> staged -> installing -> verifying -> installed -> healthy`

Failure states:
`failed -> degraded -> quarantined`

Recovery must be idempotent.
