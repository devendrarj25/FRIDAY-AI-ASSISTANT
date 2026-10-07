# Event-Driven Capability Kernel

## Core events
`intent.created`
`intent.normalized`
`capability.discovery.started`
`capability.discovery.updated`
`capability.selected`
`plan.created`
`approval.requested`
`approval.granted`
`execution.started`
`execution.progress`
`artifact.created`
`execution.blocked`
`execution.failed`
`execution.retrying`
`execution.checkpointed`
`execution.resumed`
`execution.cancelled`
`execution.completed`
`verification.started`
`verification.passed`
`verification.failed`
`memory.updated`
`skill.learned`
`capability.degraded`
`capability.quarantined`

## Event requirements
- monotonic sequence per task
- correlation ID
- idempotency key
- timestamp + logical clock
- actor + authority
- payload schema version
- redaction classification
- replay safety
- persistence for long-running tasks
