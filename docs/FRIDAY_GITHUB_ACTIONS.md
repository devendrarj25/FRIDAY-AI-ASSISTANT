# FRIDAY — GitHub Actions Catalog (Repository Automation)

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

**Current shipping version: 1.1.4.6**

⚙️ Every workflow file under `.github/workflows`. Merge philosophy: [FRIDAY_MERGE_FLOW.md](FRIDAY_MERGE_FLOW.md). Runbook clicks: [RELEASE.md](../RELEASE.md). Only the owner runs these jobs.

Eleven files exist today: eight release/repository workflows and three automatic-health workflows. Do not add a twelfth. They are locked. An owner request to edit one still needs a second yes or ok. Other work that must touch one fixes the effects in that same change. The working rule is [AGENTS.md](../AGENTS.md) → GitHub workflows stay locked. The official publish lives in `release.yml`; its display name is **FRIDAY Release**.

## 1. Catalog

| File | Name | Trigger | Jobs | Permissions |
| --- | --- | --- | --- | --- |
| `pr-validation.yml` | PR Validation | `pull_request` into `main`; `workflow_dispatch` (`sha`); `workflow_call` from FRIDAY Release (`sha`, `head_ref`, `caller: friday-release`) | `gate`, `static`, `kernel`, `tests-windows`, `package-windows`, `update-windows`, `validate` (status only), `docs-only`, `secrets`, `codeql`, `audit`. `validate` waits for all seven blocking jobs (static, kernel, tests, package, update, audit, secrets). `static` and `kernel` on `ubuntu-latest`. `tests-windows` (two shards, fail-fast off) and `package-windows` on `windows-latest`. `validate` publishes the commit status | read-only by default; `static` has `contents: write` (docs heal and `.gitkeep` only) and `statuses: write`, `validate` has `statuses: write`; CodeQL job adds `security-events: write` |
| `test-build.yml` | FRIDAY Test Build | `workflow_dispatch` (`ref`, `package`, `publish`) | `test-build` | `contents: write` |
| `release.yml` | FRIDAY Release | `workflow_dispatch` only (`stage` default `all`, `mode`, `release_type`, `title`, `notes`) | `plan`, `prepare`, `pin`, `evidence`, `validate`, `confirm-checks`, `merge`, `verify-main`, `publish`, `confirm` (also reads the published assets back and verifies them with `scripts/verify-published-release.cjs`), `summary` | Workflow default is read-only (`contents: read`, `pull-requests: read`, `actions: read`, `checks: read`, `statuses: read`). `prepare` adds `contents: write` and `pull-requests: write`. `publish` adds `contents: write` and keeps `pull-requests: read`. Concurrency group `friday-release` is on the workflow, `cancel-in-progress: false`. There is no `workflow_call` trigger and no self-call. |
| `safe-merge.yml` | Safe Merge | `workflow_dispatch` (`scope`, `pr_numbers`, `delete_branch`, `confirm`); `workflow_call` from FRIDAY Release (`caller: friday-release`, `confirm` required, no default) | `merge` | `contents: write`, `pull-requests: write`, `checks: read`, `statuses: read`, `actions: read` |
| `repository-control.yml` | Repository Control | `workflow_dispatch` | `control` | same as Safe Merge (`actions: read` for `statusCheckRollup`) |
| `maintenance.yml` | Maintenance Cleanup | `workflow_dispatch`; `schedule` `17 3 * * 1` | `cleanup` | `contents: write`, `actions: write`, `pull-requests: read` |
| `branch-cleanup.yml` | Branch Cleanup | `pull_request` closed on `main` | `delete-merged-branch` | `contents: write` |
| `main-safety-recovery.yml` | Main Safety Recovery | `push` to `main` | `preserve-unexpected-push` | `contents: write`, `pull-requests: read` |
| `health-weekly.yml` | Health Weekly | `schedule` `23 4 * * 1`; `workflow_dispatch` | `health` on `ubuntu-latest` | `contents: read`, `issues: write` |
| `auto-recover.yml` | Auto Recover | `schedule` `41 */12 * * *`; `workflow_dispatch` | `recover` on `ubuntu-latest` | `actions: write`, `contents: read`, `pull-requests: read` |
| `security.yml` | Security Scan | `schedule` `37 5 * * 2`; `workflow_dispatch` | `secrets`, `scope`, `codeql`, `audit` | `contents: read` (`security-events: write` for CodeQL only) |

## 1a. The three automatic-health workflows

They exist for a project that is worked on in bursts, with long gaps. None of them versions, tags, publishes, merges or changes code. Pull-request checks live in **PR Validation** only, so a ready pull request does not pay for a second Linux suite or a second security workflow.

- **Health Weekly** — every Monday it runs the same script as `npm run resume` on the default branch. It keeps one issue, "FRIDAY health check failing", up to date and closes it when the project is healthy again. The run itself stays green; the issue is the alert. Its advisory step uses `scripts/advisory-audit.cjs --report-only`, so a blocking advisory is a warning in that report and does not fail the run.
- **Auto Recover** — when Actions minutes or the spending limit run out, GitHub fails a run without starting any step. Twice a day (`41 */12 * * *`) this workflow re-runs exactly those never-started runs (PR Validation, Health Weekly, Security Scan only; current open pull-request heads, or scheduled runs from the last 35 days (one billing cycle), only; at most 5 per pass). A run that recorded any step conclusion, including a timeout, is a real run and is never touched. It needs minutes itself, so it starts working again as soon as the limit resets.
- **Security Scan** — the weekly and manual scan of the default branch: gitleaks over the full history (red only if a secret is found), CodeQL for JavaScript/TypeScript and Python (public repositories only), and `scripts/advisory-audit.cjs`. High, critical, and unknown severity fail unless `config/advisory-allow.json` lists that id and the expiry is still ahead. Moderate and low warn. A pull request does not start this workflow. The same three checks run inside PR Validation. The scan image is pinned by tag and digest: `zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`. `.gitleaksignore` lists the one historical redaction fixture (`generic-api-key`, `core/__tests__/model-router-max.test.ts`); the live test uses a repeated-character stand-in.

Limits to know: GitHub disables scheduled workflows in a public repository after 60 days without repository activity — after a very long gap, open the Actions tab and re-enable them, or just run `npm run resume` locally. Auto Recover cannot run while minutes are still exhausted; it acts on the first schedule after the reset.

These eleven workflows run the same way when the repository is public or private, including after a flip either way. CodeQL is skipped on a private repository. On a public one it warns and exits 0 until `github/codeql-action` is allowed; that action is outside the allow-list and fails the workflow at startup. A pull request's `GITHUB_SHA` is the merge commit on `refs/pull/N/merge`, not a branch tip. A full-history checkout fetches that commit (or the pull request head) before it checks the SHA out, on a public or a private repository. In-progress runs can be cancelled by GitHub when visibility changes; the next run uses the same files. Branch rules: [FRIDAY_MERGE_FLOW.md](FRIDAY_MERGE_FLOW.md).

PR Validation never tags or publishes. FRIDAY Release is the only workflow that may version, tag, pack Official, or create a stable GitHub Release. FRIDAY Test Build may publish a prerelease only.

When PR Validation auto-heals documentation, it pushes one docs-only commit to the pull request branch. GitHub starts no new run for a push made by a workflow, so the run publishes its "PR Validation" result on both the original and the healed commit; the healed head is therefore never left without the required status. The first push that creates `main` in an empty repository is recognised by Main Safety Recovery and does not create a recovery branch. A preservation record `recovery/<timestamp>.md` is evidence of that push. The documentation registry does not index it, so merging the recovery pull request does not fail release tests.

Local substitute for PR Validation (no GitHub check): `npm run preflight`. `npm run validate:local` calls that same script. Cheap static gates run first. A failure does not stop the later gates; the command prints one table and then exits non-zero. `--full` adds the Vitest suite and the Windows pack when the machine can run them. `--changed` keeps the gates the diff can affect. `core/__tests__/one-gate.test.ts` fails when a preflight gate is missing from PR Validation and from the named exception list (Windows pack via `build-pipeline.cjs`, or publish evidence instead of a second suite). `tests-required` is pull-request only and warn-only. The Python action and one `kernel/requirements-dev.txt` install per job that needs ruff or pytest are hosted setup. NSIS, verify-build, and installer smoke run on `windows-latest` in `package-windows`, and locally only on win32 or with `--full` / `--pack`. The docs-only job still skips lint, because that job does not install Python. `actions/cache` is not used: this repository only allows actions owned by `devendrarj25`.

`npm test` on a code pull request is two Windows shards (`--shard=1/2` and `--shard=2/2`) with `fail-fast: false`. Each shard writes the 20 slowest files into the job summary. `isolate` stays on. It was not proven safe to turn off. The `validate` job does not run the suite. It publishes the commit status `PR Validation` from the parallel results (static, kernel, tests, package, audit, secrets), on the checked-out commit and on a docs heal commit when one was pushed. A failed or skipped parallel job publishes failure. A red or missing status cannot reach `gh release create`.

## 1d. What a green PR Validation proves for the build

The Windows work is split over two runners that start together, so the wall time is the longer one (measured on `windows-latest`: about 19 minutes for the lifecycle job when it also ran erase-all, 7 for the update job; erase-all now runs in the update job). `package-windows` runs the same shared pipeline as FRIDAY Release and the CMD pack, `scripts/build-pipeline.cjs`, in two calls: `--channel production --caller pr-validation --through verify-versions` (prepare the environment, check versions) and `--from stage-toolchain` (toolchain, renderer, NSIS and portable packaging, `packaged-requires`, signing hook, manifest, `verify-build` with the update-path proof, boot, readiness, the packaged self-check and the installer smoke with `FRIDAY_SMOKE_SCENARIO=lifecycle`: install, boot, reinstall, silent update, keep-uninstall). `update-windows` downloads the newest published `FRIDAY-Setup-*.exe` (`FRIDAY_PREVIOUS_INSTALLER`, into `RUNNER_TEMP`), builds the NSIS installer with the same pipeline, then runs the smoke with `FRIDAY_SMOKE_SCENARIO=update`: the earlier release is installed, updated in place with `/S --updated --force-run`, updated again while FRIDAY is running, booted and keep-uninstalled, a keep file in each of 12 data folders must survive every step, and then the erase-all uninstall (`/S /DELETEDATA`) runs, so the two jobs take about the same time (the first real run measured 19 minutes for the lifecycle job with erase-all and 7 for the update job). It builds the installer itself because a job cannot hand a file to another job without an artifact action, and only actions owned by the owner are allowed. With no published release it builds nothing and says `Update test: SKIPPED` in its summary. A pull request carries the version already on `main`, so this is an in-place update from the last release's files to this build's files (a real version increase is exercised by FRIDAY Release). All pipeline calls pass `--strict`: a phase that reports `skipped:` fails the job, so a missing smoke or self-check can never read as green. `core/__tests__/build-parity.test.ts` fails if a phase is no longer run, and `core/__tests__/pr-validation-design.test.ts` pins the shape of the whole workflow. Nothing is signed or published. The Windows jobs add Defender exclusions for the workspace and temp (speed only; a refusal is a notice, not a failure; the effect on the wall time is unmeasured). `static` also fails when `docs:sync` or `build:desktop` leaves the tree different from what was committed, runs `zizmor` (pinned `1.31.1`, `--offline`, medium and above fail) over `.github/workflows` (reproduce with `pip install zizmor==1.31.1` and `zizmor --offline --min-severity medium .github/workflows`), and the secret scan and the advisory audit are part of the one required status (a documentation-only change is scanned for secrets too). The workflow is read-only by default; only `static` (the docs heal push) and `validate` (the status) write. A branch name, a title or a body is never spliced into a shell line; it goes through `env`. The pull request's own title and body are checked with the commits for an assistant's credit (`check-provenance.cjs`, narrow marks so a change about model providers is not refused), and `check-added-files.cjs` refuses build output, caches, logs, installers and any file over 5 MiB. Every job has a time cap (30 minutes for the Linux checks, 45 for the Windows tests and the update job, 60 for the pack, longest real run about 14), npm and pip retry slow registries (`NPM_CONFIG_FETCH_RETRIES`, `PIP_RETRIES`), the scanner image pull is retried, and `pip-audit` is pinned. `static` and the documentation-only job refuse a pull request branch that does not contain the current `main` (`Branch contains the current main`), so the green status describes the merged result, not a stale head. A head that is already part of `main` (the pull request was merged while the run was starting) passes that step with a notice and the other checks still run on it, so an early merge no longer turns the whole run red. `scripts/advisory-audit.cjs` fails closed: npm's JSON error object, a missing vulnerability table or an empty pip-audit result is a failure, not "no findings", and a failed registry call is retried three times with a growing pause first. Drafts are skipped by `gate`, so a draft proves nothing: mark the pull request ready, wait for the green `PR Validation` status, and merge with Safe Merge, which enforces it (a merge from the GitHub page does not).

## 1c. Test audit

`node scripts/test-audit.cjs` classifies every Vitest file under `core/__tests__` and every `kernel/tests/test_*.py`. The default verdict is KEEP. Wording-only tests and duplicate behaviour tests are not kept; `actionlint-pin.test.ts` checks the indexed script before use and `full-spectrum-upgrade.test.ts` uses a fixture page. Files that still depend on an environment stay, with a visible skip, and a hermetic test beside them where one already exists.

| File | Needs | Verdict | Reason |
| --- | --- | --- | --- |
| `core/__tests__/actionlint-pin.test.ts` | hermetic | KEEP | Indexed workflow script is narrowed before `.source` is read. |
| `core/__tests__/full-spectrum-upgrade.test.ts` | hermetic | KEEP | Chart numbers come from a fixture page. |
| `core/__tests__/missing-skill-slugs.test.ts` | network | KEEP | `web.read` against example.com stays `skipIf(!ONLINE)` with a printed reason. The tender parser in the same file does not use the network. |
| `core/__tests__/connectors-oauth.test.ts` | network | KEEP | OAuth HTTP is the contract. A missing network skips; a wrong token fails. |
| `core/__tests__/mcp-platform.test.ts` | network | KEEP | Loopback and fetch fakes cover the contract. A live URL probe stays conditional. |
| `core/__tests__/usable-models.test.ts` | network | KEEP | Provider-page checks stay conditional. Pricing math does not use the clock. |
| `core/__tests__/release-engine.test.ts` | git history | KEEP | `skipIf(!HAS_COMMITTED_IDENTITY)` reads this clone only when it is a real git checkout. The uncommitted-stamp case uses a throwaway repository and always runs. |
| `core/__tests__/hub-revert-center.test.ts` | git branch | KEEP | History, detail, and the refusal cases use a throwaway repository. The branch create skips only when `git checkout -b` is refused, and the skip reason is printed. |
| `kernel/tests/test_desktop_tools.py` | POSIX desktop | KEEP | Windows desktop tools are checked on the owner's PC. The skip reason says so. |
| `kernel/tests/test_pyright_baseline.py` | pyright tool | KEEP | Under `CI` or `GITHUB_ACTIONS` a missing pyright fails. A workstation without the tool skips with a loud line. |

No wording-only test and no duplicate behaviour test was removed. Safety, release, installer, version, provenance, privacy, billing, undo, audit, and kill-switch tests stay in the files that already own them.

`core/__tests__/workflow-resolver.test.ts` resolves every `run:` command in the eleven workflows and the three composite actions: the npm script exists, the node, Python, or shell file exists, the action path exists, and each invoked script's `require` and shell-out targets exist.

## 1b. Minutes budget: what runs, and what never does

Hosted minutes are spent only where they buy evidence. Nothing below removes a
check or a protection; each rule only skips work whose result cannot change.

| Situation | What runs | What is skipped, and why that is safe |
| --- | --- | --- |
| Draft pull request | Secret scan only (about a minute; a leaked secret is leaked from any branch) | Gate, tests, CodeQL, audits and the Windows installer. A draft cannot be merged. The full run starts when the owner marks it ready for review. The gate's `if` is also required on every job that needs the gate, so a skipped gate cannot start Windows. |
| Change touching any code, config, workflow, script, skill, tool, agent, `CHANGELOG.md` or anything the installer packages | One workflow: `gate`, then in parallel `static` (typecheck, docs, version, provenance, lint, workflow lint, layout, audit), `kernel` (pytest and the pyright baseline), `tests-windows` (Vitest, two shards), `package-windows` (the full shared build pipeline and the installer lifecycle smoke) and `update-windows` (the update from the last published release), the last two side by side. `validate` publishes the `PR Validation` status from those five results plus the secret scan and the advisory audit. CodeQL on a public repository still runs. | A second workflow. Those checks used to run again as CI Fast and as a pull-request Security Scan. |
| Documentation only (decided by `scripts/pr-scope.cjs`) | `gate`, the Linux `docs-only` job (branch contains main, heal check, docs check, version check, type check, commit provenance, the full test suite, the same warn-only test note) publishing the same required `PR Validation` status, and the secret scan | `static`, `kernel`, `tests-windows`, `package-windows`, `update-windows`, CodeQL and the dependency audit. No file they read or package changed. |
| Manual `PR Validation` run with a `sha` (release evidence) | Always the full parallel validation | Nothing. |
| FRIDAY Test Build or FRIDAY Release, and this commit already has a successful `PR Validation` status from the last 7 days | Test Build still builds the EXE. FRIDAY Release still requires that green status before merge. Neither starts PR Validation again. | Typecheck and `npm test` inside Test Build, and the FRIDAY Release call of PR Validation. The tree has not changed since the green run. A pending run is waited on. A missing, failed, or older result calls PR Validation in the FRIDAY Release run. |
| FRIDAY Release `stage` publish | Cheap static gates, then a fresh-green check, then the Windows build. It does not re-run `npm test`. | The suite. A missing, stale, or red `PR Validation` stops publish before the build and before `gh release create`. A merge commit may reuse the pull-request parent when that parent has the same tree. |
| FRIDAY Release after `apply` or `heal` in prepare | Typecheck, then its own tests, because apply changed the tree | Nothing is reused for that new tree. The previous status belongs to a different commit. |
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
TypeScript. A major is a planned upgrade. The kernel pip ecosystem also ignores
minor and patch updates of `av`, because `av>=17.0.0,<19` is one hand-kept range
(`kernel/stt.py`, `scripts/verify-deps.cjs`) and Dependabot raising only its floor
broke both. Nothing auto-merges. Dependabot runs use a
read-only token and cannot publish the `PR Validation` status: run **PR Validation**
from the Actions tab with that commit's SHA.

Commit provenance allows that dependency-update account only when the author
or committer name is `dependabot[bot]` and the email is
`49699333+dependabot[bot]@users.noreply.github.com`, both exact. The same pair
may appear on a co-author trailer. A sign-off of `dependabot[bot]` with
`support@github.com` is allowed. The same name with any other email, and every
other bot, still fails. Any tool-named author or trailer, and a message
that says the change was generated, still fail.

The same rule reads three more things: a commit message or pull request text
that carries a `Generated with/by` line, a robot mark, a `claude.ai/code`
session link or a `Claude-Session` style trailer; and a file or folder an AI
tool leaves behind (`.claude/`, `.cursor/`, `.windsurf/`, `.codex/`, `.gemini/`,
`.continue/`, `.aider*`, `.cursorrules`, a Copilot instructions file under
`.github`, a Gemini rules file at the root) in `scripts/check-added-files.cjs`. Some pull request tools append
such a footer to the body on their own, so the body is read back after it is
written (AGENTS.md, Identity). `npm run setup:hooks` also installs a
`commit-msg` hook that refuses the same message on the owner's clone, and the
`pre-push` hook runs preflight; both are `sh` shims over a `.cjs` body because
the package is ESM.

**One open draft, then one validation.** `main` stays protected, so every change
is still a pull request. Work continues on the latest open draft into
`main`, and a new draft opens only when none exists. The owner marks that draft
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

| Symptom | Cause and fix |
| --- | --- |
| FRIDAY Release `pull request moved` | A push landed after the head was pinned. Re-run FRIDAY Release with `mode = auto`. |
| FRIDAY Release looks for `release/v` of the declared version after an explicit increment | The `plan` job pins the version `prepare` opens for that `mode` and `release_type`. Increment rules: [VERSIONING.md](../VERSIONING.md). From a never-published line an explicit patch, minor, major, or extreme moves that counter; `auto` ships the line as it stands. |
| Prepare: `GitHub Actions is not permitted to create or approve pull requests` | New repositories block this until Settings → Actions → General → Workflow permissions → **Allow GitHub Actions to create and approve pull requests** is on. The release branch is already pushed; open the pull request or enable the setting and re-run. Merging is a separate permission. |
| Prepare exits at once with `syntax error near unexpected token`, or `pin` fails with `no open release Pull Request exists` | The main-only guard must be a `[` test for `main`, a `[` test for `workflow_dispatch`, then `case` on `github.workflow_ref`. Prepare declares `MODE` and `RELEASE_TYPE` from `inputs` (a job env is not visible in another job); an empty mode is auto; if the plan chose prepare and the decision keeps the version or differs from the plan, prepare fails instead of exiting 0 without a pull request. |
| `startup_failure`: an action is not allowed because every action must be owned by `devendrarj25` | Checkout, Node, and Python come from `.github/actions` in this repository. CodeQL does not run until `github/codeql-action` is allowed under Settings → Actions → General. |
| `startup_failure`: `Actor is not allowed to trigger Actions workflows`, or PR Validation `startup_failure` with no jobs for `github-actions[bot]` or an app bot | Workflow execution protections refuse a bot actor before any job exists. FRIDAY Release calls PR Validation and Safe Merge with `workflow_call` in the same run, so the actor stays the person who clicked Run. A release pull request opened by the workflow token cannot start PR Validation itself; the same release run validates the pinned commit and Safe Merge reads that result. For a commit pushed by an app bot, the owner runs **PR Validation** from the Actions tab with that commit's SHA. |
| Workflow dispatch returns HTTP 403 (`actions=write`) | An integration token cannot start workflows. The owner starts them from the Actions tab. |
| `publish` exits at once with `spawnDirect is not a function` | `scripts/build-pipeline.cjs` calls `spawnDirect`; it must be in the `module.exports` of `scripts/win-spawn.cjs`. |
| `release-resume.test.ts` expected status 0, received 1 (Windows) | A `#!/bin/sh` stub named `gh` is not run on Windows (no shebang, `;` PATH delimiter, no PATHEXT). The stub is `gh.cmd` through `spawnDirect`, with `windowsVerbatimArguments` so cmd does not read doubled quotes as the program name. |
| Installer smoke: `Orphan FRIDAY is still running after the boot self-test` | The second boot's parent exits before `taskkill /T` reaches the reparented child. Smoke kills the tree after the parent exits, closes any process whose executable is under the install directory, ignores a process with no readable path, and fails with the pid and path if one remains after 8 seconds. |
| `packaged self-check: python failed (1)` | The embeddable zip ships no pip. The check writes the embed `._pth`, runs the pinned get-pip, then asks pip for its version. |
| Prepare the build environment: `Could not find a version that satisfies the requirement ctranslate2<5,>=4.0` | The newest runner Python had no wheel for `ctranslate2`. Setup prefers the newest installed series at or below `pythonWheelProven` in `config/toolchain-versions.json` and uses a newer one only when a pip dry run proves every kernel requirement installs from wheels ([FRIDAY_BUILD_AND_RELEASE.md](FRIDAY_BUILD_AND_RELEASE.md) section 8). |
| Local `npm run build:win` stops at `packaged self-check: stt-self-test failed (1)` | The embeddable `._pth` keeps the script folder off `sys.path`. `kernel/stt.py` puts its own folder on `sys.path`, and the failure line ends with the output tail. |
| PR Validation `package-windows`: `GitHub Personal Access Token is not set` | electron-builder 26 picks `onTagOrDraft` under `CI`. `scripts/electron-pack.cjs` passes `--publish never`; `gh release create` is the publisher. |
| `build` fails: `pack.bin` missing under `win-unpacked\resources` | extraResources `to` is relative to the resources directory; the `resources` entry omits `to`. |
| PR Validation `docs-only` fails plugin and module tests with `Cannot find module` or `FileNotFoundError` | The plugin sandbox must see the host path. Docker and Podman mount the workspace at the same host path with the network off; Windows keeps the single `/work` mount. |
| Safe Merge `startup_failure` and no jobs | `delete_branch` is a string (`true` or `false`), matching what FRIDAY Release sends; the required `confirm` input has no default. |
| `required check "PR Validation" has not reported` | Validation ran on a different SHA. |
| Safe Merge `GraphQL: Resource not accessible` | The token lacks `actions: read` (granted on `safe-merge.yml` and `repository-control.yml`). |
| Safe Merge `merge state is BLOCKED` | Required-check name mismatch (section 2). |
| Safe Merge `head branch is not a trusted work branch` | Prefix outside `scripts/merge-engine.cjs` `TRUSTED_HEAD`. |
| Safe Merge does nothing | `confirm` was not typed `MERGE`. |

Work is not repeated: PR Validation publishes a commit status and Safe Merge reads it. FRIDAY Test Build and FRIDAY Release call `scripts/validation-freshness.cjs` and reuse a success on that same commit from the last 7 days.

FRIDAY Release does not start a second release workflow. Prepare and publish are ordinary jobs in `release.yml`. The read-only jobs decide the step, pin the release pull request, and read the `PR Validation` commit status. The `validate` and `merge` jobs `uses` `pr-validation.yml` and `safe-merge.yml` and pass `caller: friday-release`; those workflows refuse any other caller. Inside a called workflow `github.event_name` stays the caller's event (never `workflow_call`), so the guard reads `github.workflow` (the caller's name, **FRIDAY Release**) and `github.workflow_ref` (this file). `workflow_dispatch` stays the only trigger. A manual `sha` and a FRIDAY Release pin check out that commit for the Windows job, the secret scan, CodeQL, and the advisory job. A draft release does not count as published. `stage=prepare` opens the release pull request and stops; `stage=publish` packs the version already on `main`; a rerun of the same stage resumes an existing branch, pull request, or draft release. The kernel `/version` test follows `config/friday-version.json`, so validation on the release pull request does not fail after prepare applies the planned number.

## 4. Research decisions

ADOPT means built as described, ADAPT means built in reduced form, REJECT means deliberately not built.

| Topic | Source | Decision | Reason | Where |
| --- | --- | --- | --- | --- |
| A workflow starting another with `gh workflow run` | [Workflow execution protections](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available), [reusable workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations) | ADAPT | The nested run is `github-actions[bot]` and is refused. FRIDAY Release calls PR Validation and Safe Merge with `workflow_call`; a called workflow can only keep or reduce the token. | `release.yml` |
| Personal access token secret to start workflows; a credential for app bots | Same | REJECT | A second credential and a second way to start workflows. A commit from the owner account starts `pull_request`. | none |
| A twelfth workflow; a second Linux test workflow | [AGENTS.md](../AGENTS.md) | REJECT | The Windows job is the full suite; drafts run only the secret scan. | none |
| Composite actions for checkout, Node, Python | [Node 20 removal](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/) | ADOPT | The Node 20 action runtime is gone and the allow-list permits only `devendrarj25` actions. `actions/setup-python`, `actions/checkout`, `actions/upload-artifact`, and `actions/attest` are not used. | `.github/actions/` |
| Windows interpreter contract | [Windows Server 2025 readme](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md) | ADAPT | The bundled-Python probe looks for `python/python.exe` on `win32` and `python/bin/python3` on POSIX, so a Linux run locks the Windows layout. The Python action puts the real interpreter directory on PATH; the selector asks `py -3.12` first and refuses the Store alias. | `core/__tests__`, Python action |
| `$/` for a same-repo composite action | [Changelog](https://github.blog/changelog/2026-07-30-reference-same-repository-actions-with-self-repository-syntax/), [metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax) | ADOPT | A Test Build on another ref runs that ref's checkout action; `$/` is the pin. | `uses: $/.github/actions/checkout` |
| actionlint and `$/` | [actionlint process.go](https://github.com/rhysd/actionlint/blob/v1.7.12/process.go), [issue 650](https://github.com/rhysd/actionlint/issues/650) | ADAPT | The linter reports `$/` as a missing ref, so only that message is ignored. On Windows the stdin write fills the 4 KiB pipe, so Windows passes an empty `-shellcheck` and runs shellcheck after the process starts. Findings still fail. | `scripts/run-actionlint.cjs` |
| SHA-pinning third-party actions | [SHA pinning policy](https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/) | REJECT here | No third-party `uses:`; checkout, Node, and Python live in this repo. | none |
| gitleaks tag plus digest | Docker Hub index | ADOPT | A tag alone can move. | `pr-validation.yml`, `security.yml` |
| Skip duplicate Linux gates when the merge tree matches the pin | Pin job output `head` | ADAPT | Publish still runs the Windows pack, notes guard, and version verify. A different tree fails closed. | publish job |
| Content-addressed toolchain cache with explicit offline miss | `scripts/stage-toolchain.cjs` | ADOPT | Cache hit is the SHA-256 file; `--offline` never fetches. | pipeline |
| Splitting a release asset above 2 GiB | Third-party splitter | REJECT | A second publisher. The ceiling is under 2147483648. | `installerBounds` |
| Free-text workflow input inside `run` | [Secure use reference](https://docs.github.com/en/actions/reference/secure-use-reference), [script injections](https://docs.github.com/en/actions/concepts/security/script-injections) | ADOPT | Inputs reach scripts only as env variables (`$OWNER_NOTES`, `$RELEASE_TITLE`, `$CONFIRM`); `${{ env.NAME }}` inside `run` is still injection. | all four workflows |
| Windows default `run` shell is cmd | [Runner shell ADR 0277](https://github.com/actions/runner/blob/main/docs/adrs/0277-run-action-shell-options.md) | ADOPT | Bash steps declare `shell: bash`. | workflows |
| `.cmd` spawn on Windows | [child_process](https://nodejs.org/api/child_process.html), [CVE-2024-27980](https://github.com/nodejs/node/commit/64b67779f7), [cmd.exe](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd) | ADOPT | `cmd.exe /d /s /c` with `windowsVerbatimArguments`; `%` is doubled; `cross-spawn` is REJECTED as a second implementation. | `scripts/win-spawn.cjs` |
| GNU tar archive name with a drive colon | GNU tar 1.35 `--force-local` | ADOPT | The archive argument is the basename with the cwd set to its directory; `--force-local` only when the basename still has a colon. | `localTar` |
| One quoted token per `npm.cmd` argument | Node `lib/child_process.js` | ADOPT | npm starts as `node` plus `npm-cli.js`; the joined line is the fallback. | `npmPlan` |
| Retry deleting a temp directory | Node `fs.rm` `maxRetries` | ADOPT | Windows reports EBUSY or EPERM while a handle is open; `rimraf` is not added. | test temp helper, `removeTree` |
| Retrying a green Vitest process when a worker exits; 8.3 short names | [forks teardown](https://github.com/go-to-k/cdk-local/issues/402), [MAX_PATH](https://learn.microsoft.com/en-us/troubleshoot/windows-server/backup-and-storage/cannot-delete-file-folder-on-ntfs-file-system) | REJECT | A retry hides a real crash; 8.3 can be disabled. Long paths use the `\\?\` prefix in `electron/toolchain-pack.cjs`. | none |
| Vitest failure report | Allow-list | ADAPT | The job summary lists the failed test and the reproduction command; a runtime-token upload runs only when the token is present. | `scripts/vitest-failure-summary.cjs` |

## 5. Owner publish and acceptance steps

The click-by-click publish and the acceptance list are in [RELEASE.md](../RELEASE.md). In short: PR Validation green on the pull request head, the owner merges, then FRIDAY Release `stage` `publish` runs only when the line on `main` is not already a GitHub release; it stops unless a fresh green PR Validation exists for that tree and never replaces an existing release (`mode` `rebuild` is the only input that does). The same tree can be packed on a Windows PC with `npm run build:win` (expect `release\FRIDAY-Setup-1.1.4.6.exe`, `release\FRIDAY-Portable-1.1.4.6.exe`, and `release\win-unpacked\resources\toolchain\python-embed\pack.bin`). That local pack is not a GitHub release. A Linux run does not prove the Windows CMD pack, install, boot, update, rollback, uninstall, signing, SmartScreen, the microphone, or a real MCP client.
