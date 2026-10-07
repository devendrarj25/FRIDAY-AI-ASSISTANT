# Dependency Freeze

Node dependencies are governed by `package-lock.json`; clean release builds use `npm ci`, which fails when package.json and the lockfile are inconsistent. This makes dependency drift visible instead of silently rewriting the dependency tree.

Python dependencies must have an explicit lock/constraint strategy. Do not rely on whatever happens to be newest on PyPI during a release build.

For bundled external binaries/runtimes:
- pin exact version
- pin source URL(s)
- record SHA-256
- record architecture
- record license/source metadata
- verify before staging
- keep the downloaded artifact out of user data

The release manifest must record the resulting dependency evidence.
