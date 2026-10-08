# FRIDAY Packaging, Build, Install & Update — Future-Proof Architecture V2

## Purpose
This package is the implementation blueprint for the FRIDAY desktop distribution lifecycle: local CMD builds, repository/GitHub builds, installers, self-contained component/runtime management, safe updates, rebuilds, rollback, uninstall cleanup, and release/document synchronization.

This V2 incorporates the final decisions from the design discussion:

- Public FRIDAY version is exactly **Extreme.Major.Minor.Patch** (example `1.2.14.50`). There is no revision/build suffix.
- **UPDATE** changes the public version according to the release policy.
- **REBUILD** produces the same public version again; it is a rebuilt artifact, not a new version.
- CMD and GitHub/CI must use the same canonical source, release engine, manifests, dependency lock, tests and evidence rules.
- Required, reasonably sized dependencies needed for FRIDAY itself are provisioned during build/bootstrap and placed at controlled FRIDAY paths.
- Heavy/optional models, runtimes, agents, skills, tools, plugins and workflows are installed later through the FRIDAY Install Manager.
- Official components and user-installed components are ownership-separated and must never be confused.
- User-installed components are preserved across FRIDAY updates even when they are absent from the official update package.
- All FRIDAY-managed downloads, runtimes, packages, components, models, data, caches, logs and recovery state live under the FRIDAY-managed root wherever technically possible.
- Uninstall supports **Keep Data** and **Remove All FRIDAY Data**. The latter removes only the verified FRIDAY-owned root and FRIDAY-created OS integration artifacts.
- Updates are staged, verified, journaled, health-checked and rollback-capable.
- Application payload is replaceable; user data and user-owned components are not.

Folder order: `00_MASTER` through `13_MIGRATION`, then `14_DIAGRAMS` and `14_IMPLEMENTATION` (both keep 14), then `15_COMMANDS`, `16_RESEARCH`, `17_SOURCE_INSPECTION`, `config/`, and `schemas/`. `FILE_INDEX.json` lists those files by path and size.

## Important implementation boundary
This is an architecture/implementation plan, not a claim that the existing source has already been changed. Apply it to the repository after reviewing the file map and existing owners. Do not create duplicate release/version/runtime/update owners.

## Primary Windows distribution direction
Retain the current Electron + electron-builder + NSIS direction for the immediate implementation because the existing FRIDAY repository already has this pipeline. electron-builder documents NSIS as its Windows installer target and electron-updater supports Windows NSIS updates. MSIX is documented as a strong future distribution option, but it should not replace the existing self-contained component ecosystem until the mutable/user-component model is proven under a dedicated packaging design.

## Research basis
See `16_RESEARCH/WEB_RESEARCH_SOURCES.md`. Microsoft documents MSIX as a clean install/uninstall/update model; electron-builder documents NSIS/electron-updater behavior; GitHub documents immutable releases and artifact attestations; npm documents lockfile-driven `npm ci` reproducibility.
