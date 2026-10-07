// FRIDAY - Official Publish orchestration decisions.
//
// This file owns NO release behaviour of its own. It only answers one
// question, deterministically and fail-closed:
//
//   given the real repository state, what is the next safe step of the
//   existing prepare -> validate -> Safe Merge -> publish pipeline?
//
// Every actual action (versioning, changelog, build, tag, release, merge) is
// still performed by the existing workflows: .github/workflows/release.yml and
// .github/workflows/safe-merge.yml. The orchestrator only sequences them.
const engine = require("./release-engine.cjs");
const contract = require("./check-contract.cjs");

const clean = (value) => String(value || "").replace(/^v/i, "");
const isStable = (value) => engine.isStableVersion(value);

/**
 * Decide the next orchestration step.
 *
 *   mode        auto | update | rebuild (the same three modes release.yml has)
 *   mainVersion public FRIDAY version on the current main commit
 *               (config/friday-version.json releaseVersion; not the npm encoding)
 *   prepared    release/vX.Y.Z pull requests: { number, version, state }
 *   released    stable versions/tags that already exist
 *
 * Returns one of:
 *   { step: "rebuild" }  publish the declared version's assets again
 *   { step: "prepare" }  no valid prepared release exists yet - prepare one
 *   { step: "merge" }    a prepared release PR exists - validate then merge it
 *   { step: "publish" }  main already carries the prepared release - publish
 *   { step: "error" }    unsafe/ambiguous state - stop with an actionable reason
 */
/**
 * When prepare will open a release pull request, pin the version that
 * release-engine decide chooses. A changelog heading is not a successful
 * publish. The same release type retries the unpublished number. A different
 * explicit type skips it. The workflow still only sequences; apply, notes
 * and the pull request stay in release.yml.
 */
function alignPreparedVersion(
  plan,
  {
    mode = "auto",
    mainVersion,
    released = [],
    releaseType = "auto",
    tags = [],
    changelogBody = "",
  } = {},
) {
  if (!plan || plan.step !== "prepare") return plan;
  const type = String(releaseType || "auto").toLowerCase();
  if (type === "auto" || type === "rebuild") return plan;
  const declared = clean(mainVersion);
  const baseline = engine.releaseBaseline({
    releases: released,
    tags,
    declared,
  });
  void changelogBody;
  const decision = engine.decideRelease({
    mode,
    current: declared,
    baseline: baseline.version,
    type,
    subjects: [],
    released: released.map(clean),
  });
  if (decision.action === "error") {
    return {
      step: "error",
      version: declared,
      publishMode: plan.publishMode || mode,
      prNumber: null,
      reason: decision.reason,
    };
  }
  if (decision.action === "update" && decision.version) {
    return { ...plan, version: decision.version, reason: decision.reason };
  }
  return plan;
}

function orchestrationPlan({
  mode = "auto",
  mainVersion,
  prepared = [],
  released = [],
  releaseType = "auto",
  tags = [],
  changelogBody = "",
} = {}) {
  const declared = clean(mainVersion);
  if (!isStable(declared)) {
    return { step: "error", reason: "main does not declare a valid FRIDAY version" };
  }
  const published = (released || []).map(clean).filter(Boolean);
  const state = engine.resolvePreparedState({ current: declared, prepared });

  if (mode === "rebuild") {
    return {
      step: "rebuild",
      version: declared,
      publishMode: "rebuild",
      prNumber: null,
      reason: `rebuild requested - republishing the assets of v${declared} without any version change`,
    };
  }

  if (mode !== "auto" && mode !== "update") {
    return { step: "error", reason: `unknown release mode "${mode}"` };
  }

  // revision is the same as rebuild: the number stays, the pack is for a check.
  if (engine.normalizeReleaseType(releaseType) === "rebuild") {
    return {
      step: "rebuild",
      version: declared,
      publishMode: "rebuild",
      prNumber: null,
      reason: `revision keeps v${declared} — same number, packed again for a check`,
    };
  }

  if (state.ambiguous) {
    return {
      step: "error",
      version: declared,
      reason: `${state.conflicts.join("; ")} - release state is ambiguous; reconcile the release Pull Requests and run Official Publish again.`,
    };
  }

  const open = state.latestOpen;
  const baseline = engine.releaseBaseline({
    releases: published,
    tags,
    declared,
  }).version;
  const keepsFailed = (version) => {
    const retry = engine.unpublishedRetry({
      declared: version,
      baseline,
      released: published,
      type: releaseType,
    });
    return !retry.unpublished || retry.reuse;
  };
  const pin = (plan) =>
    alignPreparedVersion(plan, {
      mode,
      mainVersion: declared,
      released,
      releaseType,
      tags,
      changelogBody,
    });
  const skipFailed = (version) =>
    pin({
      step: "prepare",
      version: null,
      prNumber: null,
      publishMode: mode,
      reason:
        `v${version} was not published, and this run asked for a different release type — ` +
        "that attempt is skipped and the next version is taken from the last successful publish",
    });

  // A prepared release PR that is newer than main: reuse it when this run
  // asks for the same release type. A different type skips the failed attempt.
  if (open && engine.compareVersions(open.version, declared) > 0) {
    if (!keepsFailed(open.version)) return skipFailed(open.version);
    return {
      step: "merge",
      version: open.version,
      prNumber: open.number,
      publishMode: mode,
      superseded: state.superseded.map((p) => ({ number: p.number, version: p.version })),
      reason: `reusing the prepared release Pull Request #${open.number} for v${open.version}`,
    };
  }

  // Unpublished version whose own release PR is still open: merge it
  // (PR Validation + Safe Merge), never skip the merge-proof, unless this
  // run asked for a different release type.
  if (open && open.version === declared && !state.mergedCurrent) {
    if (!keepsFailed(declared)) return skipFailed(declared);
    return {
      step: "merge",
      version: declared,
      prNumber: open.number,
      publishMode: mode,
      reason:
        `release Pull Request #${open.number} for v${declared} is open — ` +
        "waiting for PR Validation then Safe Merge (never a force-merge)",
    };
  }

  // main already carries a prepared, merged, unpublished version.
  if (!published.includes(declared) && state.mergedCurrent) {
    if (!keepsFailed(declared)) return skipFailed(declared);
    return {
      step: "publish",
      version: declared,
      prNumber: state.mergedCurrent.number,
      publishMode: mode,
      reason: `main already carries merged, unpublished v${declared} - publishing it as-is`,
    };
  }

  // Unpublished version on main with no release/vX.Y.Z PR: prepare must
  // open that PR. Publishing without it fails the intentional merge-proof.
  if (!published.includes(declared) && !open) {
    return pin({
      step: "prepare",
      version: declared,
      prNumber: null,
      publishMode: mode,
      reason:
        `main declares unreleased v${declared} with no release/v${declared} PR — ` +
        "prepare will open that PR so publish can prove it was merged",
    });
  }

  // mode=auto with release_type=auto does not invent the next number.
  // An explicit patch, minor, major, or extreme still prepares that level.
  const requested = engine.normalizeReleaseType(releaseType);
  if (mode === "auto" && (!requested || requested === "auto") && published.includes(declared)) {
    return {
      step: "error",
      version: declared,
      publishMode: "auto",
      prNumber: null,
      reason:
        `auto keeps v${declared}. It is already published, so this run does not invent the next number. ` +
        "Choose mode update and release type auto to follow the changes, name patch, minor, major, or extreme to move that one counter, or rebuild to pack this version again.",
    };
  }

  return pin({
    step: "prepare",
    version: null,
    prNumber: null,
    publishMode: mode,
    reason: published.includes(declared)
      ? `v${declared} is already released - a new release must be prepared from the real changes`
      : "no prepared release Pull Request exists - preparing one",
  });
}

/**
 * Are the required checks of a pull request finished and green, ON THE EXACT
 * head commit? This is the SAME authority Safe Merge uses
 * (scripts/check-contract.cjs): unknown, missing, stale, pending and failing all
 * mean "not ready", never "merge anyway". A successful check from an older
 * commit, from another branch, or from a merely similarly named check can never
 * satisfy the requirement.
 */
function checksVerdict({ headSha, checks = [], required = "PR Validation" } = {}) {
  const verdict = contract.evaluateRequiredCheck({ headSha, checks, required });
  return {
    ready: verdict.ready,
    failed: verdict.failed,
    reason: verdict.reason,
    headSha: String(headSha || ""),
    required: String(required),
    observed: verdict.observed,
    diagnostic: contract.describeChecks(verdict.observed, String(headSha || "")),
  };
}

/**
 * Pin the exact prepared pull request.
 *
 * Official Publish must operate on the release Pull Request its own Prepare
 * stage produced - never on "the newest release PR that happens to be open".
 * When a version was pinned, only that version may be adopted; anything else
 * (missing, duplicated, closed, or a concurrently created different release PR)
 * is refused instead of silently substituted.
 *
 * @param {object}   input
 * @param {string}  [input.expectedVersion] the version Prepare planned, if known
 * @param {object[]} input.open             open release PRs
 *                   ({ number, version, headSha, state, url })
 */
function pinPreparedPullRequest({ expectedVersion = "", open = [] } = {}) {
  const want = clean(expectedVersion);
  const list = (open || [])
    .filter(Boolean)
    .map((p) => ({
      number: Number(p.number || 0),
      version: clean(p.version),
      headSha: String(p.headSha || p.headRefOid || ""),
      url: String(p.url || ""),
      state: String(p.state || "open").toLowerCase(),
    }))
    .filter((p) => p.number > 0 && isStable(p.version));

  if (!list.length) {
    return { ok: false, reason: "no open release Pull Request exists - nothing can be merged" };
  }

  const candidates = want ? list.filter((p) => p.version === want) : list;
  if (want && !candidates.length) {
    return {
      ok: false,
      reason: `the prepared release v${want} has no open Pull Request (open: ${list
        .map((p) => `#${p.number} v${p.version}`)
        .join(", ")}) - it was closed or never created`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `${candidates.length} release Pull Requests claim the same release (${candidates
        .map((p) => `#${p.number} v${p.version}`)
        .join(", ")}) - reconcile them before publishing`,
    };
  }
  if (!want && list.length > 1) {
    return {
      ok: false,
      reason: `several release Pull Requests are open (${list
        .map((p) => `#${p.number} v${p.version}`)
        .join(", ")}) and no prepared version was pinned - refusing to guess`,
    };
  }

  const pr = candidates[0];
  if (!/^[0-9a-f]{7,40}$/i.test(pr.headSha)) {
    return { ok: false, reason: `#${pr.number} reports no usable head commit` };
  }
  if (pr.state !== "open") {
    return { ok: false, reason: `#${pr.number} is ${pr.state}, not open` };
  }
  return {
    ok: true,
    number: pr.number,
    version: pr.version,
    headSha: pr.headSha,
    url: pr.url,
    reason: `pinned release Pull Request #${pr.number} for v${pr.version} at ${pr.headSha}`,
  };
}

/**
 * The pinned pull request must still be the exact object that was validated.
 * If its head moved between validation and merge, the run stops: a stale
 * validated commit is never merged.
 */
function verifyPinnedHead({ number, pinnedSha, currentSha, state = "open" } = {}) {
  const pinned = String(pinnedSha || "");
  const now = String(currentSha || "");
  if (String(state).toLowerCase() !== "open") {
    return { ok: false, reason: `#${number} is ${state}, not open - it can no longer be merged` };
  }
  if (!pinned || !now) {
    return { ok: false, reason: `#${number} has no comparable head commit` };
  }
  if (pinned !== now) {
    return {
      ok: false,
      reason: `#${number} moved from ${pinned} to ${now} while it was being validated - revalidate the new head`,
    };
  }
  return { ok: true, reason: `#${number} is still at the validated commit ${pinned}` };
}

/**
 * After the automated Safe Merge: main must really carry the release, at the
 * exact commit that was validated. Anything else stops the run before a build.
 *
 * When `expectedMainSha` is given it must be exactly the commit Official
 * Publish observed right after the merge - if main advanced again afterwards
 * the run stops instead of building an unintended later commit.
 */
function verifyMergedMain({
  expectedVersion,
  mainVersion,
  prState,
  mergeCommitOnMain,
  expectedMainSha = "",
  mainSha = "",
} = {}) {
  const want = clean(expectedVersion);
  const got = clean(mainVersion);
  if (String(prState || "").toLowerCase() !== "merged") {
    return { ok: false, reason: `the release Pull Request is ${prState || "unknown"}, not merged` };
  }
  if (!mergeCommitOnMain) {
    return { ok: false, reason: "the merge commit of the release Pull Request is not on main" };
  }
  if (engine.compareBuilds(want, got) !== 0) {
    return { ok: false, reason: `main declares v${got || "unknown"} but v${want} was released` };
  }
  if (expectedMainSha || mainSha) {
    if (!expectedMainSha || !mainSha) {
      return { ok: false, reason: "the merged main commit could not be determined" };
    }
    if (expectedMainSha !== mainSha) {
      return {
        ok: false,
        reason: `main advanced from ${expectedMainSha} to ${mainSha} after the merge - refusing to build an unintended commit`,
      };
    }
  }
  return {
    ok: true,
    sha: mainSha || null,
    reason: `main verified at v${got}${mainSha ? ` (${mainSha})` : ""} with the merged release commit`,
  };
}

module.exports = {
  orchestrationPlan,
  checksVerdict,
  pinPreparedPullRequest,
  verifyPinnedHead,
  verifyMergedMain,
  matchesRequiredCheck: contract.matchesRequiredCheck,
};

// ---- CLI -------------------------------------------------------------------

if (require.main === module) {
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  const cmd = args[0] || "plan";
  const flag = (name, fallback = "") => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const json = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };

  if (cmd === "plan") {
    const path = require("node:path");
    const releaseType = String(flag("type", "auto") || "auto").toLowerCase();
    const explicit = releaseType !== "auto" && releaseType !== "rebuild";
    const root = path.join(__dirname, "..");
    const changelogFile = path.join(root, "CHANGELOG.md");
    const changelogBody =
      explicit && fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, "utf8") : "";
    let tags = [];
    if (explicit) {
      const tagsFile = flag("tags", "");
      if (tagsFile && fs.existsSync(tagsFile)) {
        tags = fs
          .readFileSync(tagsFile, "utf8")
          .split(/\r?\n/)
          .map((v) => v.trim())
          .filter(Boolean);
      } else {
        try {
          const { execFileSync } = require("node:child_process");
          tags = execFileSync("git", ["tag", "--list", "v*"], {
            cwd: root,
            encoding: "utf8",
          })
            .split(/\r?\n/)
            .map((v) => v.trim())
            .filter((v) => /^v[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/.test(v));
        } catch {
          tags = [];
        }
      }
    }
    const result = orchestrationPlan({
      mode: flag("mode", "auto"),
      mainVersion: flag("current"),
      releaseType,
      tags,
      changelogBody,
      prepared: json(flag("prepared"), []),
      released: (flag("released") ? fs.readFileSync(flag("released"), "utf8").split(/\r?\n/) : [])
        .map((v) => v.trim())
        .filter(Boolean),
    });
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exit(result.step === "error" ? 1 : 0);
  }

  if (cmd === "checks") {
    const result = checksVerdict({
      headSha: flag("head"),
      checks: json(flag("checks"), []),
      required: flag("required", "PR Validation"),
    });
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exit(result.ready ? 0 : result.failed ? 2 : 3);
  }

  if (cmd === "pin-pr") {
    // node scripts/orchestrator-engine.cjs pin-pr --expect 1.4.2 --open open.json
    const result = pinPreparedPullRequest({
      expectedVersion: flag("expect"),
      open: json(flag("open"), []),
    });
    process.stdout.write(JSON.stringify(result, null, 2));
    if (!result.ok) process.stderr.write(`${result.reason}\n`);
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "verify-head") {
    const result = verifyPinnedHead({
      number: flag("number"),
      pinnedSha: flag("pinned"),
      currentSha: flag("current"),
      state: flag("state", "open"),
    });
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "verify-main") {
    const result = verifyMergedMain({
      expectedVersion: flag("version"),
      mainVersion: flag("current"),
      prState: flag("state"),
      mergeCommitOnMain: flag("on-main") === "true",
      expectedMainSha: flag("expected-sha"),
      mainSha: flag("main-sha"),
    });
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  console.error(`unknown command "${cmd}"`);
  process.exit(1);
}
