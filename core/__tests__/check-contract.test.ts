/**
 * FRIDAY - the ONE definition of "a required check passed on this commit".
 *
 * Official Publish, Safe Merge and the merge engine all evaluate merge safety
 * through scripts/check-contract.cjs. These tests pin the behaviour that keeps
 * a release from being merged on a check that ran on a DIFFERENT commit, on a
 * similarly named check, or on no evidence at all.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const contract = require("../../scripts/check-contract.cjs");
const merge = require("../../scripts/merge-engine.cjs");
const orchestrator = require("../../scripts/orchestrator-engine.cjs");
const engine = require("../../scripts/release-engine.cjs");

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const run = (over: Record<string, unknown> = {}) => ({
  name: "PR Validation",
  status: "completed",
  conclusion: "success",
  head_sha: HEAD,
  ...over,
});

describe("required check contract", () => {
  it("accepts the composite 'Workflow / Job' check name", () => {
    expect(contract.matchesRequiredCheck("PR Validation / validate", "PR Validation")).toBe(true);
    expect(contract.matchesRequiredCheck("pr validation", "PR Validation")).toBe(true);
  });

  it("never accepts a different check that merely starts the same way", () => {
    expect(contract.matchesRequiredCheck("PR Validation Extra", "PR Validation")).toBe(false);
  });

  it("passes only when the check ran on the exact head commit", () => {
    const ok = contract.evaluateRequiredCheck({ headSha: HEAD, checks: [run()] });
    expect(ok.ready).toBe(true);

    const stale = contract.evaluateRequiredCheck({
      headSha: HEAD,
      checks: [run({ head_sha: OLD })],
    });
    expect(stale.ready).toBe(false);
    expect(stale.failed).toBe(false);
    expect(stale.reason).toContain("has not reported");
  });

  it("waits while the required check is still running and fails when it fails", () => {
    const running = contract.evaluateRequiredCheck({
      headSha: HEAD,
      checks: [run({ status: "in_progress", conclusion: "" })],
    });
    expect(running).toMatchObject({ ready: false, failed: false });

    const failed = contract.evaluateRequiredCheck({
      headSha: HEAD,
      checks: [run({ conclusion: "failure" })],
    });
    expect(failed).toMatchObject({ ready: false, failed: true });
  });

  it("the command line refuses a running check and accepts a passing one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-check-contract-"));
    const file = path.join(dir, "checks.json");
    const script = path.resolve(__dirname, "../../scripts/check-contract.cjs");
    const runCli = (checks: unknown[]) => {
      fs.writeFileSync(file, JSON.stringify(checks));
      return spawnSync(process.execPath, [script, "--head", HEAD, "--checks", file], {
        encoding: "utf8",
      });
    };
    const running = runCli([run({ status: "in_progress", conclusion: "" })]);
    expect(running.status).toBe(1);
    expect(running.stdout).toContain("still running");
    const passed = runCli([run({ name: "PR Validation / validate" })]);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("passed");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails when any other check on that commit failed", () => {
    const verdict = contract.evaluateRequiredCheck({
      headSha: HEAD,
      checks: [run(), run({ name: "CodeQL", conclusion: "failure" })],
    });
    expect(verdict).toMatchObject({ ready: false, failed: true });
  });
});

describe("merge engine uses the same contract", () => {
  const pr = {
    number: 7,
    headRefName: "release/v1.5.0",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefOid: HEAD,
    headRepositoryOwner: { login: "devendrarj25" },
    statusCheckRollup: [{ name: "PR Validation", status: "COMPLETED", conclusion: "SUCCESS" }],
  };

  it("refuses a pull request whose validation ran on an older commit", () => {
    const decision = merge.evaluatePullRequest(pr, {
      requiredChecks: ["PR Validation"],
      repositoryOwner: "devendrarj25",
      checkRuns: [run({ head_sha: OLD })],
    });
    expect(decision.eligible).toBe(false);
  });

  it("accepts real per-commit evidence for the exact head", () => {
    const decision = merge.evaluatePullRequest(pr, {
      requiredChecks: ["PR Validation"],
      repositoryOwner: "devendrarj25",
      checkRuns: [run({ name: "PR Validation / validate" })],
    });
    expect(decision.reasons).toEqual([]);
    expect(decision.eligible).toBe(true);
  });
});

describe("official publish pins one release pull request", () => {
  const open = [
    { number: 11, version: "1.5.0", headSha: HEAD, state: "open" },
    { number: 12, version: "1.6.0", headSha: OLD, state: "open" },
  ];

  it("pins the prepared version exactly", () => {
    expect(orchestrator.pinPreparedPullRequest({ expectedVersion: "1.5.0", open })).toMatchObject({
      ok: true,
      number: 11,
      headSha: HEAD,
    });
  });

  it("refuses when the pinned pull request moved or closed", () => {
    expect(orchestrator.verifyPinnedHead({ number: 11, pinnedSha: HEAD, currentSha: OLD }).ok).toBe(
      false,
    );
    expect(
      orchestrator.verifyPinnedHead({
        number: 11,
        pinnedSha: HEAD,
        currentSha: HEAD,
        state: "closed",
      }).ok,
    ).toBe(false);
    expect(
      orchestrator.verifyPinnedHead({ number: 11, pinnedSha: HEAD, currentSha: HEAD }).ok,
    ).toBe(true);
  });
});

describe("release baseline and changelog headings", () => {
  it("prefers a published release that also exists as a tag", () => {
    expect(
      engine.releaseBaseline({ releases: ["v1.4.0", "v1.3.2"], tags: ["v1.4.0", "v1.3.2"] }),
    ).toMatchObject({ version: "1.4.0", hasTag: true });
  });

  it("reports a published baseline whose tag is missing locally", () => {
    const baseline = engine.releaseBaseline({ releases: ["v1.4.0"], tags: [], declared: "1.4.1" });
    expect(baseline).toMatchObject({ version: "1.4.0", hasTag: false });
  });

  it("never treats a prerelease as a stable baseline", () => {
    expect(engine.releaseBaseline({ releases: ["v1.5.0-test.3"], tags: [] }).version).not.toBe(
      "1.5.0-test.3",
    );
  });

  it("writes the canonical '## vX.Y.Z' changelog heading", () => {
    expect(engine.changelogEntry("## FRIDAY v1.4.2 - TEST BUILD\n\nbody")).toBe(
      "## v1.4.2\n\nbody",
    );
    expect(engine.changelogEntry("no heading here", "1.4.2").startsWith("## v1.4.2")).toBe(true);
  });
});
