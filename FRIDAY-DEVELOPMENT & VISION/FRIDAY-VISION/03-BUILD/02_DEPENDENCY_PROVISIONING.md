# Dependency Provisioning

## Core
Required normal-size dependencies are deterministic and provisioned during build/bootstrap.

Use lockfiles and reproducible installation. `npm ci` is preferred for CI/clean builds because it requires the lockfile and fails when package.json and the lock do not match.

## Heavy
Large models, GPU stacks, optional runtimes and large capability packs belong in Install Manager distribution.

## Evidence
Record for every external artifact:
- URL/source
- version
- SHA-256
- expected size/range
- architecture
- license metadata where applicable
- download timestamp
- verification result

## Cache
Caches are disposable and must never be treated as user data.
