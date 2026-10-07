# Runtime Fabric

Runtimes are first-class managed resources.

Examples:
- Node
- Python
- SQLite/native libraries
- GPU/runtime packages
- specialized tool runtimes

## Runtime record
Track:
`id, version, architecture, path, source, hash, dependencies, capabilities, health, owner`.

## Policy
Required small/core runtimes can be provisioned by bootstrap/build.
Large/optional runtimes are Install Manager resources.

## Isolation
Prefer FRIDAY-managed runtime paths and explicit environment construction. Avoid mutating the user's global PATH unless an OS integration explicitly requires it.

## Health
Each runtime has:
- executable probe
- version probe
- dependency probe
- disk/permission probe
- compatibility check
- repair action
