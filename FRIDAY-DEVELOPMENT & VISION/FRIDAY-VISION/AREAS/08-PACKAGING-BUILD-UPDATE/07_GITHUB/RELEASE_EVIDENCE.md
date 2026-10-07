# Release Evidence

Every release/rebuild should produce machine-readable evidence:
- public version
- release intent (`update` or `rebuild`)
- source commit
- repository ref/tag
- toolchain versions
- dependency lock hashes
- component manifest hash
- runtime manifest hash
- installer artifact SHA-256
- portable artifact SHA-256 when built
- update manifest hash
- SBOM reference
- signing status
- test/readiness summary

For REBUILD, evidence changes while public version remains identical.
