/**
 * Official Publish - the one-click end-to-end official release.
 *
 * The orchestrator may never invent release behaviour: it only decides the next
 * safe step and starts the existing workflows. These tests lock both the
 * decision engine and that workflow contract.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const engine = require(path.resolve(process.cwd(), "scripts/orchestrator-engine.cjs")) as {
  orchestrationPlan: (input: any) => any;
  checksVerdict: (input: any) => any;
  verifyMergedMain: (input: any) => any;
  pinPreparedPullRequest: (input: any) => any;
};

const WORKFLOW = path.resolve(process.cwd(), ".github/workflows/official-publish.yml");
const src = fs.readFileSync(WORKFLOW, "utf8");
const doc = parseYaml(src) as any;

describe("official publish · decision engine", () => {
  it("prepares the next number when update is asked and the version is released", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      releaseType: "patch",
      mainVersion: "1.3.4",
      prepared: [],
      released: ["1.3.4", "1.3.3"],
    });
    expect(plan.step).toBe("prepare");
    expect(plan.version).toBe("1.3.5");
  });

  it("does not invent the next number when auto runs on a published version", () => {
    const plan = engine.orchestrationPlan({
      mode: "auto",
      releaseType: "auto",
      mainVersion: "1.3.4",
      prepared: [],
      released: ["1.3.4", "1.3.3"],
    });
    expect(plan.step).toBe("error");
    expect(plan.version).toBe("1.3.4");
  });

  it("reuses the highest open release PR instead of preparing a duplicate", () => {
    const plan = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.3.2",
      prepared: [
        { number: 11, version: "1.3.3", state: "open" },
        { number: 14, version: "1.3.4", state: "open" },
      ],
      released: ["1.3.2"],
    });
    expect(plan.step).toBe("merge");
    expect(plan.version).toBe("1.3.4");
    expect(plan.prNumber).toBe(14);
    expect(plan.superseded).toEqual([{ number: 11, version: "1.3.3" }]);
  });

  it("publishes directly when main already carries a merged, unreleased version", () => {
    const plan = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.3.4",
      prepared: [{ number: 14, version: "1.3.4", state: "merged" }],
      released: ["1.3.3"],
    });
    expect(plan.step).toBe("publish");
    expect(plan.version).toBe("1.3.4");
  });

  it("prepares a confirm PR when main was bumped without a release/v* PR", () => {
    const plan = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.6.6",
      prepared: [
        { number: 30, version: "1.6.5", state: "merged" },
        { number: 24, version: "1.6.4", state: "merged" },
      ],
      released: ["1.6.5", "1.6.4"],
    });
    expect(plan.step).toBe("prepare");
    expect(plan.version).toBe("1.6.6");
    expect(plan.prNumber).toBeNull();
  });

  it("merges an open confirm PR for the unpublished version on main", () => {
    const plan = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.6.6",
      prepared: [{ number: 51, version: "1.6.6", state: "open" }],
      released: ["1.6.5"],
    });
    expect(plan.step).toBe("merge");
    expect(plan.version).toBe("1.6.6");
    expect(plan.prNumber).toBe(51);
  });

  it("accepts the four-part public FRIDAY version as main's declared version", () => {
    const plan = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.0.0.0",
      prepared: [],
      released: ["1.8.0", "1.7.1"],
    });
    expect(plan.step).toBe("prepare");
    expect(plan.version).toBe("1.0.0.0");
  });

  it("rebuild republishes the declared version and never bumps or merges", () => {
    const plan = engine.orchestrationPlan({
      mode: "rebuild",
      mainVersion: "1.3.4",
      prepared: [{ number: 15, version: "1.3.5", state: "open" }],
      released: ["1.3.4"],
    });
    expect(plan.step).toBe("rebuild");
    expect(plan.version).toBe("1.3.4");
    expect(plan.publishMode).toBe("rebuild");
    expect(plan.prNumber).toBeNull();
  });

  it("retries the unpublished version when the release type stays the same", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      mainVersion: "1.0.1.2",
      prepared: [{ number: 9, version: "1.0.1.2", state: "merged" }],
      released: ["1.0.1.1"],
      releaseType: "patch",
      changelogBody: "## v1.0.1.2\n",
    });
    expect(plan.step).toBe("publish");
    expect(plan.version).toBe("1.0.1.2");
  });

  it("skips a failed publish when the next run asks for a different release type", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      mainVersion: "1.0.1.2",
      prepared: [{ number: 9, version: "1.0.1.2", state: "merged" }],
      released: ["1.0.1.1"],
      releaseType: "major",
      changelogBody: "## v1.0.1.2\n",
    });
    expect(plan.step).toBe("prepare");
    expect(plan.version).toBe("1.1.1.1");
  });

  it("does not treat a changelog heading as a successful publish", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      mainVersion: "1.0.0.2",
      prepared: [],
      released: [],
      releaseType: "minor",
      changelogBody: "## v1.0.0.2\n",
    });
    expect(plan.step).toBe("prepare");
    expect(plan.version).toBe("1.0.0.2");
  });

  it("keeps the declared version when the increment is auto", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      mainVersion: "1.0.0.2",
      prepared: [],
      released: [],
      releaseType: "auto",
      changelogBody: "## v1.0.0.2\n",
    });
    expect(plan.step).toBe("prepare");
    expect(plan.version).toBe("1.0.0.2");
  });

  it("does not skip a declared version the changelog does not record", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      mainVersion: "1.0.0.0",
      prepared: [],
      released: [],
      releaseType: "minor",
      changelogBody: "",
    });
    expect(plan.step).toBe("prepare");
    expect(plan.version).toBe("1.0.0.0");
  });

  it("fails closed on ambiguous, conflicting or invalid state", () => {
    expect(
      engine.orchestrationPlan({ mode: "auto", mainVersion: "", prepared: [], released: [] }).step,
    ).toBe("error");
    expect(
      engine.orchestrationPlan({
        mode: "auto",
        mainVersion: "1.3.2",
        prepared: [
          { number: 20, version: "1.3.3", state: "open" },
          { number: 21, version: "1.3.3", state: "open" },
        ],
        released: ["1.3.2"],
      }).step,
    ).toBe("error");
    expect(
      engine.orchestrationPlan({
        mode: "auto",
        mainVersion: "1.3.3",
        prepared: [{ number: 22, version: "1.3.3", state: "open" }],
        released: ["1.3.2"],
      }).step,
    ).toBe("merge");
  });
});

describe("official publish · check and merge verification", () => {
  const head = "abc123";

  it("only reports ready when every check passed on the exact head commit", () => {
    expect(
      engine.checksVerdict({
        headSha: head,
        checks: [
          { name: "PR Validation", status: "COMPLETED", conclusion: "SUCCESS", headSha: head },
        ],
      }).ready,
    ).toBe(true);
  });

  it("waits while a check is still running and fails when one failed", () => {
    const pending = engine.checksVerdict({
      headSha: head,
      checks: [{ name: "PR Validation", status: "IN_PROGRESS", headSha: head }],
    });
    expect(pending).toMatchObject({ ready: false, failed: false });
    const failed = engine.checksVerdict({
      headSha: head,
      checks: [
        { name: "PR Validation", status: "COMPLETED", conclusion: "FAILURE", headSha: head },
      ],
    });
    expect(failed).toMatchObject({ ready: false, failed: true });
  });

  it("never treats a missing required check as success", () => {
    expect(
      engine.checksVerdict({
        headSha: head,
        checks: [
          { name: "Test EXE Build", status: "COMPLETED", conclusion: "SUCCESS", headSha: head },
        ],
      }),
    ).toMatchObject({ ready: false, failed: false });
  });

  it("fails closed when pin-pr has no expected version and no open release PR", () => {
    expect(engine.pinPreparedPullRequest({ expectedVersion: "", open: [] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no open release Pull Request/),
    });
  });

  it("verifies the merged main state before anything is built", () => {
    expect(
      engine.verifyMergedMain({
        expectedVersion: "1.3.4",
        mainVersion: "1.3.4",
        prState: "merged",
        mergeCommitOnMain: true,
      }).ok,
    ).toBe(true);
    expect(
      engine.verifyMergedMain({
        expectedVersion: "1.3.4",
        mainVersion: "1.3.3",
        prState: "merged",
        mergeCommitOnMain: true,
      }).ok,
    ).toBe(false);
    expect(
      engine.verifyMergedMain({
        expectedVersion: "1.3.4",
        mainVersion: "1.3.4",
        prState: "open",
        mergeCommitOnMain: false,
      }).ok,
    ).toBe(false);
  });
});

describe("official publish · workflow contract", () => {
  const at = (needle: string) => src.indexOf(needle);

  it("is a manual, main-only orchestrator that writes nothing itself", () => {
    expect(doc.name).toBe("Official Publish");
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    expect(doc.on.pull_request).toBeUndefined();
    expect(doc.on.workflow_call).toBeUndefined();
    expect(src).not.toContain("official-publish-once");
    expect(src).toContain("Official Publish is manual only (workflow_dispatch).");
    expect(doc.permissions.contents).toBe("read");
    expect(doc.permissions["pull-requests"]).toBe("read");
    expect(doc.permissions.actions).toBe("read");
    expect(src).toContain("Official Publish runs from main only");
    expect(src).toContain("releaseOperatorGuide");
    expect(src).not.toMatch(
      /gh pr merge|gh release create|gh release upload|git push|gh workflow run/,
    );
    expect(src).not.toContain("ci-workflow-run");
    expect(src).not.toMatch(/enable-?auto-?merge|automerge|auto_merge/i);
    for (const [name, job] of Object.entries<any>(doc.jobs)) {
      if (!job["runs-on"]) continue;
      expect(job.permissions.contents, name).toBe("read");
      expect(job.permissions["pull-requests"], name).toBe("read");
      expect(JSON.stringify(job.permissions), name).not.toContain("write");
    }
  });

  it("passes the release type into the orchestrator and does not decide a version itself", () => {
    const step = src.indexOf("Decide the next safe step");
    const prepare = src.indexOf("stage: prepare");
    const slice = src.slice(step, prepare);
    expect(slice).toContain("orchestrator-engine.cjs plan");
    expect(slice).toContain('--type "$RELEASE_TYPE"');
    expect(slice).not.toContain("release-engine.cjs decide");
  });

  it("calls the existing workflows in this run instead of starting a new one", () => {
    expect(src).toContain("uses: ./.github/workflows/release.yml");
    expect(src).toContain("stage: prepare");
    expect(src).toContain("uses: ./.github/workflows/pr-validation.yml");
    expect(src).toContain("uses: ./.github/workflows/safe-merge.yml");
    expect(src).toContain("confirm: MERGE");
    expect(src).toContain("delete_branch: ${{ 'true' }}");
    expect(src).toContain("stage: publish");
    expect(src.match(/caller: official-publish/g)).toHaveLength(4);
    expect(doc.jobs["prepare-release"].secrets).toBe("inherit");
    expect(doc.jobs["publish-release"].secrets).toBe("inherit");
    expect(doc.jobs.validate.secrets).toBeUndefined();
    expect(doc.jobs.merge.secrets).toBeUndefined();
    expect(doc.jobs["prepare-release"].permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      actions: "read",
    });
    expect(doc.jobs["publish-release"].permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      actions: "read",
    });
    expect(doc.jobs.merge.permissions["pull-requests"]).toBe("write");
    expect(doc.jobs.validate.permissions.statuses).toBe("write");
    expect(doc.jobs.validate.permissions["security-events"]).toBe("write");
    expect(src).toContain("needs.plan.outputs.step == 'publish'");
    expect(src).toContain("needs.plan.outputs.step == 'rebuild'");
    expect(src).toContain("needs.plan.result == 'success'");
    expect(src).not.toContain("steps.plan.outputs.version != ''");
  });

  it("runs prepare, validation, merge, main verification, publish and confirmation in order", () => {
    expect(at("orchestrator-engine.cjs plan")).toBeLessThan(at("stage: prepare"));
    expect(at("stage: prepare")).toBeLessThan(at("Wait for the required checks"));
    expect(at("Wait for the required checks")).toBeLessThan(
      at("uses: ./.github/workflows/safe-merge.yml"),
    );
    expect(at("uses: ./.github/workflows/safe-merge.yml")).toBeLessThan(
      at("orchestrator-engine.cjs verify-main"),
    );
    expect(at("orchestrator-engine.cjs verify-main")).toBeLessThan(at("stage: publish"));
    expect(at("stage: publish")).toBeLessThan(at("Confirm the published release and its assets"));
    expect(at("Confirm the published release and its assets")).toBeLessThan(at("Final summary"));
    expect(at("scripts/validation-freshness.cjs")).toBeLessThan(
      at("uses: ./.github/workflows/pr-validation.yml"),
    );
  });

  it("reads post-merge identity and SHA from origin/main, not the start-of-run checkout", () => {
    // An earlier run: verify-main compared expected 1.0.0.1 to
    // the job's original 1.0.0.0 tree after Safe Merge had already landed.
    const verify = src.indexOf("Verify the merged main state");
    const confirm = src.indexOf("Confirm the published release and its assets");
    expect(verify).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(verify);
    expect(src).toContain("identity --ref origin/main --field releaseVersion");
    expect(src).toContain("git rev-parse origin/main");
    expect(src).toContain('--main-sha "$main_sha"');
    expect(src).toContain("resuming: main already carries unpublished");
    expect(
      src.slice(
        src.indexOf("Read the real repository state"),
        src.indexOf("Decide the next safe step"),
      ),
    ).toContain("identity --ref origin/main");
    expect(src.slice(verify, confirm)).toContain("identity --ref origin/main");
    expect(src.slice(confirm)).toContain("identity --ref origin/main");
    expect(src.slice(verify, confirm)).not.toMatch(
      /identity --field releaseVersion[\s\S]*--main-sha "\$sha"/,
    );
  });

  it("waits out the Windows validation job before Safe Merge", () => {
    // pr-validation.yml validate timeout is 90 minutes. A 30-minute poll
    // (the old 90 * 20s loop) stops Official Publish while that job is still
    // running. The wait is its own job, so the Windows job, Safe Merge, and
    // publish no longer share one 360-minute clock.
    const wait = src.slice(
      src.indexOf("Wait for the required checks"),
      src.indexOf("Merge the pinned release Pull Request"),
    );
    const attempts = Number(wait.match(/seq 1 (\d+)/)?.[1]);
    const pauses = [...wait.matchAll(/sleep (\d+)\s*$/gm)].map((match) => Number(match[1]));
    const pause = Math.max(...pauses);
    expect(attempts).toBeGreaterThan(0);
    expect(pause).toBeGreaterThan(0);
    expect(attempts * pause).toBeGreaterThanOrEqual(90 * 60);
    expect(doc.jobs.evidence["timeout-minutes"]).toBeGreaterThanOrEqual((attempts * pause) / 60);
    const release = parseYaml(
      fs.readFileSync(path.resolve(process.cwd(), ".github/workflows/release.yml"), "utf8"),
    ) as any;
    const validation = parseYaml(
      fs.readFileSync(path.resolve(process.cwd(), ".github/workflows/pr-validation.yml"), "utf8"),
    ) as any;
    const merge = parseYaml(
      fs.readFileSync(path.resolve(process.cwd(), ".github/workflows/safe-merge.yml"), "utf8"),
    ) as any;
    expect(release.jobs.prepare["timeout-minutes"]).toBeGreaterThanOrEqual(60);
    expect(release.jobs.publish["timeout-minutes"]).toBeGreaterThanOrEqual(90);
    expect(validation.jobs.validate["timeout-minutes"]).toBeGreaterThanOrEqual(90);
    expect(merge.jobs.merge["timeout-minutes"]).toBeGreaterThanOrEqual(20);
    // A job that calls a reusable workflow cannot set timeout-minutes.
    // The called workflow's own job timeout is the budget.
    for (const name of ["prepare-release", "publish-release", "validate", "merge"]) {
      expect(doc.jobs[name]["timeout-minutes"], name).toBeUndefined();
      expect(doc.jobs[name].uses, name).toMatch(/^\.\/\.github\/workflows\/.+\.yml$/);
    }
  });

  it("fails the run when a dispatched workflow fails or never finishes", () => {
    const helper = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/ci-workflow-run.sh"),
      "utf8",
    );
    expect(helper).toContain("did not start.");
    expect(helper).toContain("did not finish in time.");
    expect(helper).toContain('[ "$conclusion" != "success" ]');
    expect(helper).toContain("databaseId | tostring");
    expect(helper).not.toContain("createdAt >= $since");
    // ASCII only: this is also read on Windows PowerShell/Git Bash toolchains.
    expect(/^[\x00-\x7F]*$/.test(helper)).toBe(true);
    expect(/^[\x00-\x7F]*$/.test(src)).toBe(true);
  });
});
