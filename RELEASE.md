# FRIDAY — Release Runbook

**Current shipping version: 1.0.1.2**

🚀 How to publish. The number rules are [VERSIONING.md](VERSIONING.md). The workflow catalog is [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). Pack internals are [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## Pre-flight

- [ ] `main` is the commit you mean to ship.
- [ ] You know whether this run is a rebuild, the same release type as a failed attempt, or a different release type.
- [ ] `npm run release:heal:check` is clean, or you will let prepare heal.
- [ ] You are not starting Official Publish for a docs-only change by accident.

## Local CMD (no GitHub publish)

```cmd
npm run build:win
```

Produces `FRIDAY-Setup-1.0.1.2.exe` and `FRIDAY-Portable-1.0.1.2.exe` under `release\`. It does not create a GitHub Release. Steps: [INSTALL.md](INSTALL.md).

## TEST EXE

Actions → **Test EXE Build** (`test-build.yml`). Inputs and the separate Windows identity: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## Official

Actions → **Release / Build**, or **Official Publish**, which runs the same prepare-then-publish path.

1. **Prepare** — tests, heals the documents, and opens or updates the release pull request. `release-engine.cjs handoff` writes the identity before the pack.
2. Merge that pull request into `main`.
3. **Publish** — Windows pack, checksums, and the GitHub Release. The version counts as used only when this step succeeds.

### If publish fails

| Next run | Result |
| --- | --- |
| Same release type (`patch` again, `minor` again, …) | The failed number is published. The counters do not move |
| A different explicit level | The failed number is skipped. Only the chosen counter moves, counted from the last successful publish |
| `mode` auto with `release_type` auto | The number stays. A new counter is not invented |
| `mode` update with `release_type` auto | Patch, minor, or major from the size of the change. Extreme stays manual |
| Rebuild, or release type revision | The declared number is packed again for a check |

A patch of `1.0.1.2` is `1.0.1.3`. A minor is `1.0.2.2`. A major is `1.1.1.2`. An extreme is `2.0.1.2`. The other places stay. The full rule is [VERSIONING.md](VERSIONING.md).

## After a successful publish

- [ ] The GitHub Release tag matches `config/friday-version.json`.
- [ ] Assets include Setup, Portable, `friday-update.json`, and `SHA256SUMS.txt`.
- [ ] Settings → Updates on an installed copy sees the new Stable build.
- [ ] What's New for that version reads by area, with no internal notes.

Merging a product pull request does not publish. Publish is this runbook.
