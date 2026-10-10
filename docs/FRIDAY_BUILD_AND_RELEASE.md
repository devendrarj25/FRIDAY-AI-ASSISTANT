# FRIDAY — Build, Release, Version & Update Guide

**Made by:** Devendra Singh Meena (devendrarj25)
**Current shipping version: 1.0.1.2**

📦 This is the packaging document. It tells you how a Windows pack is made, how a TEST pack stays beside the Official app, and how an installed copy chooses Stable or Test. Click-by-click publish is [RELEASE.md](../RELEASE.md). The counters are [VERSIONING.md](../VERSIONING.md). Each workflow file is [FRIDAY_GITHUB_ACTIONS.md](FRIDAY_GITHUB_ACTIONS.md). Disk rules are [FRIDAY_STORAGE_CONTRACT.md](FRIDAY_STORAGE_CONTRACT.md). This file is the documentation contract for packaging behaviour.

## 1. One pack path

`scripts/build-pipeline.cjs` is the only Windows pack recipe. The CMD wrapper, `npm run build:win`, `build:win:dir`, `build:all`, `release:package`, `build:portable`, `desktop:build`, `desktop:pack`, FRIDAY Release, and FRIDAY Test Build call it. They differ only by named options: channel (`production` or `test`), version stamp, package targets, signing, and whether a later job publishes. The phase order does not change.

| Phase | What it does |
| --- | --- |
| `prepare-environment` | Engines, `npm ci`, Electron, Python, runtime, environment repair |
| `verify-versions` | Heal and verify the version docs, then dependency verify |
| `stage-toolchain` | Stamp a test version when one was passed, then stage the toolchain packs |
| `build-renderer` | `npm run build:desktop` |
| `package` | `scripts/electron-pack.cjs` |
| `sign-hook` | Optional Authenticode when a certificate is present |
| `manifest` | Checksums and the update manifest (skipped for `dir` only) |
| `verify-artifacts` | `verify-build`, then the unpacked layout and the installer size floor |
| `verify-boot` | Boot the packed app |
| `readiness` | `readiness-test.cjs --pack` |
| `installer-smoke` | Silent install, boot, reinstall, uninstall on Windows when the target includes NSIS |

| Path | How you start it | Named difference |
| --- | --- | --- |
| Local CMD | `scripts\build-windows.cmd` / `npm run build:win` | `--channel production`. No `npm test`. No GitHub publish. |
| TEST | Actions → **FRIDAY Test Build** | `--channel test`, a TEST version stamp, optional publish of a prerelease |
| Official | Actions → **FRIDAY Release** (`stage=all` by default) | `--channel production` after the release pull request is on `main` |

File names use the public four-part identity. The npm field stays the three-part encoding. ExtraResources copy the kernel, the capability trees, and the scripts, except the `cloud-agent-*` helpers. A report is written to `release/build-report.json`.

The first pack needs the network so `scripts/stage-toolchain.cjs` can fetch the packs named in `config/toolchain-manifest.json` and check their SHA-256. Later packs reuse `.cache/toolchain`. `FRIDAY_SKIP_TOOLCHAIN_STAGE` is refused: a skipped stage must not emit a small EXE. Setup and Portable must be at least 70 percent of the bundled pin sum and strictly under 2 GiB (and under the manifest budget plus 800 MiB). A missing pack or a short installer fails the build with the text `refusing a small EXE`. The hosted Windows extract of the embeddable Python runtime, `python -m pip --version`, the whisper.cpp version command, and the sandbox probe are planned in `runtimeSmokePlan` and were not executed on this Linux check.

### Pack-toolchain advisories (2026-10-07)

`http-cache-semantics` is locked at 4.3.0. [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) covers `<= 4.2.0` (advisory API, 2026-10-07; `firstPatchedVersion` is empty). Registry 4.3.0 was published 2026-10-04 ([package](https://registry.npmjs.org/http-cache-semantics), [repository](https://github.com/kornelski/http-cache-semantics)). **ADAPT**: `cacheable-request` already allows `^4.0.0`, so the lock moves to 4.3.0 with no extra override. That release is outside the published range. Its `max-stale` predicate matches 4.2.0; the 4.3.0 change is `Vary: *` matching plus the cached response status ([upstream issue 56](https://github.com/kornelski/http-cache-semantics/issues/56) closed the report). `npm audit` on this machine after the move: 0 (before the move, after the pack-helper override: 1 high). The chain stays dev-only: `app-builder-lib` → `@electron/get` 3.1.0 → `got` 11.8.6 → `cacheable-request` 7.0.4. Installed for the pack, not bundled in the EXE. Unpacked size 50.4 kB.

`sprintf-js` has no release after 1.1.3 ([package](https://registry.npmjs.org/sprintf-js)). [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) covers `<= 1.1.3` and has no patched version. **REJECT** a direct bump. `global-agent` 4.0.0 still depends on `roarr`; 4.1.0 and later do not. `app-builder-lib` 26.17.0 still depends on `@electron/get` `^3.0.0`, so a newer 26.x builder does not drop the chain. **REJECT** that bump.

**ADOPT** `overrides.global-agent` `4.1.3` ([registry](https://registry.npmjs.org/global-agent), [repository](https://github.com/gajus/global-agent), 2026-10-07). It still exports `bootstrap()`, which is the only call `@electron/get` 3 makes, and it does not depend on `roarr` or `sprintf-js`. Dev-only optional pack helper. Unpacked size 87313 bytes. `npm ci` installs it, and both `electron-builder` and the nested `@electron/get` still resolve.

The local CMD wrapper is [INSTALL.md](../INSTALL.md). CMD does not run `npm test`. PR Validation, FRIDAY Test Build, and the prepare job of FRIDAY Release do.

## 🪪 Package identity

Every package kind reads `scripts/identity.cjs`. The kinds are npm (`package.json`), the NSIS Setup, the portable EXE, the unpacked app, the source zip (`FRIDAY-PACKAGE.json`), and the update manifest (`friday-update.json`). The stamp is the product name **FRIDAY**, the owner **Devendra Singh Meena**, and the GitHub username `devendrarj25`. The publisher line is `Devendra Singh Meena (devendrarj25)`. Those records do not carry an email, a phone number, or a street address.

An installed copy keeps `scripts/identity.cjs` beside the app, under `resources/scripts`. `electron-builder.yml` ships the scripts tree as an extra resource and packs only `scripts/release-engine.cjs` inside `app.asar`. `electron/dev-workflow.cjs` loads the checkout path when that file is present, then `resources/scripts/identity.cjs`. The installed main process reaches the boot self-test after that load succeeds. The Windows installer lifecycle was not run on this Linux check.

`auditPackageIdentity` checks that stamp for all six kinds. The identity test runs it on every machine. On Windows, `scripts\build-windows.cmd` reaches the same publisher through `scripts/verify-build.cjs` when it reads the EXE resources (product name, company name, file version). A check on Linux does not replace that Windows resource read. The unpacked EXE is still unverified until that Windows step runs.

## 2. Rebuild, update, and auto

Official `mode` means one of these:

- **rebuild** — pack the **same version** again and replace the release assets. `revision` is this same rebuild. The number does not move.
- **update** — move one counter, open the `release/v…` pull request, then publish. The number is used only after that publish succeeds. The same release type retries a failed number. A different explicit level skips that number and counts from the last success.
- **auto**, when `release_type` is also auto — finish the unpublished line as it stands. It does not invent the next number. If you pick patch, minor, major, or extreme yourself, only that one counter moves, even when `mode` is auto, and even when that line has never been published. A stable git tag counts as a published number, the same as a GitHub release.

`scripts/release-engine.cjs` writes the identity into the tree before the pack. The in-app Analyze preview asks that same decision, including a stable git tag, and does not compute a second number. The in-app update check and the release list both read up to 100 GitHub releases, the same window FRIDAY Release uses. An installed copy checks the SHA256 in `friday-update.json` before it replaces itself.

## 3. 🧪 TEST identity

`.github/workflows/test-build.yml` (**FRIDAY Test Build**) packs a Windows EXE from a branch, a tag, a commit, or `pr/<n>`. It does not edit `main`, it does not change `config/friday-version.json`, and it does not create a Latest stable release. It calls `scripts/build-pipeline.cjs --channel test`.

| Property | Official (`electron-builder.yml`) | TEST override |
| --- | --- | --- |
| `appId` | `dev.friday.desk` | `dev.friday.desk.test` |
| `productName` | `FRIDAY` | `FRIDAY Test` |
| Setup name | `FRIDAY-Setup-<ver>.exe` | `FRIDAY-Test-Setup-<ver>.exe` |
| Uninstall display | `FRIDAY - Personal AI Assistant` | `FRIDAY Test - Personal AI Assistant` |

The executable file name stays `FRIDAY.exe`. The separate app id is what lets Windows keep TEST beside Official.

`electron/build-channel.cjs` reads the channel in this order: `FRIDAY_BUILD_CHANNEL` or `FRIDAY_TEST_BUILD=1`, then the packaged `resources/build-channel.json`, then production. The pipeline writes `resources/build-channel.json` with `channel: "test"` before the pack, and deletes that file on a production pack. Test profile data stays apart from the Official FRIDAY folder.

Dispatch inputs:

- `ref` — branch, tag, commit, or `pr/<n>`
- `package` — installer, portable, or unpacked (publish needs an installable artifact)
- `publish` — default false. True uploads a prerelease `v<four-part>-test.N` with `--prerelease`

## 4. 🔄 Stable and Test on an installed copy

Settings → Updates → Update channel. The choice is stored in `<FRIDAY_ROOT>/config/github.json` as `updateChannel` (`electron/github-sync.cjs`). `normalizeUpdateChannel()` maps anything else to `"stable"`.

| Channel | What it offers | Windows identity |
| --- | --- | --- |
| Stable (default) | Releases with `isPrerelease: false` | `dev.friday.desk` |
| Test (you opt in) | Prereleases, and names that match test, rc, beta, alpha, nightly, or preview | `dev.friday.desk.test` |

Each channel remembers its own applied build: `appliedRef` for Stable, `testAppliedRef` for Test.

A packaged copy uses GitHub Releases only (`checkUpdate` in `electron/github-sync.cjs`). `electron/updater.cjs` is not a second app feed. The file that installs is an installer. It is checked with the SHA256 in `friday-update.json`, then `electron/update-safety.cjs` takes a backup, installs, checks health, and rolls back if that check fails.

An unpackaged checkout may use `channel: "branch"` against HEAD. That mode is not available once the app is packed.

Candidates are ordered by `compareBuilds` in `scripts/release-engine.cjs` (four-part, then `-test.N`). Official publish cleanup keeps the newest 3 stable releases. Maintenance Cleanup keeps the newest TEST prerelease. Those cleanup rules are in [FRIDAY_MERGE_FLOW.md](FRIDAY_MERGE_FLOW.md).

## 5. 🔏 Signing

Unsigned is the honest default (`signExecutable: false`). The pipeline signs only when `CSC_LINK`, `WIN_CSC_LINK`, or `FRIDAY_PFX` is set, and it does not print the password. On FRIDAY Release and FRIDAY Test Build the same repository secrets are optional: `WINDOWS_SIGNING_CERTIFICATE_BASE64`, `WINDOWS_SIGNING_CERTIFICATE_PASSWORD`, and the variable `WINDOWS_SIGNING_PUBLISHER`. The password is set on the step process, not written to `GITHUB_ENV`, so a Windows PowerShell 5.1 UTF-8 BOM cannot corrupt it. The PFX file is deleted after the pipeline returns.

To enable signing, store the base64 `.pfx` and its password as those secrets, and set `WINDOWS_SIGNING_PUBLISHER` to the certificate subject the smoke should expect. A run without the secrets stays unsigned and says so.

Since 2024 an EV certificate and Azure Trusted Signing do not skip SmartScreen reputation. An unsigned build, and a newly signed build, show "unknown publisher" until download reputation builds. There is no manual SmartScreen submission for consumer endpoints. Sources are recorded in the research section below. Optional Authenticode is also described in [SECURITY.md](../SECURITY.md).

## 6. Packaging plan (2026-10-08)

The install, update, uninstall, and release rules from the packaging plan already run in this guide, `electron/update-safety.cjs`, `scripts/release-engine.cjs`, `electron/github-sync.cjs`, and `electron-builder.yml`. User data stays beside `App` under the one FRIDAY root.

| Source | Decision | Reason |
| --- | --- | --- |
| [electron-builder auto-update](https://www.electron.build/docs/features/auto-update), accessed 2026-10-08 | ADOPT | Windows update stays on NSIS. Squirrel is not the path. |
| [electron-builder NSIS](https://www.electron.build/docs/nsis), accessed 2026-10-08 | ADAPT | The installer stays the existing NSIS pack. Silent install-on-next-launch stays off. The owner still approves an update. |
| [Microsoft MSIX overview](https://learn.microsoft.com/en-us/windows/msix/overview), accessed 2026-10-08 | REJECT as primary | MSIX is not a second installer. It stays future work. |
| [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security-for-github-actions/artifact-attestations), accessed 2026-10-08 | ADAPT | A checksum mismatch already fails closed. Hosted attestations were not run. A generated SBOM was not added. |

A second root that adds an app/current tree and a versions tree was not adopted. A second release-script set and a twelfth workflow were not added. The durable update record stays `updates/pending-update.json` plus `updates/stable.json`.

## Research (2026-10-10) — one release pipeline

Checked on 2026-10-10. The Windows runner image readme that day is [Windows Server 2025](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md): image `20261004.281.1`, Python 3.12.10, Node 22.23.3. `windows-latest` is that image. This checkout's Node is whatever the cloud image installed; the floor stays `package.json` `engines.node` `>=22.19.0`.

| Idea | Source | Decision | Reason | Where |
| --- | --- | --- | --- | --- |
| One script owns the pack steps | [Signal Desktop CI](https://github.com/signalapp/Signal-Desktop/blob/main/.github/workflows/ci.yml) calls `pnpm run build:release`; [Electron release.ts](https://github.com/electron/electron/blob/bae71626/script/release/release.ts) owns publish; [VS Code product-build.yml](https://github.com/microsoft/vscode/blob/51924fa6/build/azure-pipelines/product-build.yml) is one orchestrator over platform templates | ADOPT | Three copied step lists drift. One Node entry keeps CMD, Test, and Official on the same phases. | `scripts/build-pipeline.cjs` |
| Composite action as the recipe | [Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts): a composite action cannot read `secrets` | REJECT | Signing secrets would have to be threaded as inputs, and the CMD pack could not call the action. | The recipe stays a script. Checkout, Node, and Python stay composite. |
| Reusable workflow for prepare and publish | [Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations): a called workflow can only keep or reduce `GITHUB_TOKEN`; the same concurrency group with cancel-in-progress cancels the caller | ADAPT | PR Validation and Safe Merge stay `workflow_call` from FRIDAY Release. Prepare and publish are ordinary jobs so their `contents: write` is declared on the job that needs it. Concurrency is workflow-level `friday-release`, cancel-in-progress false. | `.github/workflows/release.yml` |
| `actions/attest` provenance | [Use artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) and [actions/attest](https://github.com/actions/attest): needs `id-token: write` and `attestations: write` | REJECT | The Actions allow-list only permits actions owned by `devendrarj25`. `actions/attest` would fail at startup. | Checksums and `scripts/release-manifest.cjs` stay the provenance record. |
| Release asset ceiling | [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases): each file under 2 GiB, up to 1000 assets, no total-size limit | ADOPT | Setup and Portable must stay under `2147483648` bytes and above 70 percent of the bundled pin sum. | `installerBounds` in `scripts/build-pipeline.cjs` |
| Optional OV signing, SmartScreen | [electron-builder Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win), [electron-builder PR 10190](https://github.com/electron-userland/electron-builder/pull/10190), [SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) | ADAPT | Sign when `WIN_CSC_LINK` or `CSC_LINK` exists. Since 2024 EV and Azure Trusted Signing do not skip SmartScreen. Unsigned and newly signed builds show unknown publisher until reputation builds. | Sign hook and section 5 |
| npm cache of the lockfile, never of `release/` | [Caching dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) | ADOPT | `npm ci` retries once after `npm cache verify`. `release/` and `dist-desktop/` are deleted before the pack. Build outputs are not restored from a cache. | `prepare-environment` in the pipeline |
