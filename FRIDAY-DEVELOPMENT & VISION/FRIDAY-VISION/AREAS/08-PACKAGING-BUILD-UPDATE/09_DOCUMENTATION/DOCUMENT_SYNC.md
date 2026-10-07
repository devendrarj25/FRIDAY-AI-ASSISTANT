# Documentation and File Synchronization

The repository must avoid hand-maintained duplicate version truth.

Canonical sources:
- version: `config/friday-version.json`
- toolchain: `config/toolchain-versions.json`
- component schema/manifest: designated manifest files
- release notes: release engine output
- build behavior: build contract/scripts

A release validation command should scan for stale hard-coded FRIDAY versions in generated/release-facing files and fail when they disagree with the canonical version.

Docs may show examples such as `1.2.14.50`, but examples must be clearly marked as examples and must not be parsed as current release truth.
