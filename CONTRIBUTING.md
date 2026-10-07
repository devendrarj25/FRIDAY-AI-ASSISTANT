# Contributing to FRIDAY

**App:** FRIDAY AI · **Owner:** Devendra Singh Meena (devendrarj25)
**Current shipping version: 1.0.1.2**

This repository is the whole product. FRIDAY installs, builds, and runs from
these files. It does not need an outside assistant service to do that.

The only recorded owner and the only recorded changer is **Devendra Singh Meena
(devendrarj25)**. Do not add a contributors list, a second author, a tool name,
or a record of who did the work. Session rules live in [AGENTS.md](AGENTS.md).
Current facts live in [FRIDAY_STATE.md](FRIDAY_STATE.md). How a merged pull
request is cleaned up lives in [docs/FRIDAY_MERGE_FLOW.md](docs/FRIDAY_MERGE_FLOW.md).

## 1. Where the work goes

Never edit `main`. Work stays on one non-release pull request into `main`.

1. If a draft pull request into `main` is open, and it is not a release pull
   request, continue there. A different topic still goes in that draft.
2. If there is no such draft, and another pull request into `main` is open,
   and it is not a release pull request, continue there.
3. If neither is open, create one branch and one draft pull request.

Do not merge a pull request. The owner merges. Do not mark a draft ready
unless the owner says to do that for this pull request. A release pull
request (`release/v…`) is created by `release.yml` only. Do not add other
work to it.

A new branch names the area and the purpose:

| Prefix | Example |
| --- | --- |
| `upgrade/<area>-<purpose>` | `upgrade/models-free-tier` |
| `fix/<area>-<purpose>` | `fix/chat-strip` |
| `change/<area>-<purpose>` | `change/docs-map` |
| `modify/<area>-<purpose>` | `modify/voice-wake` |

`scripts/merge-engine.cjs` trusts these heads, plus the maintenance prefixes
in the table below. `dev/` stays trusted so an already-open branch of that
shape can stay the one open pull request. A tool prefix such as `cursor/` or
`claude/` is not trusted. A host may add its own suffix. Do not hard-code a
suffix from an older session.

## 2. Working rule

Inspect, change only what the task needs, integrate, then test. One
implementation per feature (`config/project-structure.json`). Do not remove
a working feature or invent a parallel path. Publisher stays **Devendra Singh
Meena (devendrarj25)**.

Locked areas, and what to do when a task must touch one, are in
[AGENTS.md](AGENTS.md). Canonical files that re-run their tests:
`src/lib/friday/navigation.ts`, `electron/update-safety.cjs`.

## 3. Environment

- Node and npm floors: `package.json` `engines` (`>=22.19.0` / `>=10.9.0`), checked by `scripts/check-engines.cjs`.
- Python: `node scripts/setup-python.cjs` (live venv).
- Electron: `node scripts/ensure-electron.cjs`.
- Install with `npm ci` so `package-lock.json` decides.

```bash
npm test
npm run typecheck
npm run lint
npm run validate:local
```

Windows pack: `scripts\build-windows.cmd` — [INSTALL.md](INSTALL.md) and [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## 4. Prefixes the merge engine trusts

| Prefix | Use |
| --- | --- |
| `upgrade/` `fix/` `change/` `modify/` `feature/` `bugfix/` `hotfix/` | product work |
| `chore/` `docs/` `refactor/` `perf/` `test/` `ci/` `build/` | maintenance |
| `dev/` | an already-open work branch |
| `revert/` `restore/` | Repository Control / Revert Center |
| `release/vX.Y.Z` or `release/vX.Y.Z.W` | created by `release.yml` only |

Never delete `main`, `master`, `develop`, `development`, `release`, or `recovery/*`.

## 5. Commits and documentation

Commit subjects follow Conventional Commits so `scripts/release-engine.cjs`
can classify a bump. What's New is rewritten into plain language at publish
time: what was added, improved, or fixed. It does not name pull requests,
internal files, or how the release was prepared. [VERSIONING.md](VERSIONING.md).

The same pull request **must update the affected documents**. After Markdown
edits run `npm run docs:sync` then `npm run docs:check`. Do not invent a
second registry or a second What's New store.

## 6. What not to touch

- Do not bump `config/friday-version.json` unless the owner asked.
- Do not dispatch GitHub Actions; leave the tree so those jobs would stay green.
- Do not commit to `main`. Open a pull request; the owner merges.
