# FRIDAY Versioning Contract

Public version format:

`Extreme.Major.Minor.Patch`

Example:
`1.2.14.50`

## UPDATE
Changes the public version:
- patch: `1.2.14.50 → 1.2.14.51`
- minor: `1.2.14.50 → 1.2.15.0`
- major: `1.2.14.50 → 1.3.0.0`
- extreme: `1.2.14.50 → 2.0.0.0`

## REBUILD
Same public version:
`1.2.14.50 → rebuild → 1.2.14.50`

No public revision/build number.

A rebuild is distinguished operationally by release artifact identity, checksum, commit SHA and build provenance—not by changing the product version.
