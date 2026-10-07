# Supply Chain Security

Minimum controls:
- lock dependency versions
- verify downloaded runtime/package hashes
- prefer HTTPS sources
- restrict allowed hosts for managed artifacts where practical
- verify Authenticode signatures for signed update artifacts
- generate SBOM
- preserve source/build provenance
- use GitHub artifact attestations where available
- use immutable releases for official published assets
- fail closed on manifest/hash/signature mismatch

Never execute an unverified downloaded executable as a trusted FRIDAY component.
