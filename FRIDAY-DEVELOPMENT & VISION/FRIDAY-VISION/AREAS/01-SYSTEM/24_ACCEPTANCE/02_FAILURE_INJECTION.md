# Failure Injection Scenarios

1. Model timeout → fallback model if data policy permits.
2. Tool timeout → retry only if idempotent; otherwise reconcile.
3. Browser target disappears → re-observe, do not click blindly.
4. Network disconnect → pause unsafe external action and resume after reconciliation.
5. Event consumer disconnect → snapshot + cursor resync.
6. Kernel restart → durable task resumes from checkpoint.
7. Corrupt policy hash → privileged execution fails closed.
8. Malicious file instruction → remains untrusted content.
9. Connector schema drift → capability quarantined.
10. Self-change test failure → candidate rejected and production untouched.
11. Resource exhaustion → governor degrades concurrency/quality before violating policy.
12. Conflicting memory → reconciliation record, not silent overwrite.
