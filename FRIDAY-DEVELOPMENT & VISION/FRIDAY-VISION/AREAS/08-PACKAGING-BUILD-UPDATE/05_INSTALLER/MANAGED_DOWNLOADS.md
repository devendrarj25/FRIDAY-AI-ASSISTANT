# Managed Downloads

All FRIDAY-managed downloads use a controlled staging area under the FRIDAY root.

Rules:
- temporary/incomplete files use `.part`/transaction-specific staging names
- final assets are moved only after integrity verification
- failed downloads are cleaned or retained as resumable partials only when explicitly supported
- source URL, final URL, hash, size and component ID are recorded
- no unverified executable/runtime becomes active
- network retry/backoff is bounded
- install manager refreshes registry after successful activation
