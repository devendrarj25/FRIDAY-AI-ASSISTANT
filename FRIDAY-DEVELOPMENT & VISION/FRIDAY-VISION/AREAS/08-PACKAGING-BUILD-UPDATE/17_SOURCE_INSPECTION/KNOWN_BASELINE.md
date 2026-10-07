# Known Baseline Inspected

The architecture was checked against the supplied FRIDAY repository and prior packaging blueprint.

Observed relevant owners include:
- `scripts/release-engine.cjs`
- `scripts/build-windows.cmd`
- `scripts/electron-pack.cjs`
- `scripts/init-runtime.cjs`
- `scripts/env-registry.cjs`
- `electron-builder.yml`
- `electron/readiness.cjs`
- `scripts/verify-build.cjs`
- `scripts/verify-boot.cjs`
- `scripts/readiness-test.cjs`
- existing `updater/*`
- existing `.github/workflows/*`
- `config/friday-version.json`
- `config/toolchain-versions.json`

Implementation must inspect exact current contents before editing. The plan intentionally avoids asserting that every proposed path/file already exists.
