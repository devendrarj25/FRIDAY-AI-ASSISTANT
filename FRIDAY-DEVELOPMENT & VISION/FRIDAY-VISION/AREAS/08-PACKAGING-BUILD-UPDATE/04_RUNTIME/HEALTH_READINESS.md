# Runtime Health and Readiness

Separate:

- **health**: component exists and its integrity is valid
- **readiness**: FRIDAY can actually invoke it for its supported contract

Checks should include:
- file/hash integrity
- executable startup
- required ports/resources only when applicable
- dependency resolution
- version compatibility
- permission/path checks
- FRIDAY registry registration

A component is not marked ready just because files were extracted.
