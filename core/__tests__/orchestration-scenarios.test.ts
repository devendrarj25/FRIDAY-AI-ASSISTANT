/**
 * FRIDAY - release orchestration, manual and automatic mixed.
 *
 * The owner may drive a release by hand (bump package.json, open a PR, merge
 * it) or with one click ("Official Publish"). Both must always end in a correct
 * release: the orchestrator must READ the real repository state and pick the
 * remaining work, never assume one fixed path, never redo finished work and
 * never duplicate a release Pull Request.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const engine = require(path.resolve(process.cwd(), "scripts/orchestrator-engine.cjs")) as {
  orchestrationPlan: (input: any) => any;
};
const merge = require(path.resolve(process.cwd(), "scripts/merge-engine.cjs")) as {
  planCleanup: (input: any, policy?: any) => any;
};

const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

describe("orchestration · a release driven manually, then continued with one click", () => {
  it("prepares a confirm PR for a hand-bumped unpublished version instead of publishing without one", () => {
    // No release PR exists at all: the owner bumped and merged by hand.
    const plan = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.4.2",
      prepared: [],
      released: ["1.4.1", "1.4.0"],
    });
    expect(plan.step).toBe("prepare");
    expect(plan.version).toBe("1.4.2");
    expect(plan.prNumber).toBeNull();
  });

  it("does not invent the next number or republish when auto finds the version already released", () => {
    const plan = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.4.2",
      prepared: [],
      released: ["1.4.2"],
    });
    expect(plan.step).toBe("error");
    expect(plan.version).toBe("1.4.2");
  });

  it("publishes a manually merged release Pull Request exactly once", () => {
    const merged = { number: 31, version: "1.4.2", state: "merged" };
    const first = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.4.2",
      prepared: [merged],
      released: ["1.4.1"],
    });
    expect(first).toMatchObject({ step: "publish", version: "1.4.2", prNumber: 31 });
    // Running Official Publish again after that release exists must not repeat it.
    const second = engine.orchestrationPlan({
      mode: "auto",
      mainVersion: "1.4.2",
      prepared: [merged],
      released: ["1.4.2", "1.4.1"],
    });
    expect(second.step).toBe("error");
    expect(second.version).toBe("1.4.2");
  });
});

describe("orchestration · update mode never duplicates a release Pull Request", () => {
  it("adopts a release PR that was opened outside Official Publish", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      mainVersion: "1.4.1",
      prepared: [{ number: 40, version: "1.4.2", state: "open" }],
      released: ["1.4.1"],
    });
    expect(plan).toMatchObject({ step: "merge", version: "1.4.2", prNumber: 40 });
  });

  it("keeps the highest open release PR and records the lower ones as superseded", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      mainVersion: "1.4.1",
      prepared: [
        { number: 40, version: "1.4.2", state: "open" },
        { number: 41, version: "1.5.0", state: "open" },
      ],
      released: ["1.4.1"],
    });
    expect(plan).toMatchObject({ step: "merge", version: "1.5.0", prNumber: 41 });
    expect(plan.superseded).toEqual([{ number: 40, version: "1.4.2" }]);
  });

  it("merges the open confirm PR when main already declares that unpublished version", () => {
    const plan = engine.orchestrationPlan({
      mode: "update",
      mainVersion: "1.4.2",
      prepared: [{ number: 42, version: "1.4.2", state: "open" }],
      released: ["1.4.1"],
    });
    expect(plan).toMatchObject({ step: "merge", version: "1.4.2", prNumber: 42 });
  });
});

describe("orchestration · rebuild mode", () => {
  it("republishes the current version and ignores any open release PR", () => {
    const plan = engine.orchestrationPlan({
      mode: "rebuild",
      mainVersion: "1.4.1",
      prepared: [{ number: 50, version: "1.4.2", state: "open" }],
      released: ["1.4.1"],
    });
    expect(plan).toMatchObject({
      step: "rebuild",
      version: "1.4.1",
      publishMode: "rebuild",
      prNumber: null,
    });
  });

  it("rebuilds even when the version was never released, without bumping", () => {
    const plan = engine.orchestrationPlan({
      mode: "rebuild",
      mainVersion: "1.4.2",
      prepared: [],
      released: ["1.4.1"],
    });
    expect(plan.version).toBe("1.4.2");
    expect(plan.step).toBe("rebuild");
  });
});

describe("workflow safety · no cross-workflow race on branches", () => {
  it("Maintenance never deletes a branch that still has an open pull request", () => {
    const plan = merge.planCleanup({
      branches: [
        { name: "release/v1.4.2", merged: true },
        { name: "feature/old", merged: true },
      ],
      openPullRequestBranches: ["release/v1.4.2"],
    });
    expect(plan.branches).toEqual(["feature/old"]);
  });

  it("Maintenance collects the open pull requests before planning the cleanup", () => {
    const wf = read(".github/workflows/maintenance.yml");
    expect(wf).toContain("gh pr list --state open");
    expect(wf).toContain("--open-prs open-prs.json");
    expect(wf.indexOf("open-prs.json")).toBeLessThan(wf.indexOf("--open-prs open-prs.json"));
  });

  it("Safe Merge still requires an explicit confirmation and Official Publish stops on error", () => {
    expect(read(".github/workflows/safe-merge.yml")).toMatch(/confirm:[\s\S]*required: true/);
    expect(read(".github/workflows/official-publish.yml")).toContain(
      "steps.plan.outputs.step == 'error'",
    );
  });
});

describe("PR validation · manual version bumps auto-heal instead of hard-failing", () => {
  const wf = read(".github/workflows/pr-validation.yml");

  it("repairs documentation at the version the branch already declares", () => {
    expect(wf).toContain("Verify version/documentation synchronization (auto-heal)");
    expect(wf).toContain('node scripts/release-engine.cjs heal --version "$version"');
    expect(wf).toContain('git commit -m "chore: sync docs to v$version"');
    expect(wf).toContain('git push origin "HEAD:refs/heads/$branch"');
    expect(wf).toContain("contents: write");
  });

  it("only ever touches version/documentation files, never code logic", () => {
    expect(wf).toContain("auto-heal touched non-documentation files");
    expect(wf).toContain("^src/lib/friday/version\\.ts$");
  });

  it("still hard-fails when auto-heal cannot fix the state", () => {
    expect(wf).toContain("canonical identity declares an invalid version");
    // The repair is re-verified; unresolved drift exits non-zero via `verify`.
    expect(wf.lastIndexOf("node scripts/release-engine.cjs verify")).toBeGreaterThan(
      wf.indexOf('node scripts/release-engine.cjs heal --version "$version"'),
    );
    expect(wf).toContain("comes from a fork");
  });
});
