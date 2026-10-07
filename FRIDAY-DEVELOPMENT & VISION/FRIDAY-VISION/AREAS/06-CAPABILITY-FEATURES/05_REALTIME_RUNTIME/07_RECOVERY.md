# Recovery

Failure classes:
- transient provider
- dependency unavailable
- policy blocked
- authentication
- environment drift
- stale schema
- tool error
- model error
- verification failure
- user cancellation
- resource exhaustion

Recovery ladder:
retry → alternate capability → alternate provider/model → alternate execution mode → human approval → graceful failure.

Never retry irreversible side effects blindly.
