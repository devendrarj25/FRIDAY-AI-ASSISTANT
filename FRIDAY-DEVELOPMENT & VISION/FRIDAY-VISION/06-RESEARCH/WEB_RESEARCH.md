# Web Research Basis

Research checked during preparation of this master architecture.

## Microsoft Windows
- MSIX overview: https://learn.microsoft.com/en-us/windows/msix/overview
- Windows packaging overview: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/packaging/
- Windows packaging/deployment process: https://learn.microsoft.com/en-us/windows/apps/get-started/intro-pack-dep-proc
- MSIX update management: https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-update
- MSIX troubleshooting: https://learn.microsoft.com/en-us/windows/msix/msix-troubleshooting-guide

Microsoft documents MSIX as a modern Windows packaging format with clean install/uninstall and automatic update capabilities. FRIDAY can keep NSIS/electron-builder as its current practical distribution path while retaining MSIX as a future distribution option rather than forcing a framework migration.

## Electron / electron-builder
- Auto update: https://www.electron.build/docs/features/auto-update/
- Windows configuration: https://www.electron.build/docs/win/
- electron-updater: https://www.electron.build/docs/api/electron-updater/
- NSIS updater: https://www.electron.build/docs/api/electron-updater.class.nsisupdater/
- Publishing: https://www.electron.build/publish/

Current electron-builder documentation supports NSIS + electron-updater for Windows and provides Authenticode verification options for downloaded updates.

## GitHub
- Immutable releases: https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
- Artifact attestations: https://docs.github.com/en/actions/concepts/security-for-github-actions/artifact-attestations
- Build provenance: https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds

## npm
- npm ci: https://docs.npmjs.com/cli/v9/commands/npm-ci/
- package-lock: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/

npm documentation supports lockfile-driven reproducible installation and `npm ci` for clean CI installs.

## Design conclusion
The recommended FRIDAY architecture is not “replace everything with MSIX.” It is:
- retain the existing Electron/electron-builder base,
- build a FRIDAY-owned lifecycle/control plane around it,
- separate official application payload from user-owned components/data,
- use manifests + hashes + transaction journals,
- preserve rollback/recovery,
- use immutable release/provenance evidence,
- keep an MSIX distribution path as a future option.
