# Rebuild Contract

A REBUILD is allowed when the public version must remain unchanged but a new artifact is required.

Valid reasons include:
- failed/corrupt previous artifact
- signing/repackaging issue
- CI infrastructure failure
- dependency artifact repair under a locked source state
- release asset regeneration

A rebuild must not silently change source-controlled dependencies. If source/dependencies materially change, perform an UPDATE instead.

A rebuild gets new evidence/attestation/checksums but no public revision number.
