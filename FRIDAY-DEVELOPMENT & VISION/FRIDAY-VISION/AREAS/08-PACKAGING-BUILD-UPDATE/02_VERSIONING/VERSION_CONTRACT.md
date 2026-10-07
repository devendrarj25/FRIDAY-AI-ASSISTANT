# FRIDAY Version Contract

## Public format
`Extreme.Major.Minor.Patch`

Example: `1.2.14.50`

There is **no revision/build number**.

## Operations

### UPDATE
A release change. The release engine decides which segment changes according to the selected release intent:

- patch: `1.2.14.50 -> 1.2.14.51`
- minor: `1.2.14.50 -> 1.2.15.0`
- major: `1.2.14.50 -> 1.3.0.0`
- extreme: `1.2.14.50 -> 2.0.0.0`

### REBUILD
Rebuilds the exact same public version. Example:

`1.2.14.50 -> REBUILD -> 1.2.14.50`

A rebuild must still be traceable internally to source commit, dependency lock, toolchain, build timestamp and artifact hashes. Those are release evidence, not version-number components.

## Single source of truth
`config/friday-version.json` remains canonical. Other version strings are generated/synchronized from it or validated against it. Release must fail on drift.
