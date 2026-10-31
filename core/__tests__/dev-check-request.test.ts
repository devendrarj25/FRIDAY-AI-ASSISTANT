import { describe, expect, it } from "vitest";
import { devCheckAllows, devCheckRequest } from "../../src/lib/friday/self/own-work";

const diff = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("trying a proposal before it is put forward", () => {
  it("builds the exact dev.check call and says it needs approval", () => {
    const request = devCheckRequest({ paths: ["src/x.ts"], diff, level: "balanced" });
    expect(request).toEqual({
      ok: true,
      tool: "dev.check",
      args: { diff, check: "test-fast", baseline: true },
      needsApproval: true,
    });
    const chosen = devCheckRequest({ paths: ["src/x.ts"], diff, level: "full", check: "lint" });
    expect(chosen).toMatchObject({ ok: true, args: { check: "lint" } });
  });

  it("makes no request for a protected file, an empty diff or a halted run", () => {
    for (const path of [
      "AGENTS.md",
      "src/lib/friday/self/governance.ts",
      "electron/tool-authority.cjs",
    ]) {
      expect(devCheckRequest({ paths: [path], diff, level: "full" })).toMatchObject({ ok: false });
    }
    expect(devCheckRequest({ paths: ["src/x.ts"], diff: "  ", level: "balanced" })).toEqual({
      ok: false,
      reason: "nothing to check",
    });
    expect(devCheckRequest({ paths: ["src/x.ts"], diff, level: "balanced", halted: true })).toEqual(
      {
        ok: false,
        reason: "halted",
      },
    );
  });

  it("forwards only a proposal that does not make the check worse", () => {
    expect(devCheckAllows({ ok: true, verdict: "fixed" }).forward).toBe(true);
    expect(devCheckAllows({ ok: true, verdict: "unchanged-pass" }).forward).toBe(true);
    expect(devCheckAllows({ ok: true, verdict: "passes" }).forward).toBe(true);
    for (const verdict of ["regressed", "unchanged-fail", "fails", "odd"]) {
      expect(devCheckAllows({ ok: true, verdict }).forward).toBe(false);
    }
    expect(devCheckAllows({ ok: false }).forward).toBe(false);
  });
});

import { trialAsCheck } from "../../src/lib/friday/self/dev-pipeline";

describe("a recorded trial joins the pipeline's checks", () => {
  it("turns a dev.check verdict into one check, and nothing when there was none", () => {
    expect(trialAsCheck(undefined)).toEqual([]);
    expect(trialAsCheck({ ok: true, verdict: "regressed" })[0]).toMatchObject({
      id: "dev.check",
      ok: false,
    });
    expect(trialAsCheck({ ok: true, verdict: "fixed" })[0]).toMatchObject({ ok: true });
  });
});

import { pathsOfDiff } from "../../src/lib/friday/self/own-work";
import { devPipeline } from "../../src/lib/friday/self/dev-pipeline";

describe("trying a pasted diff on a copy", () => {
  it("reads the paths a diff names", () => {
    expect(
      pathsOfDiff(
        "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/new.ts\n",
      ),
    ).toEqual(["src/x.ts", "new.ts"]);
    expect(pathsOfDiff("")).toEqual([]);
  });

  it("makes no call for a protected file and says why", async () => {
    const result = await devPipeline.tryOnCopy(
      "none",
      "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-a\n+b\n",
    );
    expect(result).toEqual({ ok: false, detail: "protected" });
  });

  it("needs the desktop app to run and records nothing without it", async () => {
    const result = await devPipeline.tryOnCopy(
      "none",
      "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/needs the desktop app|halted|protected/);
  });
});
