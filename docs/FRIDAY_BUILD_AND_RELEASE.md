# FRIDAY — Build, Release, Version & Update Guide

**Made by:** Devendra Singh Meena (devendrarj25)
**Current shipping version: 1.1.2.2**

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
| `readiness` | `readiness-test.cjs --pack`. The VOICE stage still passes when speech synthesis exists, and its detail names the planned speaker: edge-tts hi-IN-SwaraNeural when online and privacy is off, Supertonic F2 when that model is installed, otherwise a female Indian Windows voice |
| `packaged-self-check` | On Windows, extract the staged packs, write the embed `._pth`, run the pinned get-pip, then `python -m pip --version`, the sandbox probe, `whisper-cli -h`, and the MCP launcher. The launcher passes when the output contains `initialize` or `FRIDAY is not running`. Other systems skip this phase with an explicit message |
| `installer-smoke` | Silent install, boot, kernel health, update-manifest hash, orphan check, uninstall on Windows when the target includes NSIS |

| Path | How you start it | Named difference |
| --- | --- | --- |
| Local CMD | `scripts\build-windows.cmd` / `npm run build:win` | `--channel production`. No `npm test`. No GitHub publish. |
| TEST | Actions → **FRIDAY Test Build** | `--channel test`, a TEST version stamp, optional publish of a prerelease |
| Official | Actions → **FRIDAY Release** (`stage=all` by default) | `--channel production` after the release pull request is on `main` |

`scripts/electron-pack.cjs` passes `--publish never` unless the command already names `--publish`. electron-builder 26 otherwise treats a CI run that is not a pull request as `onTagOrDraft` and stops when `GH_TOKEN` is unset (PR Validation run 38269200746, after the Setup EXE and its blockmap were written). Official assets are still uploaded by `gh release create`.

File names use the public four-part identity. The npm field stays the three-part encoding. ExtraResources copy the kernel, the capability trees, and the scripts, except the `cloud-agent-*` helpers. The `resources` extraResource omits `to`: electron-builder resolves that field relative to the app resources directory, and `to: resources` nested the staged packs at `resources/resources`. `verify-artifacts` requires `win-unpacked/resources/<dest>/<id>/pack.bin`. A report is written to `release/build-report.json`.

The first pack needs the network so `scripts/stage-toolchain.cjs` can fetch the packs named in `config/toolchain-manifest.json` and check their SHA-256. Later packs reuse `.cache/toolchain`. `--offline` and `FRIDAY_OFFLINE=1` reuse that cache and fail with `offline build: <id> is not in the staging cache` when a pack is missing. `FRIDAY_SKIP_TOOLCHAIN_STAGE` is refused: a skipped stage must not emit a small EXE. Setup and Portable must be at least 70 percent of the bundled pin sum and strictly under 2 GiB (and under the manifest budget plus 800 MiB). A missing pack or a short installer fails the build with the text `refusing a small EXE`. `packaged-self-check` is a pipeline phase. A Linux run skips it with `skipped: packaged self-check runs on Windows only`. A Windows run of that phase, the CMD pack, and installer smoke is unverified until `windows-latest` or the owner's PC runs them.

### Pack-toolchain advisories (2026-10-07)

`http-cache-semantics` is locked at 4.3.0. [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) covers `<= 4.2.0` (advisory API, 2026-10-07; `firstPatchedVersion` is empty). Registry 4.3.0 was published 2026-10-04 ([package](https://registry.npmjs.org/http-cache-semantics), [repository](https://github.com/kornelski/http-cache-semantics)). **ADAPT**: `cacheable-request` already allows `^4.0.0`, so the lock moves to 4.3.0 with no extra override. That release is outside the published range. Its `max-stale` predicate matches 4.2.0; the 4.3.0 change is `Vary: *` matching plus the cached response status ([upstream issue 56](https://github.com/kornelski/http-cache-semantics/issues/56) closed the report). `npm audit` on this machine after the move: 0 (before the move, after the pack-helper override: 1 high). The chain stays dev-only: `app-builder-lib` → `@electron/get` 3.1.0 → `got` 11.8.6 → `cacheable-request` 7.0.4. Installed for the pack, not bundled in the EXE. Unpacked size 50.4 kB.

`sprintf-js` has no release after 1.1.3 ([package](https://registry.npmjs.org/sprintf-js)). [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) covers `<= 1.1.3` and has no patched version. **REJECT** a direct bump. `global-agent` 4.0.0 still depends on `roarr`; 4.1.0 and later do not. `app-builder-lib` 26.17.0 still depends on `@electron/get` `^3.0.0`, so a newer 26.x builder does not drop the chain. **REJECT** that bump.

**ADOPT** `overrides.global-agent` `4.1.3` ([registry](https://registry.npmjs.org/global-agent), [repository](https://github.com/gajus/global-agent), 2026-10-07). It still exports `bootstrap()`, which is the only call `@electron/get` 3 makes, and it does not depend on `roarr` or `sprintf-js`. Dev-only optional pack helper. Unpacked size 87313 bytes. `npm ci` installs it, and both `electron-builder` and the nested `@electron/get` still resolve.

The local CMD wrapper is [INSTALL.md](../INSTALL.md). CMD does not run `npm test`. PR Validation, FRIDAY Test Build, and the prepare job of FRIDAY Release do.

## 🪪 Package identity

Every package kind reads `scripts/identity.cjs`. The kinds are npm (`package.json`), the NSIS Setup, the portable EXE, the unpacked app, the source zip (`FRIDAY-PACKAGE.json`), and the update manifest (`friday-update.json`). The stamp is the product name **FRIDAY**, the owner **Devendra Singh Meena**, and the GitHub username `devendrarj25`. The publisher line is `Devendra Singh Meena (devendrarj25)`. Those records do not carry an email, a phone number, or a street address.

An installed copy keeps `scripts/identity.cjs` beside the app, under `resources/scripts`. `electron-builder.yml` ships the scripts tree as an extra resource and packs only `scripts/release-engine.cjs` inside `app.asar`. `electron/dev-workflow.cjs` loads the checkout path when that file is present, then `resources/scripts/identity.cjs`. The installed main process reaches the boot self-test after that load succeeds. That check mounts the window and exits on its own clock. It does not extract Python and it does not start the kernel. A normal launch still does both. Installer smoke passes `--friday-boot-selftest` and `--friday-workspace` because a redirected GUI process can miss the inherited environment. A renderer crash during the check exits with `FRIDAY_BOOT_SELFTEST_FAIL` instead of reloading until the 240 second kill. The same process replaces `<root>\logs\boot-selftest.txt` (BEGIN, then OK or FAIL). Smoke accepts that file as well as stdout, and it deletes the file before each launch so an older OK cannot pass the next boot. A second copy exits 1 instead of quitting with code 0. The Windows installer lifecycle was not run on this Linux check.

2026-10-14. [Electron issue 4552](https://github.com/electron/electron/issues/4552): on Windows a GUI process writes stdout to a console, so `Start-Process -RedirectStandardOutput` can stay empty. ADAPT. The mount line is written to `logs/boot-selftest.txt` and copied with `fs.writeSync` when that handle is open. It does not also call `process.stdout.write`. Mixing those two on one redirected pipe filled the pipe and blocked the main thread, so the 70 second deadline never ran (PR Validation run 38587250369 wrote `BEGIN` and stayed up for 240 seconds). For that run the stdout and stderr handles are set non-blocking, and ordinary log lines stay in `logs/main.log` instead of the pipe. [app.exit](https://www.electronjs.org/docs/latest/api/app#appexitexitcode) stays the exit. `process.exit` after the app is ready does not leave immediately ([Electron issue 32060](https://github.com/electron/electron/issues/32060)), so it is not the smoke exit. A hosted re-run of this fix is unverified until the owner runs PR Validation.

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

## One pipeline (2026-10-11)

The CMD pack, `npm run build:all`, `npm run release:package`, `npm run build:portable`, FRIDAY Release, and FRIDAY Test Build call `scripts/build-pipeline.cjs`. Change a phase there and every entry point follows. Named differences are the channel file, the version stamp, the tag namespace, retention, the signing source, and whether a later job publishes.

Phases, in order: prepare-environment, verify-versions, stage-toolchain, build-renderer, package, sign-hook, manifest, verify-artifacts, verify-boot, readiness, packaged-self-check, installer-smoke.

The installer floor is 70 percent of the bundled pin sum (205084080 bytes), which is 143558856 bytes. The ceiling is under 2147483648. A missing pack or a file under that floor fails the build.

The first toolchain stage needs network. After that, the cache is `.cache/toolchain/<sha256>.bin`. `--offline` and `FRIDAY_OFFLINE=1` reuse that cache. A miss fails with `offline build: <id> is not in the staging cache` and does not fetch. The CMD wrapper forwards extra arguments, so `build-windows.cmd --offline` is the same flag.

`packaged-self-check` checks each staged pack hash and size, extracts Python, whisper.cpp, and Node with the pure-Node extractor, flattens the Node zip when it has one top folder, and copies ggml-base. The embeddable zip has no pip. The check writes `python312._pth` through `embedPthText`, copies the pinned get-pip script, runs `python.exe get-pip.py`, then `python -m pip --version`, the sandbox probe, `whisper-cli -h`, the MCP launcher, `node.exe --version`, and a 16-byte model header that must not be a zip. On a build machine the launcher reports that FRIDAY is not running, and that answer passes. Output that contains `initialize` also passes. On anything other than Windows the phase returns `skipped: packaged self-check runs on Windows only`. A missing unpack or a failed probe fails the build, and the probe output is in the error. The detail is in `release/build-report.json`. FRIDAY Release run 38275652829 stopped at `python failed (1)` before this order. A hosted re-run is unverified.

Installer smoke is `scripts/windows-installer-smoke.ps1` for both channels. The pipeline still passes `-Installer`, `-Product`, and `-ReleaseDir`. With no `-Installer`, the script looks for `release\FRIDAY-Setup-<public version>.exe` from `config/friday-version.json` and names that path if the file is missing. The sandbox is `RUNNER_TEMP` when GitHub sets it, otherwise the system temp directory. A null path is not passed to `Join-Path`. It installs silent per-user into that temp folder, boots, checks kernel health, the update-manifest sha512, orphans (kernel, whisper, browser, MCP launcher), the chosen data folder, then uninstalls, and the `finally` block removes the sandbox. It does not delete the owner's `<FRIDAY_ROOT>`. POSIX skips that phase with an explicit message. A Windows run of the script is unverified on this Linux tree.

Signing stays optional. The password is the PowerShell step environment (`CERTIFICATE_PASSWORD` copied to `CSC_KEY_PASSWORD`) and is not printed. The unsigned log says a new publisher does not by itself remove SmartScreen warnings. The 2026-10-10 signing row above is the research record.

The checkout, pinning, and linter research for this date is recorded once in [FRIDAY_GITHUB_ACTIONS.md](FRIDAY_GITHUB_ACTIONS.md). The archive-name colon rule for the remaining `localTar` callers is in that same table. It is not repeated here.

## Research (2026-10-11) — green and real

Checked on 2026-10-11 against the live pages. A Windows `electron-builder --dir` pack was not run. Hosted `windows-latest` for this tree is unverified.

| Idea | Source | Decision | Reason | Where |
| --- | --- | --- | --- | --- |
| extraResources `to` omitted | [Application contents](https://www.electron.build/docs/contents), FileSet `to` defaults to the resources directory. `app-builder-lib` `getFileMatchers` uses that default when `to` is null. The run that nested the packs is recorded in the Actions research table. | ADOPT | `to: resources` writes `resources/resources`. Omitting `to` lands `resources/<dest>/<id>/pack.bin`. | `electron-builder.yml` |
| `asarUnpack` for the staged packs | Same contents page: `asar.unpack` extracts files that were packed into the asar. extraResources are already outside the asar. | REJECT | An unpack pattern does not copy extraResources and does not fix a nested `to`. | no asar pattern for `pack.bin` |
| NSIS and portable resources path | Same contents page: on Windows, extraResources copy into `resources/`. The app reads `process.resourcesPath`, and a portable directory is `resources` under that folder. The nested `resources/resources` tree remains a fallback for an older pack. | ADOPT | One layout module is the path for stage, verify, and first run. A Windows pack of this tree was not run. | `electron/runtime-layout.cjs` |
| Expand-Archive or GNU tar as the updater extract | [Expand-Archive](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.archive/expand-archive) extracts a zip. A `.tar` is not that format. The colon archive rule for the remaining tar callers stays in the Actions research table. | REJECT for the updater | The plugin update is a tar. PowerShell returned a failure and the assertion did not print it. The updater now extracts with the pure-Node reader only. | `electron/updater.cjs`, `electron/archive-safe.cjs` |
| Zip-slip and reserved names | [electron-builder PR 9891](https://github.com/electron-userland/electron-builder/pull/9891) `isSafeExtractPath`. Entries are normalized, then absolute paths, drive letters, `..`, NUL, and Windows reserved names are refused. | ADOPT | A plugin or toolchain archive must not write outside the destination. Methods other than store and deflate are refused. The chat-document extractor keeps its own 2 MB cap. | `electron/archive-safe.cjs` |
| Retry a directory replace on EPERM or EBUSY | [fs.rmSync](https://nodejs.org/api/fs.html#fsrmsyncpath-options) retries EBUSY, EMFILE, ENFILE, ENOTEMPTY, and EPERM. The same PR 9891 `moveDirAtomic` retries a rename, then copies. | ADOPT | Windows reports EPERM or EBUSY while a scanner holds the folder. POSIX EPERM is not retried. The backup is copied back and is not consumed. | `replaceDirectory` in `electron/archive-safe.cjs` |
| Embeddable `python312._pth` | [sys.path init](https://docs.python.org/3/library/sys_path_init.html) and [Windows embeddable package](https://docs.python.org/3/using/windows.html): a `._pth` file ignores the registry and the environment, and `site` is imported only when a line says `import site`. | ADOPT | The extracted embed writes `python312.zip`, `.`, `Lib\site-packages`, and `import site`. | `embedPthText` in `electron/toolchain-pack.cjs` |
| get-pip inside the embed | The same Windows page: the embeddable zip omits pip, and pip-managed dependencies are not the supported embedder path. [Installing packages](https://packaging.python.org/en/latest/tutorials/installing-packages/) still documents `python get-pip.py`. | ADAPT | The voice and sandbox probes need pip. The pinned script is hashed, copied into the private runtime, run once, then checked with `python -m pip --version`. The system Python is not changed. | `electron/bundled-runtime.cjs` |
| Do not wrap the embed in a venv | The same Windows page: the embed is a minimal private interpreter, not a general install. `python -m venv` needs the pieces that zip leaves out. | ADAPT | An existing managed venv and `FRIDAY_PYTHON` still win. The embed is returned as `runtime/python/python.exe`. A bare `py` still gets a venv. Winget stays after the pack. | `electron/python.cjs`, `ensureManagedPython` |
| Flatten the Node zip | [Node 22 downloads](https://nodejs.org/en/download/archive/v22.22.2) publish `node-v*-win-x64.zip`. The catalog entry is `node-v22.23.3-win-x64/node.exe`. The zip was not opened this session. | ADOPT | One top folder is flattened so the runtime file is `node/node.exe`. The MCP launcher uses that file when it is present, and Electron otherwise. | `electron/runtime-layout.cjs`, `electron/mcp-paths.cjs` |
| whisper.cpp entry | [whisper.cpp v1.9.2](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2) lists `whisper-bin-x64.zip` at 7.8 MB. That page does not list the files inside the zip. The catalog entry remains `Release/whisper-cli.exe`. | ADOPT the existing pin | First run looks for that relative path and also keeps `Release/whisper-server.exe` when the zip has it. A missing entry fails closed. The zip was not opened this session. | `electron/runtime-layout.cjs` |
| ggml-base is a file, not a zip | The catalog pin is one file, `ggml-base.bin`. | ADOPT | First run copies it. A 16-byte header that starts with a zip signature is not a model. | `electron/bundled-runtime.cjs` |
| Doctor Ready only after a run | The same first-run module records the hash, the source, and the time of the prove command. | ADOPT | A file on disk with no successful run stays Warning. Repair extracts again from the installed pack. | `electron/diagnostics.cjs` |

## Research (2026-10-13) — local Windows pack log

Checked on 2026-10-13. This Linux tree did not run `npm run build:win`, the installer, or a speech download.

| Idea | Source | Decision | Reason | Where |
| --- | --- | --- | --- | --- |
| Top-level `allowScripts` | [npm approve-scripts](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/) (npm 11). Install scripts still run; unreviewed packages are only a warning. npm 12 blocks unapproved scripts ([install scripts](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/)). | ADOPT | `electron: true` and `electron-winstaller: false`. The nested `npm.allowScripts` key was not the field npm reads, so the Squirrel helper stayed "not covered". | `package.json` |
| Deny `electron-winstaller` install | That package's `install` script is `script/select-7z-arch.js`, which copies `vendor/7z.exe` for Squirrel.Windows. | ADOPT deny | FRIDAY packs NSIS and Portable. electron-builder 26 edits resources with `resedit`, not that 7-Zip copy. | `package.json` `allowScripts` |
| Electron binary after `npm ci` | [Electron 42](https://electronjs.org/blog/electron-42-0) removed the `postinstall` download. [Installation](https://electronjs.org/docs/latest/tutorial/installation) says the binary arrives on first launch or via `install-electron`. electron 43.7.7 in this tree has no `scripts` block. | ADAPT | Allowing `electron` does not download the binary. `scripts/ensure-electron.cjs` is the normal install, not a repair of a blocked script. `.npmrc` stays `ignore-scripts=false`. | `scripts/ensure-electron.cjs` |
| electron-builder 26 resource edit | [Windows options](https://www.electron.build/docs/win/) `signExecutable: false` keeps `resedit`. [26.11.0](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.11.0) moved the builder off `rcedit.exe`. | ADOPT the current yml | Signing stays off. `scripts/brand-windows.cjs` still calls the `rcedit` package. No signing change. | `electron-builder.yml` |
| Leave sourcemaps out of the asar | Vite `sourcemap: true` writes external `.map` files. `electron/renderer.cjs` serves `.map` only when the file exists. | ADOPT the filter | The packaged window does not need the maps to boot. They stay in a local `dist-desktop` for debugging. Saved bytes are unverified until a Windows pack. | `electron-builder.yml` `!dist-desktop/**/*.map` |
| PowerShell 7.6 null path | [Test-Path](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/test-path?view=powershell-7.6) returns `ParameterBindingValidationException` when Path is null. The same binding applies to `Join-Path`. | ADOPT | `$env:RUNNER_TEMP` is unset on a PC. The smoke script uses it only when it is non-blank, otherwise `[IO.Path]::GetTempPath()`. | `scripts/windows-installer-smoke.ps1` |
| Windows 11 build 26300 installer / UAC | [Build 26300.8068](https://blogs.windows.com/windows-insider/2026/03/13/announcing-windows-11-insider-preview-build-26300-8068-dev-channel/) adds a UAC prompt for point-in-time restore settings. [electron-builder 9644](https://github.com/electron-userland/electron-builder/issues/9644) is silent per-machine NSIS, which this pack does not select. | REJECT a pack change | Per-user Setup, `asInvoker`, and unsigned output stay. SmartScreen can still warn. | no yml change |
| Raise toolchain floors | [Node download](https://nodejs.org/en/download): 24.21.0 Active LTS, 22.23.3 Maintenance LTS, 26.11.1 Current. [Node release schedule](https://github.com/nodejs/release): 22 is supported through 2027-04-30. [Python 3.14.8](https://blog.python.org/2026/10/python-31022-31117/) and 3.12.15. [PowerShell 7.6.6](https://github.com/PowerShell/PowerShell/releases/tag/v7.6.6) (2026-09-08); 7.5.11 is still shipped. | REJECT | Floors stay `>=`. The owner's 26.5.1 / 11.17.0 / 3.14.7 / 7.6.6 are above the floors. Raising them would drop a still-supported 22 / 3.12 / 7.5 machine. | `config/toolchain-versions.json` unchanged |
| Pin exact versions in a constraints file | Same floor design: newer versions are reused. | REJECT as a change | A pin file would fight that rule. The known-good line below is the comparison record. | this section |

### Known-good versions from the owner's pack (2026-10-13)

Windows 10.0.26300. Node 26.5.1, npm 11.17.0, Python 3.14.7, PowerShell 7.6.6, Git 2.55.0, electron-builder 26.15.3, Electron 43.7.7, vite 8.3.2. Setup and Portable were produced; the log then failed in installer smoke. These are a comparison point, not new floors. `npm run setup` prints the resolved node, npm, Python, Git, and pwsh. `scripts/check-engines.cjs` prints the resolved node and npm before `npm ci`.

### Waiting on a parent release

`vite-tsconfig-paths` 6.1.1 is the latest 6.x and depends on `tsconfck` `^3.0.3`. `tsconfck` 3.1.6 is the latest and is marked unmaintained. No override. `rcedit` 5.0.2 is the latest and is marked unsupported. `scripts/brand-windows.cjs` still imports it. No override and no package switch in this change.

### Renderer chunk and duplicate packages

`vite.electron.config.ts` already sets TanStack `autoCodeSplitting`. The AppShell chunk warning stays visible. `chunkSizeWarningLimit` was not raised. Splitting `src/components/friday/AppShell.tsx` further would touch the shell. The lockfile has nested copies of toolchain packages (for example `fs-extra` and `semver` under the builder). Those were not removed. A packed asar was not opened here, so a second shipped copy is unverified.
