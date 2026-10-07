# Release Security and Supply Chain

## Release artifact
Each release should have:
- immutable version/tag
- artifact hashes
- signed Windows binaries where applicable
- build provenance/attestation
- SBOM
- manifest of packaged files

## CI
Use protected release branches/tags, least-privilege workflow permissions, and isolated signing credentials.

## Verification
The client should verify update authenticity and integrity before activation.

GitHub immutable releases and artifact attestations are preferred evidence mechanisms for official release provenance.
