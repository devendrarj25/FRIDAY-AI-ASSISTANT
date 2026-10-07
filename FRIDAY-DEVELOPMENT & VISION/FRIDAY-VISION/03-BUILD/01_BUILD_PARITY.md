# Build Parity — CMD and GitHub

There is one release/build contract.

```text
Canonical repo
   ↓
version source
   ↓
release engine
   ↓
dependency lock
   ↓
build scripts
   ↓
verification gates
   ├── local CMD
   └── GitHub Actions
```

CMD and CI must call the same scripts and use the same manifests.

## Required checks
- version consistency
- lockfile consistency
- dependency installation
- runtime provisioning
- renderer build
- packaging
- signature checks where configured
- boot/readiness
- artifact manifest
- release metadata
