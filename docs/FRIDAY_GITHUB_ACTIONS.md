# FRIDAY — GitHub Actions Catalog (Repository Automation)

**Current shipping version: 1.0.1.2**

⚙️ Every workflow file under `.github/workflows`. Merge philosophy: [FRIDAY_MERGE_FLOW.md](FRIDAY_MERGE_FLOW.md). Runbook clicks: [RELEASE.md](../RELEASE.md). Assistants must **not dispatch** these jobs.

Twelve files exist today: nine release/repository workflows and three automatic-health workflows. Do not add a thirteenth without a real need. They are locked. The session rule is [AGENTS.md](../AGENTS.md).

## 1. Catalog

| File | Name | Trigger | Jobs | Permissions |
| --- | --- | --- | --- | --- |
| `pr-validation.yml` | PR Validation | `pull_request` into `main`; `workflow_dispatch` (`sha`) | `gate`, `docs-only`, `secrets`, `codeql`, `audit` on `ubuntu-latest`; `validate` on `windows-latest` | `contents: write` (docs heal and `.gitkeep` only), `statuses: write`; CodeQL job adds `security-events: write` |
| `test-build.yml` | Test EXE Build | `workflow_dispatch` (`ref`, `package`, `publish`) | `test-build` | `contents: write` |
| `release.yml` | Release / Build | `workflow_dispatch` (`stage`, `mode`, `release_type`, `title`, `notes`) | `prepare`, `publish` | `contents: write`, `pull-requests: write`, `actions: read` |
| `official-publish.yml` | Official Publish | `workflow_dispatch` (`mode`, `release_type`, `title`, `notes`) | `orchestrate` | `contents: read`, `pull-requests: read`, `actions: write`, `checks: read`, `statuses: read` |
| `safe-merge.yml` | Safe Merge | `workflow_dispatch` (`scope`, `pr_numbers`, `delete_branch`, `confirm`) | `merge` | `contents: write`, `pull-requests: write`, `checks: read`, `statuses: read`, `actions: read` |
| `repository-control.yml` | Repository Control | `workflow_dispatch` | `control` | same as Safe Merge (`actions: read` for `statusCheckRollup`) |
| `maintenance.yml` | Maintenance Cleanup | `workflow_dispatch`; `schedule` `17 3 * * 1` | `cleanup` | `contents: write`, `actions: write`, `pull-requests: read` |
| `branch-cleanup.yml` | Branch Cleanup | `pull_request` closed on `main` | `delete-merged-branch` | `contents: write` |
| `main-safety-recovery.yml` | Main Safety Recovery | `push` to `main` | `preserve-unexpected-push` | `contents: write`, `pull-requests: read` |
| `health-weekly.yml` | Health Weekly | `schedule` `23 4 * * 1`; `workflow_dispatch` | `health` on `ubuntu-latest` | `contents: read`, `issues: write` |
| `auto-recover.yml` | Auto Recover | `schedule` `41 */12 * * *`; `workflow_dispatch` | `recover` on `ubuntu-latest` | `actions: write`, `contents: read`, `pull-requests: read` |
| `security.yml` | Security Scan | `schedule` `37 5 * * 2`; `workflow_dispatch` | `secrets`, `scope`, `codeql`, `audit` | `contents: read` (`security-events: write` for CodeQL only) |

## 1a. The three automatic-health workflows

They exist for a project that is worked on in bursts, with long gaps. None of them versions, tags, publishes, merges or changes code. Pull-request checks live in **PR Validation** only, so a ready pull request does not pay for a second Linux suite or a second security workflow.

- **Health Weekly** — every Monday it runs the same script as `npm run resume` on the default branch. It keeps one issue, "FRIDAY health check failing", up to date and closes it when the project is healthy again. The run itself stays green; the issue is the alert.
- **Auto Recover** — when Actions minutes or the spending limit run out, GitHub fails a run without starting any step. Twice a day (`41 */12 * * *`) this workflow re-runs exactly those never-started runs (PR Validation, Health Weekly, Security Scan only; current open pull-request heads, or scheduled runs from the last 35 days (one billing cycle), only; at most 5 per pass). A run that recorded any step conclusion, including a timeout, is a real run and is never touched. It needs minutes itself, so it starts working again as soon as the limit resets.
- **Security Scan** — the weekly and manual scan of the default branch: gitleaks over the full history (red only if a secret is found), CodeQL for JavaScript/TypeScript and Python (public repositories only), and informational `npm audit` / `pip-audit` warnings that never fail a build. A pull request does not start this workflow. The same three checks run inside PR Validation.

Limits to know: GitHub disables scheduled workflows in a public repository after 60 days without repository activity — after a very long gap, open the Actions tab and re-enable them, or just run `npm run resume` locally. Auto Recover cannot run while minutes are still exhausted; it acts on the first schedule after the reset.

These twelve workflows run the same way when the repository is public or private, including after a flip either way. CodeQL is skipped on a private repository. On a public one it warns and exits 0 until `github/codeql-action` is allowed; that action is outside the allow-list and fails the workflow at startup. A pull request's `GITHUB_SHA` is the merge commit on `refs/pull/N/merge`, not a branch tip. A full-history checkout fetches that commit (or the pull request head) before it checks the SHA out, on a public or a private repository. In-progress runs can be cancelled by GitHub when visibility changes; the next run uses the same files. Branch rules: [FRIDAY_MERGE_FLOW.md](FRIDAY_MERGE_FLOW.md).

PR Validation never tags or publishes. Release / Build is the only workflow that may version, tag, pack Official, or create a stable GitHub Release. Test EXE Build may publish a prerelease only.

When PR Validation auto-heals documentation, it pushes one docs-only commit to the pull request branch. GitHub starts no new run for a push made by a workflow, so the run publishes its "PR Validation" result on both the original and the healed commit; the healed head is therefore never left without the required status. The first push that creates `main` in an empty repository is recognised by Main Safety Recovery and does not create a recovery branch. A preservation record `recovery/<timestamp>.md` is evidence of that push. The documentation registry does not index it, so merging the recovery pull request does not fail release tests.

Local substitute for PR Validation (no GitHub check): `npm run validate:local`. That command also runs `npm run check:provenance` on `origin/main..HEAD`.

## 1b. Minutes budget: what runs, and what never does

Hosted minutes are spent only where they buy evidence. Nothing below removes a
check or a protection; each rule only skips work whose result cannot change.

| Situation | What runs | What is skipped, and why that is safe |
| --- | --- | --- |
| Draft pull request | Secret scan only (about a minute; a leaked secret is leaked from any branch) | Gate, tests, CodeQL, audits and the Windows installer. A draft cannot be merged. The full run starts when the owner marks it ready for review. The gate's `if` is also required on every job that needs the gate, so a skipped gate cannot start Windows. |
| Change touching any code, config, workflow, script, skill, tool, agent, `CHANGELOG.md` or anything the installer packages | One workflow: `gate`, Windows `validate` (typecheck, docs and version sync, commit provenance, Vitest, kernel tests, layout, architecture audit, installer build and smoke, warn-only "code changed without a test"), secret scan, CodeQL on a public repository, and informational npm/pip audit | A second workflow. Those checks used to run again as CI Fast and as a pull-request Security Scan. |
| Documentation only (decided by `scripts/pr-scope.cjs`) | `gate`, the Linux `docs-only` job (heal check, docs check, version check, type check, commit provenance, the full test suite, the same warn-only test note) publishing the same required `PR Validation` status, and the secret scan | The Windows installer, kernel tests, CodeQL and the dependency audit. No file they read or package changed. |
| Manual `PR Validation` run with a `sha` (release evidence) | Always the full Windows validation | Nothing. |
| Test EXE Build or Official Publish, and this commit already has a successful `PR Validation` status from the last 7 days | Test EXE still builds the EXE. Official Publish still requires that green status before merge. Neither starts PR Validation again. | Typecheck and `npm test` inside Test EXE, and the Official Publish dispatch of PR Validation. The tree has not changed since the green run. A pending run is waited on. A missing, failed, or older result starts PR Validation. |
| Release / Build after `apply` or `heal` | Its own tests and typecheck | Nothing is reused. Those steps run because the version apply changed the tree, so the previous status belongs to a different commit. |
| A newer push to the same branch | The newer run | The older in-flight run (`cancel-in-progress`). |
| Limit hit, then reset | Auto Recover re-runs only the jobs that never started | A job that recorded any step conclusion, including a timeout, is a real run and is never re-run. |

`scripts/pr-scope.cjs` is the only definition of "documentation only". The
workflows read it from the **base** commit, so a pull request cannot rewrite the
rule that judges it; anything unknown, renamed into packaged code, or empty means the
full validation. PR Validation has no `paths-ignore`. GitHub leaves a skipped
required check pending, which would block the merge even when the change is safe.

Auto-heal may commit documentation and empty `.gitkeep` placeholders to the pull
request branch. It does not rewrite code and it does not run `npm audit fix`.
A push made by the workflow token starts no new run, so the same run publishes
the `PR Validation` status on the healed commit too.

Dependabot opens version updates monthly. npm, GitHub Actions and kernel pip
each have one wildcard group and `open-pull-requests-limit: 1`, so a month is
at most one version pull request per ecosystem. GitHub cannot put those three
ecosystems into a single pull request. Security updates stay ungrouped and
immediate; they do not wait for the monthly batch. Semver majors are ignored in
every ecosystem, including `electron`, `electron-builder`, `vite`, and
TypeScript. A major is a planned upgrade. Nothing auto-merges. Dependabot runs use a
read-only token and cannot publish the `PR Validation` status: run **PR Validation**
from the Actions tab with that commit's SHA.

Commit provenance allows that dependency-update account only when the author
or committer name is `dependabot[bot]` and the email is
`49699333+dependabot[bot]@users.noreply.github.com`, both exact. The same pair
may appear on a co-author trailer. A sign-off of `dependabot[bot]` with
`support@github.com` is allowed. The same name with any other email, and every
other bot, still fails. Assistant authors, assistant trailers, and a message
that says the change was generated still fail.

**One open draft, then one validation.** `main` stays protected, so every change
is still a pull request. Any assistant continues on the latest open draft into
`main` and opens a new draft only when none exists. The owner marks that draft
ready when the batch should be checked. That is one validation for the whole
batch. Draft pushes do not start it.

## 2. GitHub Settings → Branches: the exact required check names

This is a **repository setting, not repository code**. If a required check name does not match, GitHub reports `mergeStateStatus: BLOCKED`.

If branch protection is enabled for `main`, enter exactly:

```text
PR Validation
```

GitHub's picker may also offer `PR Validation / validate` (workflow name `/` job name). Pick **one**. Do not add both. `scripts/check-contract.cjs` accepts either.

## 3. Diagnosing a stuck release

| Symptom | Likely cause |
| --- | --- |
| Official Publish `pull request moved` | A push landed after the head was pinned; re-run Official Publish `mode = auto` |
| Official Publish looks for `release/v` of the declared version after an explicit increment | The orchestrator pins the version prepare will open for that `mode` and `release_type`. Increment rules: [VERSIONING.md](../VERSIONING.md). |
| Release prepare: `GitHub Actions is not permitted to create or approve pull requests` | New repositories block this until Settings → Actions → General → Workflow permissions → **Allow GitHub Actions to create and approve pull requests** is enabled. The release branch is already pushed. Open that pull request, or enable the setting and re-run Official Publish. Merging is a separate permission and is not this error. Official Publish then waits long enough for the 90-minute Windows validation job before Safe Merge. |
| Workflow dispatch returns HTTP 403 (`actions=write`) | This checkout's integration token cannot start workflows. The owner starts them from the Actions tab. The one-shot markers from an earlier test publish have been removed. |
| `startup_failure`: an action is not allowed because every action must be owned by `devendrarj25` | Checkout, Node, and Python come from `.github/actions` in this repository. CodeQL does not run until `github/codeql-action` is allowed under Settings, Actions, General, Actions permissions. |
| Safe Merge `startup_failure` and no jobs | The run was accepted and never queued a job (Safe Merge 37200400230, after PR Validation had passed). `delete_branch` is a string (`true` or `false`), matching the value Official Publish sends. The required `confirm` input has no default. |
| `required check "PR Validation" has not reported` | Validation ran on a different SHA |
| Safe Merge `GraphQL: Resource not accessible` | token missing `actions: read` (already granted on `safe-merge.yml` / `repository-control.yml`) |
| Safe Merge `merge state is BLOCKED` | required-check name mismatch (section 2) |
| Safe Merge `head branch is not a trusted work branch` | prefix outside `scripts/merge-engine.cjs` `TRUSTED_HEAD` |
| Safe Merge does nothing | `confirm` was not typed `MERGE` |

Work is not repeated: PR Validation publishes a commit status. Safe Merge reads it. Test EXE Build and Official Publish call `scripts/validation-freshness.cjs` and reuse a success on that same commit from the last 7 days.
