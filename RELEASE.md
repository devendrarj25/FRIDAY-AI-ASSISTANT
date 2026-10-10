# FRIDAY — Release Runbook

**Current shipping version: 1.0.1.2**

🚀 How to publish. The number rules are [VERSIONING.md](VERSIONING.md). The workflow catalog is [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). Pack internals are [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## Pre-flight

- [ ] `main` is the commit you mean to ship.
- [ ] You know whether this run is a rebuild, the same release type as a failed attempt, or a different release type.
- [ ] `npm run release:heal:check` is clean, or you will let prepare heal.
- [ ] You are not starting FRIDAY Release for a docs-only change by accident.

## Local CMD (no GitHub publish)

```cmd
npm run build:win
```

Produces `FRIDAY-Setup-1.0.1.2.exe` and `FRIDAY-Portable-1.0.1.2.exe` under `release\`. It does not create a GitHub Release. Steps: [INSTALL.md](INSTALL.md).

## TEST EXE

Actions → **FRIDAY Test Build** (`test-build.yml`). Inputs and the separate Windows identity: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## Official

Actions → **FRIDAY Release** (`release.yml`). The default `stage` is `all`: plan, prepare, validate, merge, then publish. `stage=prepare` opens the release pull request and stops. `stage=publish` packs the version already on `main`. The workflow file on `main` is the one a manual click uses, so a fix to that file applies only after it is merged. Check names that change if a repository rule pinned the old display name: **Official Publish** becomes **FRIDAY Release**, **Release / Build** is gone, **Test EXE Build** becomes **FRIDAY Test Build**. The commit status **PR Validation** does not change. Job names `prepare-release / prepare` and `publish-release / publish` become `prepare` and `publish`.

1. **Prepare** — tests, heals the documents, and opens or updates the release pull request. `release-engine.cjs handoff` writes the identity before the pack.
2. Merge that pull request into `main`.
3. **Publish** — Windows pack, checksums, and the GitHub Release. The version counts as used only when this step succeeds.

### If publish fails

| Next run | Result |
| --- | --- |
| Same release type (`patch` again, `minor` again, …) | The failed number is published. The counters do not move |
| A different explicit level | The failed number is skipped. Only the chosen counter moves, counted from the last successful publish |
| `mode` auto with `release_type` auto | The number stays. A new counter is not invented. A never-published line is finished as it stands |
| An explicit patch, minor, major, or extreme on a never-published line | That one counter still moves from the declared number |
| `mode` update with `release_type` auto | Patch, minor, or major from the size of the change. Extreme stays manual |
| Rebuild, or release type revision | The declared number is packed again for a check |

A patch of `1.0.1.2` is `1.0.1.3`. A minor is `1.0.2.2`. A major is `1.1.1.2`. An extreme is `2.0.1.2`. The other places stay. The full rule is [VERSIONING.md](VERSIONING.md).

## After a successful publish

- [ ] The GitHub Release tag matches `config/friday-version.json`.
- [ ] Assets include Setup, Portable, `friday-update.json`, and `SHA256SUMS.txt`.
- [ ] Settings → Updates on an installed copy sees the new Stable build.
- [ ] What's New for that version reads by area, with no internal notes.

Merging a product pull request does not publish. Publish is this runbook.

## Owner acceptance

Run this on the Windows PC after the draft is merged, or run step 1 on the pull request ref before merge. A Linux check does not replace it. If a step fails, send the on-screen error text and the step number.

1. Actions → **FRIDAY Test Build** on the pull request ref. Download the artifact and install the test EXE.
2. After that pull request is on `main`, Actions → **FRIDAY Release** with `stage` left at `all`. `stage=prepare` only opens the release pull request. `stage=publish` packs the version already on `main`.
3. Confirm Setup and Portable are each at least 70 percent of the bundled pin sum (143558856 bytes on this manifest) and strictly under 2 GiB.
4. First launch, then Doctor. Voice rows may stay Warning until a live check.
5. One Chat turn and one Auto turn. Both must offer the same free pool. Chat stays quiet. Auto is the only microphone and speech session.
6. One web search. The result names the provider. Keyless HTML may say it can be blocked.
7. One sandbox run from the staged or bootstrapped Python.
8. MCP pairing from Connectors, then one `friday.ask` call. Turn the server off after.
9. Install the official Setup over the test copy, or update from Settings, then uninstall. User data under the FRIDAY folder stays.

Repository rules that pinned a display name: **Official Publish** is now **FRIDAY Release**, **Release / Build** is gone, **Test EXE Build** is now **FRIDAY Test Build**. The commit status **PR Validation** is unchanged. Job checks `prepare-release / prepare` and `publish-release / publish` are now `prepare` and `publish`.
