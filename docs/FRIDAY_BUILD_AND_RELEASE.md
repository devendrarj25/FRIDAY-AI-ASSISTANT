# FRIDAY — Build, Release, Version & Update Guide

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

**Made by:** Devendra Singh Meena (devendrarj25)
**Current shipping version: 1.1.3.4**

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
| `packaged-requires` | Lists `app.asar` and fails if any relative require in `electron/` points outside that archive |
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

The desktop Vite build writes `src/routeTree.gen.ts` with the same Start footer as the web plugin (`scripts/route-tree-footer.cjs`, `routeTreeFileFooter`). A desktop build leaves that committed file unchanged.

`scripts/electron-pack.cjs` passes `--publish never` unless the command already names `--publish`. electron-builder 26 otherwise treats a CI run that is not a pull request as `onTagOrDraft` and stops when `GH_TOKEN` is unset. Official assets are still uploaded by `gh release create`.

File names use the public four-part identity. The npm field stays the three-part encoding. ExtraResources copy the kernel, the capability trees, and the scripts, except the cloud-environment helper scripts. The `resources` extraResource omits `to`: electron-builder resolves that field relative to the app resources directory, and `to: resources` nested the staged packs at `resources/resources`. `verify-artifacts` requires `win-unpacked/resources/<dest>/<id>/pack.bin`. A report is written to `release/build-report.json`.

The first pack needs the network so `scripts/stage-toolchain.cjs` can fetch the packs named in `config/toolchain-manifest.json` and check their SHA-256. Later packs reuse `.cache/toolchain`. `--offline` and `FRIDAY_OFFLINE=1` reuse that cache and fail with `offline build: <id> is not in the staging cache` when a pack is missing. `FRIDAY_SKIP_TOOLCHAIN_STAGE` is refused: a skipped stage must not emit a small EXE. Setup and Portable must be at least 70 percent of the bundled pin sum and strictly under 2 GiB (and under the manifest budget plus 800 MiB). A missing pack or a short installer fails the build with the text `refusing a small EXE`. `packaged-self-check` is a pipeline phase. A Linux run skips it with `skipped: packaged self-check runs on Windows only`. A Windows run of that phase, the CMD pack, and installer smoke is unverified until `windows-latest` or the owner's PC runs them.

## 🪪 Package identity

Every package kind reads `scripts/identity.cjs`. The kinds are npm (`package.json`), the NSIS Setup, the portable EXE, the unpacked app, the source zip (`FRIDAY-PACKAGE.json`), and the update manifest (`friday-update.json`). The stamp is the product name **FRIDAY**, the owner **Devendra Singh Meena**, and the GitHub username `devendrarj25`. The publisher line is `Devendra Singh Meena (devendrarj25)`. Those records do not carry an email, a phone number, or a street address.

An installed copy keeps `scripts/identity.cjs` beside the app, under `resources/scripts`. `electron-builder.yml` ships the scripts tree as an extra resource and packs only `scripts/release-engine.cjs` inside `app.asar`. `electron/dev-workflow.cjs` loads the checkout path when that file is present, then `resources/scripts/identity.cjs`. The installed main process reaches the boot self-test after that load succeeds. That check mounts the window and exits on its own clock. It does not extract Python and it does not start the kernel. A normal launch still does both. Installer smoke passes `--friday-boot-selftest` and `--friday-workspace` because a redirected GUI process can miss the inherited environment. A renderer crash during the check exits with `FRIDAY_BOOT_SELFTEST_FAIL` instead of reloading until the 240 second kill. The same process replaces `<root>\logs\boot-selftest.txt` (BEGIN, then OK or FAIL). Smoke accepts that file as well as stdout, and it deletes the file before each launch so an older OK cannot pass the next boot. A normal second launch still quits. The boot self-test does not take the single-instance lock.

### Boot self-test and readiness (packaged app)

Both checks launch the packed EXE with the software compositor, on their own clock, and report through files, never a redirected stdout (a Windows GUI process does not deliver stdout to a redirected pipe).

- **Boot self-test** (`--friday-boot-selftest`, `--friday-workspace`): `electron/main.cjs` returns into `electron/boot-selftest.cjs` before the workspace, kernel, and Python requires. That file registers the `friday://` scheme, answers `workspace:get` with the sandbox folder, mounts the real renderer, and exits. It replaces `<root>\logs\boot-selftest.txt` (BEGIN, then OK or FAIL), does not take the single-instance lock, and never extracts Python or starts the kernel. A renderer crash exits with `FRIDAY_BOOT_SELFTEST_FAIL`. Smoke deletes the file before each launch so an old OK cannot pass; a normal second launch still quits. `scripts/verify-boot.cjs` and installer smoke read the same file.
- **Readiness** (`--friday-readiness`, `--friday-workspace`, `--friday-python`, `--friday-progress`): stages START, ROOT, BOOT, KERNEL, DATABASE, MODEL, CHAT, VOICE, BASIC TASK, then SHUTDOWN and RESTART. It writes `logs/readiness-progress.jsonl` (timestamp, milestone, milliseconds) and `logs/readiness-result.json`. A per-milestone watchdog writes the result and exits; the ceiling is 5 minutes while milestones advance, and 30 seconds when a `load:` milestone stops or the process exits. No stdout sink, no tray, catalogue, plugin, or provider probe, no registry or `py` scan, and no bundled-runtime extract. A first launch with no report marks SHUTDOWN and RESTART `not evaluated` and does not start a second wait. Each subsystem require writes `load:<module>` first, so a hang names the module.
- **Startup rules that keep `ready` reachable:** no `app.getPath("userData")` during module load (applied in the ready handler; voiceprint path, sandbox restart file, and bootstrap settings wait for `app.isReady()`); `safeStorage`, `desktopCapturer`, `Tray`, and `nativeImage` are read through `electron/lazy-electron.cjs` only after ready; JSON under `config/` resolves through `electron/resource-paths.cjs` (packaged resources, checkout, asar, `execPath/resources`, and a directory above an extracted `app.asar.unpacked/electron`), cached, with a Doctor warning and a fail-closed fallback when missing. The `uncaughtException` handler registers before those requires. There is no second copy of `config/` inside `app.asar`. `scripts/packaged-requires.cjs` lists the built asar before readiness, and a require that throws writes `load-failed:<name>`.
- **Exit order:** `electron/app-lifecycle.cjs` awaits cleanup and then calls `app.exit` once (never quit then exit in one turn). Sidebar, tray, window close, the approved `app_restart` and `app_shutdown` tools, the installer handoff, window-all-closed, session end, and readiness use it. `/health` carries `instance_id` from `FRIDAY_INSTANCE_ID`, and a launch accepts only the kernel it spawned. `scripts/packaged-launch.cjs` is the one harness that kills the process the boot or readiness parent spawned and checks the pid afterwards.
- **Local reproduction** (from the checkout, after `npm run setup` and a packed `release\win-unpacked\FRIDAY.exe`):

```bat
rmdir /s /q %TEMP%\friday-readiness-clean
node scripts\readiness-test.cjs --pack --no-repair --root %TEMP%\friday-readiness-clean --app release\win-unpacked\FRIDAY.exe
```

A hang prints `hung after <milestone>`; the reports are `debug\reports\readiness-*.json` and `%TEMP%\friday-readiness-clean\logs\readiness-progress.jsonl`. Shutdown from the sidebar does not change start-at-login. A normal double-click keeps the GPU.

`auditPackageIdentity` checks the stamp for all six package kinds, and the identity test runs it on every machine. On Windows, `scripts\build-windows.cmd` reaches the same publisher through `scripts/verify-build.cjs` (product name, company name, file version from the EXE resources). A check on Linux does not replace that Windows resource read.

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

Unsigned is the honest default (`signExecutable: false`). The pipeline signs only when `CSC_LINK`, `WIN_CSC_LINK`, or `FRIDAY_PFX` is set, and it does not print the password. On FRIDAY Release and FRIDAY Test Build the same repository secrets are optional: `WINDOWS_SIGNING_CERTIFICATE_BASE64`, `WINDOWS_SIGNING_CERTIFICATE_PASSWORD`, and the variable `WINDOWS_SIGNING_PUBLISHER`. The password is the PowerShell step environment (`CERTIFICATE_PASSWORD` copied to `CSC_KEY_PASSWORD`), not written to `GITHUB_ENV`, so a Windows PowerShell 5.1 UTF-8 BOM cannot corrupt it. The PFX file is deleted after the pipeline returns.

To enable signing, store the base64 `.pfx` and its password as those secrets, and set `WINDOWS_SIGNING_PUBLISHER` to the certificate subject the smoke should expect. A run without the secrets stays unsigned and says so.

Since 2024 an EV certificate and Azure Trusted Signing do not skip SmartScreen reputation. An unsigned build, and a newly signed build, show "unknown publisher" until download reputation builds. There is no manual SmartScreen submission for consumer endpoints. Optional Authenticode is also described in [SECURITY.md](../SECURITY.md).

## 6. Pipeline details

The CMD pack, `npm run build:all`, `npm run release:package`, `npm run build:portable`, FRIDAY Release, and FRIDAY Test Build call `scripts/build-pipeline.cjs`. Change a phase there and every entry point follows. Named differences are the channel file, the version stamp, the tag namespace, retention, the signing source, and whether a later job publishes. `scripts/build-windows.cmd` is `node scripts\build-pipeline.cjs --channel production --caller cmd` and returns that process's exit code. FRIDAY Release and FRIDAY Test Build pass `--channel` and `--caller`, then `--through verify-versions` and `--from stage-toolchain`. They do not list the phases themselves.

Phases, in order: prepare-environment, verify-versions, stage-toolchain, build-renderer, package, packaged-requires, sign-hook, manifest, verify-artifacts, verify-boot, readiness, packaged-self-check, installer-smoke.

The installer floor is 70 percent of the bundled pin sum (205088081 bytes), which is 143561656 bytes. The ceiling is under 2147483648. A missing pack or a file under that floor fails the build. The pinned get-pip script (https://bootstrap.pypa.io/get-pip.py, 2234489 bytes, SHA-256 `f4448a01e3ab2914c65f4ca59d4cacba6b2dbde19a483fbac46587f8bbaff424`) is hash-checked before it runs.

The first toolchain stage needs network. After that, the cache is `.cache/toolchain/<sha256>.bin`. `--offline` and `FRIDAY_OFFLINE=1` reuse that cache. A miss fails with `offline build: <id> is not in the staging cache` and does not fetch. The CMD wrapper forwards extra arguments, so `build-windows.cmd --offline` is the same flag.

`packaged-self-check` checks each staged pack hash and size, extracts Python, whisper.cpp, and Node with the pure-Node extractor, flattens the Node zip when it has one top folder, and copies ggml-base. The embeddable zip has no pip. The check writes `python312._pth` through `embedPthText`, copies the pinned get-pip script, runs `python.exe get-pip.py`, then `python -m pip --version`, the sandbox probe, `whisper-cli -h`, the MCP launcher, `node.exe --version`, and a 16-byte model header that must not be a zip. On a build machine the launcher reports that FRIDAY is not running, and that answer passes. Output that contains `initialize` also passes. On anything other than Windows the phase returns `skipped: packaged self-check runs on Windows only`. A missing unpack or a failed probe fails the build, and the probe output is in the error. The detail is in `release/build-report.json`.

Installer smoke is `scripts/windows-installer-smoke.ps1` for both channels. The pipeline still passes `-Installer`, `-Product`, and `-ReleaseDir`. With no `-Installer`, the script looks for `release\FRIDAY-Setup-<public version>.exe` from `config/friday-version.json` and names that path if the file is missing. The sandbox is `RUNNER_TEMP` when GitHub sets it, otherwise the system temp directory. A null path is not passed to `Join-Path`. It installs silent per-user into that temp folder, boots, checks kernel health, the update-manifest sha512, orphans (kernel, whisper, browser, MCP launcher), the chosen data folder, then uninstalls, and the `finally` block removes the sandbox. It does not delete the owner's `<FRIDAY_ROOT>`. POSIX skips that phase with an explicit message.


## 7. Models fetched during setup

On Windows, `npm run setup` (`scripts/setup-python.cjs`) runs `scripts/prefetch-models.cjs` after the voice packages import. It fetches faster-whisper base and small (Systran), the pinned Smart Turn and Silero VAD ONNX files, and the Qwen2.5 1.5B Instruct GGUF from Qwen's own repository into the selected FRIDAY folder (`cache/stt/<size>` and `models/`). It goes through `electron/model-download.cjs`, the same downloader the app uses: allowlisted hosts, resumable parts, and a SHA-256 check against the pinned digest or the Hugging Face listing read with `blobs=true`. The opt-in mirror stays behind `FRIDAY_HF_MIRROR=1`. A file already on disk is skipped. A failed or offline fetch prints `not prefetched ... FRIDAY fetches it on first use` and never fails setup. `FRIDAY_PREFETCH=0` skips all of it and `FRIDAY_PREFETCH_CHAT=0` skips the chat model; hosted CI skips it unless `FRIDAY_PREFETCH=1`. The load probe then opens the downloaded small (or base) folder, and `scripts/verify-deps.cjs` checks the venv setup built. Nothing is added to the installer or the EXE. Supertonic stays on demand because no digest is pinned for it.

Setup and the scripts resolve the FRIDAY folder in the app's order: `FRIDAY_WORKSPACE_ROOT`, then the registry, then the settings pointer. A folder left by `windows-installer-smoke.ps1` or `readiness-test.cjs` (a `friday-installer-smoke-<32 hex>` or `friday-readiness-<6>` folder under a temp directory) is never adopted, by the scripts or by the app. The smoke restores the owner's `friday-settings.json` pointer files when it ends. Readiness hands the packaged EXE the interpreter setup built (`resolveVenvPython()`).

**Toolchain packs.** `scripts/stage-toolchain.cjs` tries each pack's primary URL and then its pinned `mirrors` (python.org then Huawei Cloud and npmmirror for Python and Node; hf-mirror.com only with `FRIDAY_HF_MIRROR=1`). Every candidate must match the pinned SHA-256 and size, so a mirror is only another road to the same bytes; a failed or wrong source logs `trying the next source`. Downloads use the app downloader (`electron/model-download.cjs` `downloadUrl`: range segments, resume inside the run, retries) and print a progress bar with speed and ETA (a redrawn bar on a terminal, a line every 10 percent in a log). Mirror URLs were not reachable from the Linux container that wrote them, so they are unverified until a Windows build uses them.

**Ollama and the lite chat models (Windows, `npm run setup` / `build:win`).** After the speech and voice weights, setup downloads the pinned `OllamaSetup.exe` (SHA-256 from `config/local-runners.json`) to `<root>\runtime\installers\ollama`, requires a valid Authenticode signature, runs it per user with the standard Inno Setup silent switches (`/VERYSILENT /NORESTART /SUPPRESSMSGBOXES`, no administrator), starts `ollama serve`, and pulls `qwen2.5:1.5b` (fast replies and voice turns) and `qwen2.5:3b` (smarter chat). The Qwen GGUF is also kept under `<root>\models`. Ollama keeps its own models folder; FRIDAY starts and stops the daemon through `electron/startup.cjs`. Opt-outs: `FRIDAY_PREFETCH_OLLAMA=0` (skip Ollama), `FRIDAY_AUTO_INSTALL=0` (download only, never run the installer), `FRIDAY_PREFETCH=0`. Hosted CI skips all of it. A failed step prints `INFO` and the app fetches the piece on first use or from Install Manager. This path ran only against stand-ins; a real install on Windows is unverified.

## 8. Python series for the build environment

The floor is `>=3.12.10`. Setup and the installer helper prefer the newest installed series at or below `pythonWheelProven` (3.14), and take a newer series as soon as a pip dry run of `kernel/requirements.txt` with `--only-binary=:all:` passes on it, so a new series is picked up without a config change. When only an unproven newer series is installed, Windows setup first installs the newest proven series from python.org and uses the newer one only if that install fails. The installer helper still uses a newer series when it is the only Python. `FRIDAY_PYTHON` and an existing venv are never second-guessed. The python.org installer list stays inside the proven series and skips a series folder that holds only pre-releases. Code: `scripts/python-runtime.cjs`, `installer/build/install-python.ps1`, `config/toolchain-versions.json`.

## 9. Toolchain reference

Floors stay `>=` in `config/toolchain-versions.json` so a still-supported Node 22, Python 3.12, or PowerShell 7.5 machine works. `npm run setup` prints the resolved node, npm, Python, Git, and pwsh, and `scripts/check-engines.cjs` prints the resolved node and npm before `npm ci`. Reference versions from the owner's Windows PC, for comparison only: Node 26.5.1, npm 11.17.0, Python 3.14.7, Git 2.55.0, PowerShell 7.6.7, Electron 43.7.7, electron-builder 26.15.3, vite 8.3.2, FastAPI 0.143.3, uvicorn 0.54.0, pydantic 2.14.1, edge-tts 7.3.1, faster-whisper 1.2.1, Pillow 13.0.0, chromadb 1.5.9, onnxruntime 1.31.0.

`package.json` sets top-level `allowScripts` (`electron: true`, `electron-winstaller: false`) and `overrides.global-agent` `4.1.3`. `scripts/ensure-electron.cjs` installs the Electron binary (the package no longer downloads it on install); `.npmrc` keeps `ignore-scripts=false`. `vite-tsconfig-paths` depends on an unmaintained `tsconfck`, and `rcedit` (used by `scripts/brand-windows.cjs`) is marked unsupported; neither has a drop-in replacement yet. Both Vite configs set `chunkSizeWarningLimit` to `8192` and turn off `checks.bundlerTimings` and `checks.moduleLevelDirective` (reporting only; the build exit code is unchanged). `src/components/friday/AppShell.tsx` is not split.

## 10. Research decisions

ADOPT means built as described, ADAPT means built in reduced form on the existing path, REJECT means deliberately not built.

| Topic | Source | Decision | Reason | Where |
| --- | --- | --- | --- | --- |
| One script owns the pack steps | [Signal Desktop CI](https://github.com/signalapp/Signal-Desktop/blob/main/.github/workflows/ci.yml), [Electron release.ts](https://github.com/electron/electron/blob/bae71626/script/release/release.ts), [VS Code product-build](https://github.com/microsoft/vscode/blob/51924fa6/build/azure-pipelines/product-build.yml) | ADOPT | Three copied step lists drift; CMD, Test, and Official share phases. | `scripts/build-pipeline.cjs` |
| Composite action as the recipe | [Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts) | REJECT | A composite action cannot read `secrets`, and the CMD pack could not call it. | recipe stays a script |
| Reusable workflow for prepare and publish | [Reusing workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations) | ADAPT | PR Validation and Safe Merge stay `workflow_call`; prepare and publish are ordinary jobs; concurrency `friday-release`, no cancel. | `.github/workflows/release.yml` |
| `actions/attest` provenance; hosted attestations; SBOM | [Artifact attestations](https://docs.github.com/en/actions/concepts/security-for-github-actions/artifact-attestations) | REJECT | The Actions allow-list permits only actions owned by `devendrarj25`; checksums stay the provenance record. | `scripts/release-manifest.cjs` |
| Release asset ceiling | [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) | ADOPT | Each asset under 2 GiB; floor 70 percent of the bundled pin sum. | `installerBounds` |
| Optional OV signing; SmartScreen | [electron-builder signing](https://www.electron.build/docs/features/code-signing/code-signing-win), [SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) | ADAPT | Sign only when a certificate exists; EV and Azure Trusted Signing do not skip SmartScreen. | sign hook |
| npm cache of the lockfile, never `release/` | [Dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) | ADOPT | `npm ci` retries once after `npm cache verify`; outputs are deleted before the pack. | `prepare-environment` |
| NSIS updates; silent install-on-next-launch | [auto-update](https://www.electron.build/docs/features/auto-update), [NSIS](https://www.electron.build/docs/nsis) | ADOPT / ADAPT | Windows update stays on NSIS; the owner still approves an update. | `electron/update-safety.cjs` |
| MSIX as primary installer; a second app/current plus versions tree; a second release-script set | [MSIX overview](https://learn.microsoft.com/en-us/windows/msix/overview) | REJECT | Not a second installer or root. The update record stays `updates/pending-update.json` plus `updates/stable.json`. | none |
| `extraResources` with `to` omitted; no `asarUnpack` for packs | [Application contents](https://www.electron.build/docs/contents) | ADOPT / REJECT | `to: resources` nests `resources/resources`; omitting it lands `resources/<dest>/<id>/pack.bin`. | `electron-builder.yml`, `electron/runtime-layout.cjs` |
| Pure-Node archive extraction with zip-slip checks | [electron-builder PR 9891](https://github.com/electron-userland/electron-builder/pull/9891) | ADOPT | Absolute paths, drive letters, `..`, NUL, and reserved names are refused; Expand-Archive is not used for tar. | `electron/archive-safe.cjs` |
| Retry directory replace on EPERM / EBUSY | [fs.rmSync](https://nodejs.org/api/fs.html#fsrmsyncpath-options) | ADOPT | A scanner can hold a folder on Windows; the backup is copied back, not consumed. | `replaceDirectory` |
| Embeddable `python312._pth`; get-pip; no venv wrapper | [sys.path init](https://docs.python.org/3/library/sys_path_init.html), [Windows embeddable](https://docs.python.org/3/using/windows.html) | ADOPT / ADAPT | The pth names `python312.zip`, `.`, `Lib\site-packages`, `import site`; pinned get-pip runs once; an existing venv or `FRIDAY_PYTHON` still wins. | `embedPthText`, `electron/bundled-runtime.cjs`, `electron/python.cjs` |
| Flatten the Node zip; whisper.cpp entry; ggml-base as a file | [Node 22 downloads](https://nodejs.org/en/download/archive/v22.22.2), [whisper.cpp v1.9.2](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2) | ADOPT | One top folder is flattened; a missing entry fails closed; a zip header is not a model. | `electron/runtime-layout.cjs` |
| Doctor Ready only after a successful run | First-run proof record | ADOPT | A file on disk with no successful run stays Warning. | `electron/diagnostics.cjs` |
| Deny `electron-winstaller` install scripts | [npm approve-scripts](https://docs.npmjs.com/cli/v11/commands/npm-approve-scripts/) | ADOPT | FRIDAY packs NSIS and Portable, not Squirrel. | `package.json` |
| Source maps out of the asar | Vite `sourcemap` | ADOPT | The window boots without them. | `electron-builder.yml` |
| PowerShell null path | [Test-Path](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/test-path?view=powershell-7.6) | ADOPT | Smoke uses `RUNNER_TEMP` only when non-blank. | `scripts/windows-installer-smoke.ps1` |
| Per-machine silent NSIS / UAC change | [electron-builder 9644](https://github.com/electron-userland/electron-builder/issues/9644) | REJECT | Per-user Setup, `asInvoker`, unsigned output stay. | none |
| Raise toolchain floors or pin exact versions | [Node download](https://nodejs.org/en/download), [Node release schedule](https://github.com/nodejs/release) | REJECT | Would drop still-supported machines; floors stay `>=`. | `config/toolchain-versions.json` |
| Cap Python with a maximum | PyPI wheel files for `ctranslate2` | REJECT | Would refuse a newer Python that is the only one installed. | none |
| Boot probe without stdout; exit through `app.exit` | [Electron issue 4552](https://github.com/electron/electron/issues/4552), [app.exit](https://www.electronjs.org/docs/latest/api/app#appexitexitcode), [app.whenReady](https://www.electronjs.org/docs/latest/api/app) | ADOPT | A Windows GUI process does not deliver stdout to a redirected pipe; `app.quit` can be aborted by `before-quit`. | `electron/boot-selftest.cjs`, `electron/app-lifecycle.cjs` |
| Single-instance lock in probes | [Electron issue 33736](https://github.com/electron/electron/issues/33736) | ADOPT skip | The lock can wait on a named pipe on a runner; smoke stops install-folder processes first. | boot and readiness paths |
| Lazy `safeStorage` and `userData` | [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) | ADOPT | Both wait on `ready`, which waits on the main file returning. | `electron/lazy-electron.cjs` |
| Packaged resource lookup | [extraResources](https://www.electron.build/docs/contents), [process.resourcesPath](https://www.electronjs.org/docs/latest/api/process#processresourcespath-readonly) | ADOPT | `config/` sits beside `app.asar`, not inside it. | `electron/resource-paths.cjs` |
| Mirror fallback for pinned packs | Python and Node mirror indexes | ADOPT | A pinned hash makes any mirror safe; the primary is always tried first. | `scripts/stage-toolchain.cjs` |
| Ollama installed during setup | [Ollama Windows](https://docs.ollama.com/windows) | ADAPT | Pinned digest, valid Authenticode, per-user, no administrator, never fails the build. The earlier rejection of unverified silent switches is replaced by the standard Inno Setup switches. | `scripts/prefetch-models.cjs` |
| Pack-toolchain advisories | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp), [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) | ADAPT / ADOPT / REJECT | `http-cache-semantics` locked at 4.3.0; `overrides.global-agent` 4.1.3 drops `roarr` and `sprintf-js`; a direct `sprintf-js` bump and an `app-builder-lib` bump do not help. | `package.json`, lockfile |
| `chunkSizeWarningLimit` finite; `bundlerTimings` and `moduleLevelDirective` off | [Vite build options](https://vite.dev/config/build-options), [rolldown checks](https://rolldown.rs/reference/InputOptions.checks) | ADOPT | Reporting only; `Infinity` parsed as 0 in an older reporter. | `vite.electron.config.ts` |
