# Web Research Sources

Research checked for this V2 architecture:

- Microsoft MSIX overview: https://learn.microsoft.com/en-us/windows/msix/overview — MSIX provides clean install/uninstall and update capabilities.
- Microsoft Windows packaging overview: https://learn.microsoft.com/en-us/windows/apps/get-started/intro-pack-dep-proc — packaging affects installation, update and uninstall behavior.
- Microsoft MSIX update guidance: https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-update — update behavior and incremental/differential considerations.
- Microsoft MSIX packaging: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/packaging/
- electron-builder auto update: https://www.electron.build/docs/features/auto-update/ — electron-updater and CI/release integration.
- electron-builder Windows: https://www.electron.build/docs/win/ — NSIS and Windows signing/update verification configuration.
- electron-builder NSIS: https://www.electron.build/docs/nsis/
- electron-updater API: https://www.electron.build/docs/api/electron-updater/
- GitHub immutable releases: https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
- GitHub artifact attestations: https://docs.github.com/en/actions/concepts/security-for-github-actions/artifact-attestations
- npm ci: https://docs.npmjs.com/cli/v9/commands/npm-ci/ — lockfile consistency and clean installation.
- npm package-lock: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/

Research conclusion: the safest FRIDAY design is not to let a generic installer/update mechanism own user-installed components. FRIDAY needs an explicit ownership/registry layer above the installer. The existing Electron/NSIS path can remain the primary implementation while this control plane is added.
