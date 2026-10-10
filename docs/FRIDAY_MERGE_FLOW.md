# FRIDAY — Repository Workflow

**Current shipping version: 1.0.1.2**

🌿 The repository may be **public or private**. The workflows do not depend on that choice. On a public free repository, ruleset **Main Protection** is active: it blocks deleting the default branch and force-pushing it. It does not require a review or a status check, so a normal push to `main` is still possible. On a private free personal repository those rulesets are not available. Required Code Owner review is not enforced in either case. Safety stays workflow design plus owner discipline. The catalog of every workflow is [FRIDAY_GITHUB_ACTIONS.md](FRIDAY_GITHUB_ACTIONS.md). The landing bar for an AI session is [AGENTS.md](../AGENTS.md).

This one document is the repository workflow. It covers the path into `main`, Safe Merge, cleanup, and the manual controls you use when you need to undo or restore.

## 1. Path into `main`

Every human change starts on a **non-main development branch** and reaches `main` only through a pull request:

```text
non-main branch
  → PR Validation
  → optional FRIDAY Test Build
  → owner review
  → manual owner merge into main
  → merged work branch deleted
```

Never, on the human / Safe Merge path: direct push to `main`, automatic merge, or an automatic release after a merge.

Official release is a **separate** `workflow_dispatch` on `release.yml` (**FRIDAY Release**). It calls PR Validation and Safe Merge in that same run. Prepare and publish are jobs in that file. Merging a product pull request does not publish. The click path is [RELEASE.md](../RELEASE.md).

`.github/CODEOWNERS` records `* @devendrarj25` as a reference. That is not an enforced Ruleset on this plan.

## 2. What actually protects `main`

| Control | File |
| --- | --- |
| Branch CI | `pr-validation.yml` |
| TEST EXE | `test-build.yml` |
| Merge (typed `MERGE`) | `safe-merge.yml` / `repository-control.yml` `merge-pr` |
| Merged-branch delete | `branch-cleanup.yml` |
| Unexpected push preserve | `main-safety-recovery.yml` |

`main-safety-recovery.yml` watches `push` to `main`. A normal merged pull request is a no-op. An unexpected direct push is copied onto `recovery/main-<timestamp>-<shortsha>` with a report. It never resets or force-pushes `main`.

Trusted head prefixes live in `scripts/merge-engine.cjs` (`upgrade/`, `fix/`, `change/`, `modify/`, `dev/`, `release/v…`, and the rest of that list). A fork is refused. A release pull request is not the branch for other work.

## 3. ✅ Safe Merge

Actions → **Safe Merge** (`safe-merge.yml`) → `workflow_dispatch`. The engine is `scripts/merge-engine.cjs`. It fails closed. The run refuses unless `confirm` is exactly `MERGE`.

| Input | Meaning |
| --- | --- |
| `scope` | `auto` (eligible pull requests into `main`), `selected` (`pr_numbers`), or `release` (`release/v…` only) |
| `delete_branch` | delete the merged work branch (never a protected name) |
| `confirm` | must be `MERGE` |

All of these have to be true before a merge:

- The base is `main`.
- The pull request is open, and it is not a draft.
- The mergeability is not `CONFLICTING` or `UNKNOWN`.
- The merge state is not `DIRTY`, `BLOCKED`, or `BEHIND`.
- The head uses a trusted prefix, and the pull request is from this same repository (no forks).
- Every reported check passed on the current commit, including PR Validation.
- A release pull request is the latest `release/v…`.

The merge command is `gh pr merge --merge --match-head-commit`. There is no squash, no rebase, no `--admin`, and no force-push.

## 4. 🧹 Maintenance Cleanup

`maintenance.yml` can be dispatched (dry unless you set `apply`) and it also runs weekly at `17 3 * * 1`.

It removes:

- merged work branches that are not protected
- TEST prereleases except the newest one
- official releases beyond the newest 3
- workflow runs beyond the newest 15 per workflow

It always keeps `main`, `master`, `develop`, `development`, `release`, `recovery/*`, any branch that is not merged, and any branch pinned by an open pull request.

A leftover `dev/…` tip after a squash merge is not a second upgrade to merge. Delete it after you confirm `main` already contains that pull request.

## 5. 🗑️ Branch Cleanup

`branch-cleanup.yml` runs when a pull request into `main` is closed. It deletes the merged temporary head. The protected-name list is the same one Maintenance Cleanup uses.

## 6. ↩️ Repository Control

`repository-control.yml` is `workflow_dispatch` only. Concurrency is `friday-repository-control`. The job permission includes `actions: read` because the job reads `statusCheckRollup`.

| Action | Confirm | What you get |
| --- | --- | --- |
| `create-pr` | — | Opens a pull request when the two sides differ. It never merges. |
| `merge-pr` | `MERGE` | Merges into `main` only. The head cannot be `main` or `recovery/*`. `scripts/check-contract.cjs` must report that PR Validation passed on that head commit. A missing, running, stale, or failed check is refused. The result is a merge commit. |
| `revert-commit` | `REVERT` | Branch `revert/<utc>-<short>` from `origin/main`, then `git revert`, then `npm ci`, typecheck, and test, then a pull request. |
| `restore-commit` | `RESTORE` | `git read-tree --reset -u <sha>` on a `restore/…` branch, one new commit, the same checks, then a pull request. History moves forward. |
| `delete-branch` | `DELETE` | Deletes one remote branch. It refuses `main`, `master`, `develop`, `development`, `release`, and `recovery/*`. |

There is no force-push, no reset of `main`, and no silent merge.

## 7. 🖥️ Revert Center

The same two operations are in the app: Friday Hub → Revert Center (`src/components/friday/hub/RevertCenter.tsx`), backed by `electron/dev-workflow.cjs` (`revertCommit`, `restoreToCommit`). A revert and a content restore each open a new branch and a pull request. You still merge that pull request yourself.

The Hub can attach extra repositories. Those tokens are stored as `github.token.<id>` in the encrypted store on this PC.
