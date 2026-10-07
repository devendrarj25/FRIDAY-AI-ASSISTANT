# FRIDAY — Architecture Baseline (v1.0.0.2)

**baseline locked** on the 1.0.0.2 checkout.

Folder and subsystem pins the architecture audit enforces. Runtime layers: [ARCHITECTURE.md](../../../../../ARCHITECTURE.md). Disk rules: [FRIDAY_STORAGE_CONTRACT.md](../../../../../docs/FRIDAY_STORAGE_CONTRACT.md).

## 1. Layout manifest

`config/project-structure.json` is generated. Source: `electron/friday-contract.cjs` `SOURCE_LAYOUT`. Regenerate: `node scripts/arrange-project.cjs --fix`. Check: `npm run arrange:check`.

| Tree | Folders in `SOURCE_LAYOUT` today |
| --- | --- |
| `code` | 17 (`src/routes`, `src/lib/friday`, `core`, `electron`, `kernel`, `scripts`, `installer`, `updater`, `testing`, `system`, …) |
| `capabilities` | 53 (every `TREES` segment plus `*/manifests`) |
| `data` | 69 (`backup/*`, `brain-data/*`, `config/*`, …) |

`FOLDERS` has 40 top-level keys. Program folder constant: `app` (`<root>\App`).

## 2. Drift detectors

`scripts/audit-architecture.cjs` (report; `--strict` fails on byte-identical duplicate runtime files):

- duplicate implementations
- conflicting same-filename bodies
- orphan modules
- legacy paths that must not return: `src/pages`, `src/lib/lovable`, `electron/updater-old`, `scripts/release.cjs`
- builder residue (`@lovable` in `package.json` / Vite)

## 3. `core/` is not the live runtime

Vitest and typed contracts live under `core/`. Renderer, Electron, and kernel must not import it as a second brain. Locked-path tests: `core/__tests__/project-independence.test.ts`.

## 4. Authoritative files (do not fork)

| Subsystem | File |
| --- | --- |
| Navigation | `src/lib/friday/navigation.ts` |
| Update safety | `electron/update-safety.cjs` |
| Identity | `scripts/identity.cjs` |
| Version | `config/friday-version.json` |
| Docs registry | `scripts/docs-engine.cjs` |
