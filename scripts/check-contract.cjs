/**
 * FRIDAY - the ONE definition of "a required check passed on this commit".
 *
 * Official Publish (.github/workflows/official-publish.yml), Safe Merge
 * (.github/workflows/safe-merge.yml), Repository Control merge
 * (.github/workflows/repository-control.yml), scripts/orchestrator-engine.cjs
 * and scripts/merge-engine.cjs all evaluate GitHub checks. They must never
 * disagree, so every one of them evaluates them THROUGH THIS FILE.
 *
 * Two facts about GitHub decide the whole contract:
 *
 *   1. A workflow's check run is usually exposed as the composite name
 *      "<workflow name> / <job name>", e.g. "PR Validation / validate", while a
 *      commit status is exposed under its bare context. A required check named
 *      "PR Validation" must therefore accept both - and nothing else. A check
 *      called "PR Validation something else" is a DIFFERENT check and never
 *      satisfies the requirement.
 *
 *   2. `gh pr view --json statusCheckRollup` does NOT report which commit a
 *      check ran on. The only trustworthy source is the per-commit API
 *      (`/commits/<sha>/check-runs` and `/commits/<sha>/status`), whose entries
 *      carry a real `head_sha`. This file never invents a sha: a check whose
 *      real commit is unknown or different can never satisfy a requirement.
 */

"use strict";

const squash = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ");

/** Conclusions that count as "passed". */
const PASSED = new Set(["success", "neutral", "skipped"]);
/** Statuses/conclusions that mean "not finished yet". */
const RUNNING = new Set(["queued", "in_progress", "pending", "waiting", "requested", "expected"]);

/**
 * Does `name` satisfy the logical requirement `required`?
 *
 *   "PR Validation"              vs "PR Validation" -> true  (exact)
 *   "PR Validation / validate"   vs "PR Validation" -> true  (workflow / job)
 *   "PR Validation / validate (windows)" vs same    -> true  (matrix job)
 *   "PR Validation something else" vs same          -> false (different check)
 *   "Other / PR Validation"      vs same            -> false (different workflow)
 */
function matchesRequiredCheck(name, required) {
  const actual = squash(name);
  const want = squash(required);
  if (!actual || !want) return false;
  if (actual.toLowerCase() === want.toLowerCase()) return true;
  const slash = actual.indexOf("/");
  if (slash < 0) return false;
  return squash(actual.slice(0, slash)).toLowerCase() === want.toLowerCase();
}

/**
 * Normalise anything GitHub can hand us into
 * `{ name, status, conclusion, sha, url }` WITHOUT inventing a commit.
 *
 * Accepts check-run objects (`name`, `status`, `conclusion`, `head_sha`),
 * commit statuses (`context`, `state`, `sha`) and `gh` camelCase rollups.
 */
function normaliseChecks(checks = []) {
  return (checks || []).filter(Boolean).map((c) => ({
    name: squash(c.name || c.context || c.workflowName || "check"),
    status: String(c.status || "").toLowerCase(),
    conclusion: String(c.conclusion || c.state || "").toLowerCase(),
    sha: String(c.head_sha || c.headSha || c.sha || c.commitSha || ""),
    url: String(c.detailsUrl || c.details_url || c.targetUrl || c.target_url || c.url || ""),
  }));
}

/** passed | pending | failed - for one already normalised check. */
function checkState(check) {
  const status = String(check?.status || "").toLowerCase();
  const conclusion = String(check?.conclusion || "").toLowerCase();
  if (status && status !== "completed") return "pending";
  if (RUNNING.has(conclusion)) return "pending";
  if (PASSED.has(conclusion)) return "passed";
  if (!conclusion) return "pending";
  return "failed";
}

/**
 * Evaluate one required check against the checks reported for a commit.
 *
 * @param {object}   input
 * @param {string}   input.headSha   the exact commit that must have been validated
 * @param {object[]} input.checks    raw checks (any of the shapes above)
 * @param {string}   input.required  the logical required check name
 * @returns {{ready:boolean, failed:boolean, reason:string, matched:object[], observed:object[]}}
 */
function evaluateRequiredCheck({ headSha, checks = [], required = "PR Validation" } = {}) {
  const head = String(headSha || "");
  const observed = normaliseChecks(checks);
  if (!head) {
    return {
      ready: false,
      failed: true,
      reason: "no head commit was pinned - a check can never be trusted without its commit",
      matched: [],
      observed,
    };
  }

  const onHead = observed.filter((c) => c.sha && c.sha === head);
  const matched = onHead.filter((c) => matchesRequiredCheck(c.name, required));

  if (!matched.length) {
    const stale = observed.filter(
      (c) => matchesRequiredCheck(c.name, required) && c.sha && c.sha !== head,
    );
    const unknown = observed.filter((c) => matchesRequiredCheck(c.name, required) && !c.sha);
    let reason = `required check "${required}" has not reported for ${head}`;
    if (stale.length) {
      reason += ` (it only ran on ${[...new Set(stale.map((c) => c.sha))].join(", ")} - a stale result never counts)`;
    } else if (unknown.length) {
      reason += " (a matching check reported no commit and cannot be trusted)";
    }
    return { ready: false, failed: false, reason, matched: [], observed };
  }

  const failing = matched.filter((c) => checkState(c) === "failed");
  if (failing.length) {
    return {
      ready: false,
      failed: true,
      reason: `required check failed on ${head}: ${failing
        .map((c) => `${c.name} (${c.conclusion || "unknown"})`)
        .join(", ")}`,
      matched,
      observed,
    };
  }
  const pending = matched.filter((c) => checkState(c) === "pending");
  if (pending.length) {
    return {
      ready: false,
      failed: false,
      reason: `required check still running on ${head}: ${pending.map((c) => c.name).join(", ")}`,
      matched,
      observed,
    };
  }

  // Any OTHER check that really ran on this commit and failed also blocks.
  const otherFailed = onHead.filter(
    (c) => !matchesRequiredCheck(c.name, required) && checkState(c) === "failed",
  );
  if (otherFailed.length) {
    return {
      ready: false,
      failed: true,
      reason: `other checks failed on ${head}: ${otherFailed.map((c) => c.name).join(", ")}`,
      matched,
      observed,
    };
  }

  return {
    ready: true,
    failed: false,
    reason: `"${required}" passed on ${head} (${matched.map((c) => c.name).join(", ")})`,
    matched,
    observed,
  };
}

/** A compact, human-readable dump of everything that was observed. */
function describeChecks(observed = [], headSha = "") {
  if (!observed.length) return "no checks were reported at all";
  return observed
    .map(
      (c) =>
        `${c.name}: ${checkState(c)} (${c.status || "?"}/${c.conclusion || "?"}) on ${
          c.sha
            ? `${c.sha}${headSha && c.sha !== headSha ? " [WRONG COMMIT]" : ""}`
            : "unknown commit"
        }`,
    )
    .join("\n");
}

module.exports = {
  PASSED,
  RUNNING,
  matchesRequiredCheck,
  normaliseChecks,
  checkState,
  evaluateRequiredCheck,
  describeChecks,
};

// node scripts/check-contract.cjs --head <sha> --checks <file.json> [--required "PR Validation"]
// Exit 0 when the required check passed on that commit. Exit 1 while it is
// missing or still running. Exit 2 when a check on that commit failed.
if (require.main === module) {
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  const flag = (name, fallback = "") => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const head = flag("head");
  const required = flag("required", "PR Validation");
  let checks = [];
  try {
    checks = JSON.parse(fs.readFileSync(flag("checks"), "utf8"));
  } catch {
    checks = [];
  }
  const verdict = evaluateRequiredCheck({ headSha: head, checks, required });
  process.stdout.write(`${verdict.reason}\n`);
  if (!verdict.ready) {
    process.stderr.write(`${describeChecks(verdict.observed, head)}\n`);
    process.exit(verdict.failed ? 2 : 1);
  }
}
