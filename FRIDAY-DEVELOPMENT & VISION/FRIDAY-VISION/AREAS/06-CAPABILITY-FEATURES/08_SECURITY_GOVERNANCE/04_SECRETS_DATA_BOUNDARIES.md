# Secrets + Data Boundaries

- secrets live in credential manager, not model context
- capabilities receive scoped tokens, not raw secrets
- sensitive artifacts carry classification
- redaction happens before telemetry export
- plugins get least privilege
- network egress is policy controlled
- logs have retention classes
- local-only mode must be enforceable
