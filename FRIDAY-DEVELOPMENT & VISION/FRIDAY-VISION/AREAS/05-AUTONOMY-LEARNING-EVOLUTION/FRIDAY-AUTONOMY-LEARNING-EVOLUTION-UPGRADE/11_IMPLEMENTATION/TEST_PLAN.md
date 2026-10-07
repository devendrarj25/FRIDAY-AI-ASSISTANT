# Test Plan

## Unit
- candidate lifecycle
- scoring
- confidence updates
- curriculum selection
- autonomy budget accounting
- rollback state machine

## Integration
- task → experience → lesson
- limitation → growth opportunity
- candidate → sandbox → eval → promotion
- adapter → holdout → canary → rollback

## Safety
- candidate cannot modify evaluator and pass
- candidate cannot disable governance
- no credential enters training set
- network allowlist enforced
- budget exhaustion stops work
- crash during apply restores checkpoint

## Chaos/failure injection
- provider outage
- model timeout
- corrupted candidate
- failing tests
- evaluator unavailable
- disk full
- process crash
- interrupted training
- conflicting memories

## Acceptance target
No new self-improvement feature is considered complete until it has:
`deterministic test + behavioral eval + rollback test + audit evidence`.
