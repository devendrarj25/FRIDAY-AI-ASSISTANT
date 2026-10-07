# CAPABILITY CONFORMANCE TEST

Every adapter must pass:

1. Manifest schema validation.
2. Stable ID/version validation.
3. Input validation.
4. Output type validation.
5. Permission declaration check.
6. Risk classification check.
7. Health probe.
8. Dependency probe.
9. Dry-run/smoke test where supported.
10. Timeout/cancellation test.
11. Error normalization test.
12. Artifact provenance test.
13. Telemetry event test.
14. Policy-denial test.
15. Retry/idempotency test for side effects.
16. Verification hook test.
17. Quarantine test after repeated failures.
18. Upgrade/backward compatibility test.

A capability cannot become READY until its applicable conformance tests pass.
