# FRIDAY — Build, Release, Version & Update Guide

**Made by:** Devendra Singh Meena (devendrarj25)
**Current shipping version: 1.0.1.2**

📦 This is the packaging document. It tells you how a Windows pack is made, how a TEST pack stays beside the Official app, and how an installed copy chooses Stable or Test. Click-by-click publish is [RELEASE.md](../RELEASE.md). The counters are [VERSIONING.md](../VERSIONING.md). Each workflow file is [FRIDAY_GITHUB_ACTIONS.md](FRIDAY_GITHUB_ACTIONS.md). Disk rules are [FRIDAY_STORAGE_CONTRACT.md](FRIDAY_STORAGE_CONTRACT.md). This file is the documentation contract for packaging behaviour.

## 1. Three pack paths

| Path | How you start it | What you get |
| --- | --- | --- |
| Local CMD | `scripts\build-windows.cmd` / `npm run build:win` | `release\FRIDAY-Setup-1.0.1.2.exe`, `FRIDAY-Portable-1.0.1.2.exe`, `win-unpacked\` |
| TEST | Actions → Test EXE Build | `FRIDAY-Test-Setup-<ver>.exe` as a prerelease |
| Official | Actions → Release / Build `publish` | Setup, Portable, `friday-update.json`, `SHA256SUMS.txt`, and `latest.yml` |

All three call `scripts/electron-pack.cjs` with `electron-builder.yml`. File names use the public four-part identity. The npm field stays the three-part encoding. ExtraResources copy the kernel, the capability trees, and the scripts, except the `cloud-agent-*` helpers.

The local CMD step list is [INSTALL.md](../INSTALL.md). CMD does not run `npm test`. PR Validation, Test EXE Build, and Official Publish do.

## 🪪 Package identity

Every package kind reads `scripts/identity.cjs`. The kinds are npm (`package.json`), the NSIS Setup, the portable EXE, the unpacked app, the source zip (`FRIDAY-PACKAGE.json`), and the update manifest (`friday-update.json`). The stamp is the product name **FRIDAY**, the owner **Devendra Singh Meena**, and the GitHub username `devendrarj25`. The publisher line is `Devendra Singh Meena (devendrarj25)`. Those records do not carry an email, a phone number, or a street address.

`auditPackageIdentity` checks that stamp for all six kinds. The identity test runs it on every machine. On Windows, `scripts\build-windows.cmd` reaches the same publisher through `scripts/verify-build.cjs` when it reads the EXE resources (product name, company name, file version). A check on Linux does not replace that Windows resource read. The unpacked EXE is still unverified until that Windows step runs.

## 2. Rebuild, update, and auto

Official `mode` means one of these:

- **rebuild** — pack the **same version** again and replace the release assets. `revision` is this same rebuild. The number does not move.
- **update** — move one counter, open the `release/v…` pull request, then publish. The number is used only after that publish succeeds. The same release type retries a failed number. A different explicit level skips that number and counts from the last success.
- **auto**, when `release_type` is also auto — finish the unpublished line as it stands. It does not invent the next number. If you pick patch, minor, major, or extreme yourself, only that one counter moves, even when `mode` is auto.

`scripts/release-engine.cjs` writes the identity into the tree before the pack. An installed copy checks the SHA256 in `friday-update.json` before it replaces itself.

## 3. 🧪 TEST identity

`.github/workflows/test-build.yml` packs a Windows EXE from a branch, a tag, a commit, or `pr/<n>`. It does not edit `main`, it does not change `config/friday-version.json`, and it does not create a Latest stable release.

| Property | Official (`electron-builder.yml`) | TEST override |
| --- | --- | --- |
| `appId` | `dev.friday.desk` | `dev.friday.desk.test` |
| `productName` | `FRIDAY` | `FRIDAY Test` |
| Setup name | `FRIDAY-Setup-<ver>.exe` | `FRIDAY-Test-Setup-<ver>.exe` |
| Uninstall display | `FRIDAY - Personal AI Assistant` | `FRIDAY Test - Personal AI Assistant` |

The executable file name stays `FRIDAY.exe`. The separate app id is what lets Windows keep TEST beside Official.

`electron/build-channel.cjs` reads the channel in this order: `FRIDAY_BUILD_CHANNEL` or `FRIDAY_TEST_BUILD=1`, then the packaged `resources/build-channel.json`, then production. The workflow stamps `{ channel: "test" }` before the pack. Test profile data stays apart from the Official FRIDAY folder.

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

Unsigned is the honest default (`signExecutable: false`). Optional Authenticode is described in [SECURITY.md](../SECURITY.md).
