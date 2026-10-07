# Install Manager Component Lifecycle

Example conceptual lifecycle:

```text
friday component install <manifest-or-package>
  -> validate manifest
  -> resolve dependencies
  -> download/stage
  -> verify hash/signature
  -> install under user/optional ownership root
  -> register
  -> health/readiness
  -> activate
```

The command names are illustrative; use the repository's actual CLI/API surface.
