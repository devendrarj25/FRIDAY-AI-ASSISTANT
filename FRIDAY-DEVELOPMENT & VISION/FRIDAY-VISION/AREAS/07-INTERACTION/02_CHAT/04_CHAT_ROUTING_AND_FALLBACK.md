# Chat Routing, Retry and Fallback

## Candidate score
A candidate is evaluated on objective fit, capability health, permission, data access, reliability, latency, resource cost, streaming/cancellation support, risk compatibility and evidence quality.

## Retry classes
- Safe/idempotent read: bounded retry.
- Deterministic provider error: bounded alternate provider.
- Rate limit: backoff if policy permits.
- Permission/policy: no retry until authority changes.
- Unknown side effect: reconcile first.
- User cancellation: no automatic retry.

## Circuit breaking
A failing provider/capability can be temporarily avoided based on measured health. The circuit state is evidence for routing, not a permanent disablement. Existing health/doctor infrastructure remains authoritative.

## Result reuse
A verified read result may be reused if freshness and scope constraints still hold. A mutation's prior success never authorizes repeating it.
