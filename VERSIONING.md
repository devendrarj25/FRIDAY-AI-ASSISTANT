# FRIDAY — Versioning Policy

**Current shipping version: 1.0.1.2**

📦 The public version lives in one file: `config/friday-version.json`. Everything else that must show it is rewritten from that file. Click-by-click publish is [RELEASE.md](RELEASE.md). How the pack is built is [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## 1. One number, two shapes

| Surface | Value today | Used for |
| --- | --- | --- |
| Public FRIDAY (`releaseVersion`) | `1.0.1.2` | The version you see, the GitHub tag, EXE names, and in-app update compare |
| npm / electron-builder (`package.json` `version`) | `1.0.1` | Tools that only accept three-part SemVer |

🧭 `npm run typecheck` prints `FRIDAY 1.0.1.2` from the version file before the checker runs. npm itself still prints `friday@1.0.1` first, because that field is the three-part encoding (the first three public parts). It is not a second product version, and it is rewritten whenever the public number changes. Never compare it as an update identity.

Artifacts are `FRIDAY-Setup-1.0.1.2.exe` and `FRIDAY-Portable-1.0.1.2.exe`.

Ordering example (an example only, not a shipping claim): 1.4.0 < 1.4.1-test.1 < 1.4.1-test.2 < 1.4.1

## 2. Epoch

`epoch` / `epochName` in `config/friday-version.json` are `2` / `friday-2`. They do not appear in artifact names.

## 3. When the number moves

A number is used only after a **successful** publish: a stable git tag or a GitHub release. A changelog heading written while prepare is still running is not a publish.

The four counters keep counting. A chosen level moves only its own place. The others stay, so the number still shows how many patches, minors, majors, and extremes have happened.

From the current line `1.0.1.2`:

| Level | Next number |
| --- | --- |
| patch | `1.0.1.3` |
| minor | `1.0.2.2` |
| major | `1.1.1.2` |
| extreme | `2.0.1.2` |
| revision or rebuild | `1.0.1.2` (same number) |

The written product line, oldest first, is `1.0.0.0` (base) → `1.0.0.1` → `1.0.0.2` → `1.0.1.2` (latest). The last step is a minor: the third place moved from 0 to 1 and the fourth place stayed 2. New publishes do not reset the lower places.

| What you run next | What the version does |
| --- | --- |
| The workflow failed, then you fix and run the same release type | The same unpublished number is published. No bump |
| A different explicit level | The failed number is skipped. The new number is that one counter, counted from the last successful publish |
| `mode` = `auto` and `release_type` = `auto` | The number does not move. An unpublished line is finished as it stands |
| `mode` = `update` and `release_type` = `auto` | Patch, minor, or major, from how much the project changed. Extreme is never chosen this way |
| An explicit patch, minor, major, or extreme | Only that counter moves, including when the declared line has never been published. Extreme happens only when you select it |
| `revision` or `rebuild` | The same version. This is a rebuild so you can check that it works |

`auto` with `release_type` auto still ships a never-published line as it stands. Naming patch, minor, major, or extreme moves that counter from the declared number. A stable git tag and a GitHub release both count as a published number.

Research (2026-10-09). Sources: [SemVer](https://semver.org/), [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), and [pnpm first-release hold](https://github.com/pnpm/pnpm/pull/13207). ADOPT: `auto` publishes a never-released declared number as written, so the first public line is not skipped. ADAPT: an explicit counter still moves from that number, because the owner named the level. REJECT: walking the whole git history to invent the first bump. An empty change list stays empty.

Official Publish, Release / Build, and the in-app Analyze preview all ask `scripts/release-engine.cjs`. `handoff` writes the identity into the tree before the pack. The in-app update check reads the same 100-release window.

`release_type`: `auto`, `patch`, `minor`, `major`, `extreme`, `revision`.

## 4. Channels

| Channel | Windows `appId` | GitHub |
| --- | --- | --- |
| Official / Stable | `dev.friday.desk` | Latest release, tag `vX.Y.Z.W` |
| Test | `dev.friday.desk.test` | prerelease tag `vX.Y.Z.W-test.N` |

TEST can sit beside Official. The Windows identity and the in-app channel are in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## 5. What's New

📝 Each published version has one store-style note: what arrived, in which area, in plain language. The same text is [CHANGELOG.md](CHANGELOG.md), `releases/notes/vX.md`, the short README summary, and the in-app preview.

The note does not name pull requests, commits, branches, or internal files. A workflow publish writes that note itself. History that already shipped is kept. A failed attempt that is later skipped is removed from the written history, because it never became a release.

When the last successful line has no git tag in this checkout, the note is still built from the changes since that line, then written in the same shape. A first version that the changelog does not record yet confirms with an empty log.

## 6. Where the number is allowed to appear

Most pages only need the name FRIDAY. The number stays in:

- `config/friday-version.json` (the source)
- the npm encoding in `package.json` (derived)
- installer and portable file names
- What's New for that release
- the one “current shipping version” line in a document that has to name it

`npm run verify:version` and `npm run release:heal` rewrite those lines from the version file. Do not add a second What's New store, and do not paste the number into a page that only needs the name.
