# File-by-File Implementation Plan

## Existing owners to extend, not duplicate

- `config/friday-version.json` — canonical Extreme.Major.Minor.Patch version.
- `config/toolchain-versions.json` — supported toolchain/runtime floor.
- `package.json` — scripts only; no duplicate release logic.
- `scripts/release-engine.cjs` — sole release/version/release-note decision owner.
- `scripts/build-windows.cmd` — local Windows entry point; invoke shared build contract.
- `scripts/electron-pack.cjs` — packaging owner.
- `scripts/init-runtime.cjs` — runtime bootstrap owner.
- `scripts/env-registry.cjs` — environment registry owner.
- `electron/readiness.cjs`, `verify-build.cjs`, `verify-boot.cjs`, `readiness-test.cjs` — verification owners; extend rather than duplicate.
- `updater/*` — update owner.
- `.github/workflows/*` — CI orchestration; call shared scripts.

## New logical responsibilities

1. Release manifest generation/validation.
2. Core payload manifest.
3. Component manifest and ownership registry.
4. Runtime manifest.
5. Update transaction journal.
6. Uninstall ownership verifier.
7. Release evidence/SBOM generation.
8. User-component preservation integration tests.

## Suggested files (adapt names to actual repository)

```text
config/release-policy.json
config/core-payload-manifest.json
config/component-manifest.schema.json
config/runtime-manifest.json
config/update-policy.json
scripts/release-manifest.cjs
scripts/release-evidence.cjs
scripts/verify-release.cjs
scripts/verify-update.cjs
scripts/component-manager.cjs
scripts/uninstall-ownership-check.cjs
updater/journal/*
updater/verification/*
installer/recovery/*
.github/workflows/release-attest.yml
.github/workflows/release-verify.yml
```

Do not add a file merely because it appears in this plan if an existing file already owns the same responsibility. Merge the contract into the existing owner.

## Current source-specific integration points

The existing repository already has release/version, runtime setup, build, verification and updater concepts. Implementation should extend those rather than creating a parallel packaging framework.
