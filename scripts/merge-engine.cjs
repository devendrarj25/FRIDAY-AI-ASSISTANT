/**
 * FRIDAY - safe merge & maintenance engine
 *
 * Pure, testable decision logic shared by:
 *   .github/workflows/safe-merge.yml   (manual safe merge of eligible PRs)
 *   .github/workflows/maintenance.yml  (safe branch / release / run cleanup)
 *
 * This file decides NOTHING about versions, builds or releases - that stays in
 * scripts/release-engine.cjs. It only answers two questions:
 *
 *   1. "Is this pull request safe to merge into main right now?"
 *   2. "Which branches, releases, artifacts and runs are safe to remove?"
 *
 * Every rule here fails closed: anything unknown, unverified or protected is
 * refused / kept, never merged and never deleted.
 */

"use strict";

const fs = require("node:fs");
// The ONE definition of "a required check passed on this exact commit",
// shared with Official Publish and scripts/orchestrator-engine.cjs.
const contract = require("./check-contract.cjs");
const { compareVersions } = require("./release-engine.cjs");

/** Branches that may never be deleted and may never be merged away. */
const PROTECTED_BRANCHES = ["main", "master", "develop", "development", "release"];

/** Head branches this project trusts as merge sources into main. */
const TRUSTED_HEAD =
  /^(feature|fix|bugfix|hotfix|upgrade|change|modify|chore|docs|refactor|perf|test|ci|build|revert|restore|release|dev)\//;

const RELEASE_BRANCH = /^release\/v\d+\.\d+\.\d+(?:\.\d+)?$/;

const compareReleaseBranches = (a, b) => {
  const va = String(a || "").replace(/^release\/v/i, "");
  const vb = String(b || "").replace(/^release\/v/i, "");
  if (!va || !vb) return 0;
  return compareVersions(va, vb);
};

const isProtectedBranch = (branch) =>
  PROTECTED_BRANCHES.includes(
    String(branch || "")
      .trim()
      .toLowerCase(),
  ) || String(branch || "").startsWith("recovery/");

/** A GitHub check/status conclusion that counts as "passed". */
const PASSED = new Set(["success", "neutral", "skipped"]);
/** Still running - never mergeable yet. */
const RUNNING = new Set([
  "queued",
  "in_progress",
  "pending",
  "waiting",
  "requested",
  "expected",
  "",
]);

/**
 * Normalise `gh pr view --json ...` check rollup entries into
 * { name, conclusion, sha }.
 */
function normaliseChecks(checks = []) {
  return (checks || []).filter(Boolean).map((c) => ({
    name: String(c.name || c.context || c.workflowName || "check"),
    conclusion: String(c.conclusion || c.state || c.status || "").toLowerCase(),
    status: String(c.status || "").toLowerCase(),
    sha: String(c.sha || c.headSha || ""),
  }));
}

/**
 * Decide whether one pull request may be merged into main.
 *
 * @param {object} pr        gh pr view JSON (number, baseRefName, headRefName,
 *                           state, isDraft, mergeable, mergeStateStatus,
 *                           headRefOid, headRepositoryOwner, statusCheckRollup)
 * @param {object} [opts]
 * @param {string[]} [opts.requiredChecks] check names that MUST be present and green
 * @param {string}  [opts.repositoryOwner] owner of this repository (fork guard)
 * @param {string}  [opts.latestSha]       head sha observed right before merging
 * @returns {{eligible: boolean, reasons: string[], number: number, branch: string, release: boolean}}
 */
function evaluatePullRequest(pr, opts = {}) {
  const reasons = [];
  const branch = String(pr?.headRefName || "");
  const base = String(pr?.baseRefName || "");
  const state = String(pr?.state || "").toUpperCase();
  const mergeable = String(pr?.mergeable || "").toUpperCase();
  const mergeState = String(pr?.mergeStateStatus || "").toUpperCase();

  if (!pr || !pr.number) reasons.push("pull request could not be read");
  if (base !== "main") reasons.push(`base branch is '${base || "unknown"}', not main`);
  if (state !== "OPEN") reasons.push(`pull request is ${state || "unknown"}, not OPEN`);
  if (pr?.isDraft) reasons.push("pull request is a draft");
  if (mergeable === "CONFLICTING") reasons.push("pull request has merge conflicts");
  if (mergeable === "UNKNOWN") reasons.push("GitHub has not finished computing mergeability");
  if (["DIRTY", "BLOCKED", "BEHIND"].includes(mergeState)) {
    // BLOCKED is almost always a repository setting, not a code problem: main's
    // ruleset requires a status check whose name does not match the one this
    // repository really publishes ("PR Validation"). Say so, so the owner does
    // not go looking for a bug in the workflows.
    reasons.push(
      mergeState === "BLOCKED"
        ? "merge state is BLOCKED - GitHub branch protection is still refusing this pull request (usually a required status check name in Settings > Branches that does not exactly match 'PR Validation'; see docs/FRIDAY_GITHUB_ACTIONS.md)"
        : `merge state is ${mergeState}`,
    );
  }

  if (isProtectedBranch(branch))
    reasons.push(`'${branch}' is a protected branch and is never merged away`);
  else if (!TRUSTED_HEAD.test(branch))
    reasons.push(`head branch '${branch}' is not a trusted work branch`);
  if (
    RELEASE_BRANCH.test(branch) &&
    opts.latestReleaseBranch &&
    compareReleaseBranches(branch, opts.latestReleaseBranch) < 0
  ) {
    reasons.push(`release is superseded by newer ${opts.latestReleaseBranch}`);
  }

  const owner = String(opts.repositoryOwner || "");
  const headOwner = String(pr?.headRepositoryOwner?.login || pr?.headRepositoryOwner || owner);
  if (owner && headOwner && headOwner !== owner) {
    reasons.push(`head repository owner '${headOwner}' is untrusted (fork)`);
  }

  const headSha = String(pr?.headRefOid || "");
  if (opts.latestSha && headSha && opts.latestSha !== headSha) {
    reasons.push("pull request moved while it was being evaluated");
  }

  const checks = normaliseChecks(pr?.statusCheckRollup);
  if (!checks.length) reasons.push("no validation checks have reported for this pull request");
  for (const check of checks) {
    if (headSha && check.sha && check.sha !== headSha) {
      reasons.push(`check '${check.name}' ran on an older commit`);
      continue;
    }
    if (
      RUNNING.has(check.conclusion) ||
      (check.status && check.status !== "completed" && !check.conclusion)
    ) {
      reasons.push(`check '${check.name}' is still running`);
    } else if (!PASSED.has(check.conclusion)) {
      reasons.push(`check '${check.name}' concluded '${check.conclusion || "unknown"}'`);
    }
  }

  // Required checks are evaluated through the SHARED contract, against the
  // REAL commit each check ran on. `statusCheckRollup` does not report a
  // commit, so a caller that wants required checks enforced must hand in the
  // per-commit check runs (`/commits/<sha>/check-runs` + `/status`), which do.
  // Anything else - stale, unknown commit, similarly named check - is refused.
  const evidence = Array.isArray(opts.checkRuns) ? opts.checkRuns : checks;
  for (const required of opts.requiredChecks || []) {
    const verdict = contract.evaluateRequiredCheck({ headSha, checks: evidence, required });
    if (!verdict.ready) reasons.push(verdict.reason);
  }

  return {
    number: Number(pr?.number || 0),
    branch,
    release: RELEASE_BRANCH.test(branch),
    eligible: reasons.length === 0,
    reasons,
  };
}

/**
 * Pick the candidate pull requests for a safe-merge run.
 *
 * scope:
 *   auto     - every eligible PR targeting main
 *   selected - only the numbers given (still fully validated)
 *   release  - only release/vX.Y.Z PRs
 */
function selectPullRequests(prs, { scope = "auto", numbers = [] } = {}) {
  const wanted = (numbers || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const list = (prs || []).filter(Boolean);
  if (scope === "selected") {
    if (!wanted.length) return [];
    return list.filter((p) => wanted.includes(Number(p.number)));
  }
  if (scope === "release")
    return list.filter((p) => RELEASE_BRANCH.test(String(p.headRefName || "")));
  return list;
}

/** Parse "12, #14 15" into [12, 14, 15]. */
const parseNumbers = (value) =>
  String(value || "")
    .split(/[^0-9]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);

/**
 * Safe cleanup plan.
 *
 * Nothing that is current, protected, unmerged or still referenced is ever
 * proposed for deletion:
 *   - branches: only merged, non-protected, non-recovery work branches that
 *     have no open pull request (an open PR always means live work)
 *   - test releases: prereleases only, newest TEST release always kept
 *   - official releases: newest `keepOfficial` always kept, current never touched
 *   - runs: newest `keepRuns` per workflow always kept; running runs never touched
 */
function planCleanup(input = {}, policy = {}) {
  const keepOfficial = Number.isFinite(policy.keepOfficial) ? policy.keepOfficial : 3;
  const keepTest = Number.isFinite(policy.keepTest) ? policy.keepTest : 1;
  const keepRuns = Number.isFinite(policy.keepRuns) ? policy.keepRuns : 15;
  const current = String(policy.currentTag || "");

  // A branch that still has an OPEN pull request is live work, even when every
  // one of its commits is already an ancestor of main (a freshly cut release
  // branch is exactly that until Prepare pushes its first commit). Deleting it
  // would race Safe Merge / Official Publish, so it is never proposed here.
  const openBranches = new Set(
    (input.openPullRequestBranches || []).map((n) => String(n || "")).filter(Boolean),
  );
  const branches = (input.branches || [])
    .filter(
      (b) =>
        b &&
        b.merged &&
        !isProtectedBranch(b.name) &&
        !b.openPullRequest &&
        !openBranches.has(String(b.name)),
    )
    .map((b) => b.name);

  const releases = (input.releases || []).filter((r) => r && r.tagName && !r.isDraft);
  const byNewest = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""));

  const test = releases.filter((r) => r.isPrerelease).sort(byNewest);
  const official = releases.filter((r) => !r.isPrerelease).sort(byNewest);

  const staleTest = test.slice(Math.max(keepTest, 1)).map((r) => r.tagName);
  const staleOfficial = official.slice(Math.max(keepOfficial, 1)).map((r) => r.tagName);

  const perWorkflow = new Map();
  for (const run of (input.runs || []).filter(Boolean)) {
    const key = String(run.workflowName || run.name || "workflow");
    if (!perWorkflow.has(key)) perWorkflow.set(key, []);
    perWorkflow.get(key).push(run);
  }
  const runs = [];
  for (const list of perWorkflow.values()) {
    list.sort(byNewest);
    for (const run of list.slice(Math.max(keepRuns, 1))) {
      const status = String(run.status || "").toLowerCase();
      if (status && status !== "completed") continue; // never touch a live run
      runs.push(Number(run.databaseId || run.id));
    }
  }

  return {
    branches,
    testReleases: staleTest.filter((t) => t !== current),
    officialReleases: staleOfficial.filter((t) => t !== current),
    runs: runs.filter((n) => Number.isFinite(n) && n > 0),
    kept: {
      official: official.slice(0, Math.max(keepOfficial, 1)).map((r) => r.tagName),
      test: test.slice(0, Math.max(keepTest, 1)).map((r) => r.tagName),
      runsPerWorkflow: Math.max(keepRuns, 1),
    },
  };
}

module.exports = {
  PROTECTED_BRANCHES,
  RELEASE_BRANCH,
  TRUSTED_HEAD,
  isProtectedBranch,
  evaluatePullRequest,
  selectPullRequests,
  parseNumbers,
  planCleanup,
};

// ---- CLI -------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "evaluate";
  const flag = (name, fallback = "") => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };

  if (cmd === "evaluate") {
    // node scripts/merge-engine.cjs evaluate --prs prs.json --scope auto \
    //   [--numbers "12,14"] [--owner devendrarj25] [--required "PR Validation"]
    const prs = readJson(flag("prs"), []);
    const scope = flag("scope", "auto");
    const numbers = parseNumbers(flag("numbers"));
    const required = flag("required")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const owner = flag("owner");
    const selected = selectPullRequests(prs, { scope, numbers });
    const latestReleaseBranch =
      flag("latest-release-branch") ||
      prs
        .map((pr) => String(pr?.headRefName || ""))
        .filter((branch) => RELEASE_BRANCH.test(branch))
        .sort((a, b) => compareReleaseBranches(b, a))[0] ||
      "";
    // Per-commit check evidence: { "<head sha>": [ check runs / statuses ] }.
    // Only this carries a real head_sha, so only this can prove that a required
    // check ran on the exact commit that is about to be merged.
    const checkRunsBySha = readJson(flag("check-runs"), {}) || {};
    const decisions = selected.map((pr) =>
      evaluatePullRequest(pr, {
        requiredChecks: required,
        repositoryOwner: owner,
        latestReleaseBranch,
        checkRuns: checkRunsBySha[String(pr?.headRefOid || "")],
      }),
    );
    process.stdout.write(`${JSON.stringify({ scope, latestReleaseBranch, decisions }, null, 2)}\n`);
  } else if (cmd === "cleanup") {
    // node scripts/merge-engine.cjs cleanup --branches b.json --releases r.json \
    //   --runs runs.json [--keep-official 3] [--keep-test 1] [--keep-runs 15] [--current v1.3.2]
    const plan = planCleanup(
      {
        branches: readJson(flag("branches"), []),
        releases: readJson(flag("releases"), []),
        runs: readJson(flag("runs"), []),
        // Head branches of every OPEN pull request - never deletable.
        openPullRequestBranches: readJson(flag("open-prs"), []).map((p) =>
          typeof p === "string" ? p : String(p?.headRefName || ""),
        ),
      },
      {
        keepOfficial: Number(flag("keep-official", "3")),
        keepTest: Number(flag("keep-test", "1")),
        keepRuns: Number(flag("keep-runs", "15")),
        currentTag: flag("current"),
      },
    );
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}
