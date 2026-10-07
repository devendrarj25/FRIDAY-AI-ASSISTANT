/**
 * FRIDAY - safe merge & maintenance engine.
 *
 * These tests lock the two promises of scripts/merge-engine.cjs:
 *   1. nothing unsafe is ever declared mergeable into main,
 *   2. nothing current, protected or unmerged is ever proposed for deletion.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const engine = require_(path.resolve(process.cwd(), "scripts/merge-engine.cjs")) as {
  evaluatePullRequest: (
    pr: unknown,
    opts?: Record<string, unknown>,
  ) => {
    eligible: boolean;
    reasons: string[];
    release: boolean;
  };
  selectPullRequests: (
    prs: unknown[],
    opts: { scope?: string; numbers?: number[] },
  ) => { number: number }[];
  parseNumbers: (value: string) => number[];
  planCleanup: (
    input: Record<string, unknown>,
    policy?: Record<string, unknown>,
  ) => {
    branches: string[];
    testReleases: string[];
    officialReleases: string[];
    runs: number[];
    kept: { official: string[]; test: string[] };
  };
  isProtectedBranch: (b: string) => boolean;
};

const ok = (over: Record<string, unknown> = {}) => ({
  number: 12,
  baseRefName: "main",
  headRefName: "feature/chat-fix",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: "abc123",
  headRepositoryOwner: { login: "devendrarj25" },
  statusCheckRollup: [
    { name: "PR Validation", conclusion: "success", status: "completed", sha: "abc123" },
  ],
  ...over,
});

describe("safe merge - eligibility", () => {
  it("accepts an open, clean, fully validated pull request into main", () => {
    const d = engine.evaluatePullRequest(ok(), {
      requiredChecks: ["PR Validation"],
      repositoryOwner: "devendrarj25",
    });
    expect(d.reasons).toEqual([]);
    expect(d.eligible).toBe(true);
  });

  it("refuses drafts, conflicts, blocked states and non-main targets", () => {
    for (const bad of [
      { isDraft: true },
      { mergeable: "CONFLICTING" },
      { mergeable: "UNKNOWN" },
      { mergeStateStatus: "BLOCKED" },
      { mergeStateStatus: "BEHIND" },
      { baseRefName: "development" },
      { state: "CLOSED" },
    ]) {
      const d = engine.evaluatePullRequest(ok(bad), { repositoryOwner: "devendrarj25" });
      expect(d.eligible, JSON.stringify(bad)).toBe(false);
      expect(d.reasons.length).toBeGreaterThan(0);
    }
  });

  it("trusts change and modify prefixes and refuses a tool prefix", () => {
    const opts = { requiredChecks: ["PR Validation"], repositoryOwner: "devendrarj25" };
    expect(engine.evaluatePullRequest(ok({ headRefName: "change/docs-map" }), opts).eligible).toBe(
      true,
    );
    expect(
      engine.evaluatePullRequest(ok({ headRefName: "modify/voice-wake" }), opts).eligible,
    ).toBe(true);
    expect(
      engine.evaluatePullRequest(ok({ headRefName: "upgrade/models-free-tier" }), opts).eligible,
    ).toBe(true);
    expect(engine.evaluatePullRequest(ok({ headRefName: "cursor/task" }), opts).eligible).toBe(
      false,
    );
  });

  it("accepts Cloud Agent / AGENTS.md `dev/` work branches", () => {
    const d = engine.evaluatePullRequest(
      ok({ headRefName: "dev/windows-exe-actions-versioning-4dd5" }),
      {
        requiredChecks: ["PR Validation"],
        repositoryOwner: "devendrarj25",
      },
    );
    expect(d.reasons).toEqual([]);
    expect(d.eligible).toBe(true);
  });

  it("refuses untrusted, forked and protected head branches", () => {
    expect(engine.evaluatePullRequest(ok({ headRefName: "random-work" })).eligible).toBe(false);
    expect(engine.evaluatePullRequest(ok({ headRefName: "main" })).eligible).toBe(false);
    expect(engine.evaluatePullRequest(ok({ headRefName: "recovery/main-1" })).eligible).toBe(false);
    expect(
      engine.evaluatePullRequest(ok({ headRepositoryOwner: { login: "someone-else" } }), {
        repositoryOwner: "devendrarj25",
      }).eligible,
    ).toBe(false);
  });

  it("refuses failing, still-running, missing and stale-commit checks", () => {
    const running = engine.evaluatePullRequest(
      ok({ statusCheckRollup: [{ name: "PR Validation", status: "in_progress", sha: "abc123" }] }),
    );
    expect(running.eligible).toBe(false);
    expect(running.reasons.join(" ")).toContain("still running");

    const failed = engine.evaluatePullRequest(
      ok({ statusCheckRollup: [{ name: "PR Validation", conclusion: "failure", sha: "abc123" }] }),
    );
    expect(failed.eligible).toBe(false);

    const none = engine.evaluatePullRequest(ok({ statusCheckRollup: [] }));
    expect(none.eligible).toBe(false);

    const stale = engine.evaluatePullRequest(
      ok({ statusCheckRollup: [{ name: "PR Validation", conclusion: "success", sha: "old" }] }),
    );
    expect(stale.eligible).toBe(false);
    expect(stale.reasons.join(" ")).toContain("older commit");

    const missingRequired = engine.evaluatePullRequest(ok(), {
      requiredChecks: ["Windows Installer Smoke"],
    });
    expect(missingRequired.eligible).toBe(false);
  });

  it("refuses a pull request that moved while it was evaluated", () => {
    const d = engine.evaluatePullRequest(ok(), { latestSha: "def456" });
    expect(d.eligible).toBe(false);
    expect(d.reasons.join(" ")).toContain("moved");
  });

  it("recognises release pull requests for the release scope", () => {
    const release = ok({ headRefName: "release/v1.3.3" });
    expect(engine.evaluatePullRequest(release).release).toBe(true);
    const prs = [ok(), release, ok({ number: 13, headRefName: "fix/boot" })];
    expect(engine.selectPullRequests(prs, { scope: "release" })).toHaveLength(1);
    expect(engine.selectPullRequests(prs, { scope: "auto" })).toHaveLength(3);
    expect(engine.selectPullRequests(prs, { scope: "selected", numbers: [13] })).toHaveLength(1);
    // "selected" with nothing selected merges nothing at all.
    expect(engine.selectPullRequests(prs, { scope: "selected", numbers: [] })).toHaveLength(0);
    expect(engine.parseNumbers("#12, 14 ")).toEqual([12, 14]);
  });

  it("refuses an older release PR when a newer release PR is open", () => {
    const older = engine.evaluatePullRequest(ok({ headRefName: "release/v1.3.3" }), {
      requiredChecks: ["PR Validation"],
      repositoryOwner: "devendrarj25",
      latestReleaseBranch: "release/v1.3.4",
    });
    const latest = engine.evaluatePullRequest(ok({ headRefName: "release/v1.3.4" }), {
      requiredChecks: ["PR Validation"],
      repositoryOwner: "devendrarj25",
      latestReleaseBranch: "release/v1.3.4",
    });
    expect(older.eligible).toBe(false);
    expect(older.reasons.join(" ")).toContain("superseded by newer release/v1.3.4");
    expect(latest.eligible).toBe(true);
  });

  it("refuses an older four-part release PR when a newer four-part release PR is open", () => {
    const older = engine.evaluatePullRequest(ok({ headRefName: "release/v1.0.0.0" }), {
      requiredChecks: ["PR Validation"],
      repositoryOwner: "devendrarj25",
      latestReleaseBranch: "release/v1.0.0.1",
    });
    const latest = engine.evaluatePullRequest(ok({ headRefName: "release/v1.0.0.1" }), {
      requiredChecks: ["PR Validation"],
      repositoryOwner: "devendrarj25",
      latestReleaseBranch: "release/v1.0.0.1",
    });
    expect(older.eligible).toBe(false);
    expect(older.reasons.join(" ")).toContain("superseded by newer release/v1.0.0.1");
    expect(latest.eligible).toBe(true);
  });
});

describe("maintenance cleanup - never removes anything live", () => {
  const releases = [
    { tagName: "v1.3.5", isPrerelease: false, createdAt: "2026-05-05" },
    { tagName: "v1.3.4", isPrerelease: false, createdAt: "2026-04-04" },
    { tagName: "v1.3.3", isPrerelease: false, createdAt: "2026-03-03" },
    { tagName: "v1.3.2", isPrerelease: false, createdAt: "2026-02-02" },
    { tagName: "v1.3.6-test.2", isPrerelease: true, createdAt: "2026-05-06" },
    { tagName: "v1.3.6-test.1", isPrerelease: true, createdAt: "2026-05-01" },
  ];

  it("keeps the latest 3 official releases and the latest test prerelease", () => {
    const plan = engine.planCleanup({ releases }, { currentTag: "v1.3.5" });
    expect(plan.officialReleases).toEqual(["v1.3.2"]);
    expect(plan.testReleases).toEqual(["v1.3.6-test.1"]);
    expect(plan.kept.official).toEqual(["v1.3.5", "v1.3.4", "v1.3.3"]);
    expect(plan.kept.test).toEqual(["v1.3.6-test.2"]);
  });

  it("never deletes the current release even if the policy would", () => {
    const plan = engine.planCleanup({ releases }, { keepOfficial: 1, currentTag: "v1.3.2" });
    expect(plan.officialReleases).not.toContain("v1.3.2");
  });

  it("deletes only merged, unprotected branches", () => {
    const plan = engine.planCleanup({
      branches: [
        { name: "feature/done", merged: true },
        { name: "feature/live", merged: false },
        { name: "main", merged: true },
        { name: "development", merged: true },
        { name: "release", merged: true },
        { name: "recovery/main-1", merged: true },
      ],
    });
    expect(plan.branches).toEqual(["feature/done"]);
    for (const b of ["main", "development", "release", "recovery/main-1"])
      expect(engine.isProtectedBranch(b)).toBe(true);
  });

  it("keeps the last runs per workflow and never touches a live run", () => {
    const runs = Array.from({ length: 20 }, (_, i) => ({
      databaseId: i + 1,
      workflowName: "PR Validation",
      status: "completed",
      createdAt: `2026-01-${String(20 - i).padStart(2, "0")}`,
    }));
    runs.push({
      databaseId: 99,
      workflowName: "PR Validation",
      status: "in_progress",
      createdAt: "2020-01-01",
    });
    const plan = engine.planCleanup({ runs }, { keepRuns: 15 });
    expect(plan.runs).toHaveLength(5);
    expect(plan.runs).not.toContain(99);
  });
});

describe("workflow wiring", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");

  it("safe merge validates through the shared engine and merges with a merge commit", () => {
    const src = read(".github/workflows/safe-merge.yml");
    expect(src).toContain("merge-engine.cjs evaluate");
    expect(src).toContain("--match-head-commit");
    expect(src).toContain("--latest-release-branch");
    expect(src).not.toMatch(/--squash|--rebase|--admin/);
    expect(src).not.toMatch(/git\s+push[^\n]*(--force|-f\b)/);
  });

  it("maintenance is a dry run unless it is explicitly applied", () => {
    const src = read(".github/workflows/maintenance.yml");
    expect(src).toContain("merge-engine.cjs cleanup");
    expect(src).toContain("if: env.APPLY == 'true'");
    expect(src).toContain("main|master|develop|development|release|recovery/*)");
    expect(src).not.toMatch(/git\s+push[^\n]*(--force|-f\b)/);
  });
});
