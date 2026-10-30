/**
 * One gate: preflight, PR Validation, and FRIDAY Release publish name the
 * same checks. Platform-only and evidence-only exceptions are listed here.
 */
import { prRuns } from "./helpers/pr-validation";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const aggregate = require("../../scripts/pr-validation-aggregate.cjs") as {
  aggregate: (input: Record<string, string>) => {
    state: string;
    description: string;
    failed: Array<{ name: string; reproduce: string }>;
  };
};
const freshness = require("../../scripts/validation-freshness.cjs") as {
  releaseGate: (
    decision: { action: string; reuse: boolean; reason: string },
    sha: string,
  ) => { ok: boolean; message: string };
  releaseEvidenceCandidates: (input: {
    head?: string;
    headTree?: string;
    validated?: string;
    validatedTree?: string;
    mergeParent?: string;
    mergeParentTree?: string;
  }) => { ok: boolean; candidates: string[]; reason: string };
};
const preflight = require("../../scripts/preflight.cjs") as {
  GATES: Array<{ id: string }>;
  changedGateIds: (files: string[]) => Set<string>;
};

const pr = read(".github/workflows/pr-validation.yml");
const release = read(".github/workflows/release.yml");
const publish = release.slice(release.indexOf("\n  publish:\n"), release.indexOf("\n  confirm:\n"));

/**
 * Where each preflight gate must appear.
 * `evidence` means publish refuses to continue unless PR Validation already
 * passed that gate on this tree. `pipeline` means the shared Windows build
 * runs it. `local` means the fast tier is the workstation command only.
 */
const HOST: Record<string, "pr" | "pr-and-publish" | "evidence" | "pipeline" | "local"> = {
  "heal-check": "pr",
  typecheck: "pr-and-publish",
  docs: "pr-and-publish",
  version: "pr-and-publish",
  "tests-required": "pr",
  provenance: "pr",
  "added-files": "pr",
  lint: "pr",
  actionlint: "pr",
  arrange: "pr-and-publish",
  deps: "pr-and-publish",
  audit: "pr-and-publish",
  kernel: "evidence",
  pyright: "evidence",
  "test-fast": "local",
  test: "evidence",
  electron: "pipeline",
  renderer: "pipeline",
  nsis: "pipeline",
  "verify-build": "pipeline",
  smoke: "pipeline",
};

const PR_NEEDLE: Record<string, string> = {
  "heal-check": "heal --check",
  typecheck: "npm run typecheck",
  docs: "npm run docs:check",
  version: "npm run verify:version",
  "tests-required": "tests-required.cjs",
  provenance: "check-provenance.cjs",
  "added-files": "check-added-files.cjs",
  lint: "npm run lint",
  actionlint: "run-actionlint.cjs",
  arrange: "arrange-project.cjs",
  deps: "verify-deps.cjs",
  audit: "audit-architecture.cjs --strict",
  kernel: "npm run test:kernel",
  pyright: "npm run typecheck:py",
  test: "npm test",
  electron: "ensure-electron.cjs",
  renderer: "npm run build:desktop",
  nsis: "electron-pack.cjs",
  "verify-build": "verify-build.cjs",
  smoke: "windows-installer-smoke.ps1",
};

describe("one gate parity", () => {
  it("names every preflight gate in PR Validation or as a listed exception", () => {
    const ids = preflight.GATES.map((gate) => gate.id).concat(["nsis", "verify-build", "smoke"]);
    for (const id of ids) {
      expect(HOST[id], id).toBeTruthy();
    }
    for (const id of Object.keys(HOST)) {
      const kind = HOST[id];
      if (kind === "local") {
        expect(read("scripts/preflight.cjs")).toContain(id);
        continue;
      }
      if (kind === "evidence") {
        expect(publish).toContain("--require-reuse");
        expect(publish).not.toContain("npm test");
        if (PR_NEEDLE[id]) expect(pr).toContain(PR_NEEDLE[id]);
        continue;
      }
      if (kind === "pipeline") {
        // PR Validation and Release run these through the same shared pipeline.
        expect(prRuns(PR_NEEDLE[id] as string), id).toBe(true);
        expect(pr).toContain("build-pipeline.cjs --channel production --caller pr-validation");
        expect(publish).toContain("build-pipeline.cjs");
        continue;
      }
      expect(pr).toContain(PR_NEEDLE[id]);
      if (kind === "pr-and-publish") {
        if (id === "typecheck") expect(publish).toContain("npm run typecheck");
        if (id === "docs") expect(publish).toContain("npm run docs:check");
        if (id === "version") expect(publish).toContain("release-engine.cjs verify");
        if (id === "arrange") expect(publish).toContain("arrange-project.cjs");
        if (id === "deps") expect(publish).toContain("verify-deps.cjs");
        if (id === "audit") expect(publish).toContain("audit-architecture.cjs --strict");
      }
    }
  });

  it("classifies a code change without running the Windows pack", () => {
    const always = preflight.changedGateIds(["README.md"]);
    for (const id of ["provenance", "added-files", "tests-required"]) {
      expect(always.has(id), id).toBe(true);
    }
    const ids = preflight.changedGateIds(["electron/updater.cjs"]);
    expect(ids.has("typecheck")).toBe(true);
    expect(ids.has("test-fast")).toBe(true);
    expect(ids.has("nsis")).toBe(false);
  });
});

describe("PR Validation aggregate", () => {
  it("publishes success only when every parallel job succeeded", () => {
    const ok = aggregate.aggregate({
      static: "success",
      kernel: "success",
      tests: "success",
      package: "success",
      update: "success",
      audit: "success",
      secrets: "success",
    });
    expect(ok.state).toBe("success");
    expect(ok.failed).toEqual([]);
  });

  it("names the failed job and keeps a red status when one job fails", () => {
    const bad = aggregate.aggregate({
      static: "failure",
      kernel: "success",
      tests: "success",
      package: "success",
      update: "success",
      audit: "success",
      secrets: "success",
    });
    expect(bad.state).toBe("failure");
    expect(bad.description).toContain("static");
    expect(bad.failed[0]?.reproduce).toBe("npm run preflight");
  });

  it("fails closed when a required job was skipped", () => {
    const skipped = aggregate.aggregate({
      static: "success",
      kernel: "skipped",
      tests: "success",
      package: "success",
      update: "success",
      audit: "success",
      secrets: "success",
    });
    expect(skipped.state).toBe("failure");
  });

  it("is red when the secret scan, the advisory audit or the update test is red, skipped or missing", () => {
    const base = { static: "success", kernel: "success", tests: "success", package: "success" };
    for (const [name, value] of [
      ["secrets", "failure"],
      ["secrets", "skipped"],
      ["audit", "failure"],
      ["audit", "skipped"],
      ["update-windows", "failure"],
      ["update-windows", "skipped"],
    ] as const) {
      const out = aggregate.aggregate({
        ...base,
        update: "success",
        audit: "success",
        secrets: "success",
        [name === "update-windows" ? "update" : name]: value,
      });
      expect(out.state, `${name} ${value}`).toBe("failure");
      expect(out.description).toContain(name);
    }
    // A caller that forgets to pass them can never publish success.
    expect(aggregate.aggregate(base).state).toBe("failure");
    expect(
      aggregate.aggregate({ ...base, update: "success", audit: "cancelled", secrets: "success" })
        .state,
    ).toBe("error");
  });

  it("waits for the secret scan and the audit before it publishes the status", () => {
    const validate = pr.slice(pr.indexOf("\n  validate:\n"), pr.indexOf("\n  docs-only:\n"));
    expect(validate).toContain(
      "needs: [gate, static, kernel, tests-windows, package-windows, update-windows, audit, secrets]",
    );
    expect(validate).toContain('--update "$UPDATE"');
    expect(validate).toContain('--audit "$AUDIT"');
    expect(validate).toContain('--secrets "$SECRETS"');
  });
});

describe("publish evidence gate", () => {
  const sha = "b".repeat(40);
  const now = "2026-06-15T12:00:00.000Z";

  it("refuses a missing or red validation before any release is created", () => {
    const missing = freshness.releaseGate(
      { action: "run", reuse: false, reason: "no PR Validation evidence on this commit" },
      sha,
    );
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain(sha);
    expect(missing.message).toContain("Publish does not re-run the suite");
    const red = freshness.releaseGate(
      { action: "run", reuse: false, reason: "latest PR Validation is failure" },
      sha,
    );
    expect(red.ok).toBe(false);
  });

  it("accepts a fresh green status from an evidence file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-evidence-"));
    const file = path.join(dir, "evidence.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          context: "PR Validation",
          state: "success",
          updated_at: "2026-06-14T12:00:00.000Z",
          sha,
        },
      ]),
    );
    const ok = spawnSync(
      process.execPath,
      [
        "scripts/validation-freshness.cjs",
        "--sha",
        sha,
        "--evidence",
        file,
        "--now",
        now,
        "--require-reuse",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(ok.status).toBe(0);
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          context: "PR Validation",
          state: "failure",
          updated_at: "2026-06-14T12:00:00.000Z",
          sha,
        },
      ]),
    );
    const denied = spawnSync(
      process.execPath,
      [
        "scripts/validation-freshness.cjs",
        "--sha",
        sha,
        "--evidence",
        file,
        "--now",
        now,
        "--require-reuse",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).toContain("not fresh and green");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("asks HEAD first, then a merge parent with the same tree", () => {
    const head = "a".repeat(40);
    const parent = "b".repeat(40);
    const tree = "c".repeat(40);
    const same = freshness.releaseEvidenceCandidates({
      head,
      headTree: tree,
      mergeParent: parent,
      mergeParentTree: tree,
    });
    expect(same.ok).toBe(true);
    expect(same.candidates).toEqual([head, parent]);
    const drifted = freshness.releaseEvidenceCandidates({
      head,
      headTree: tree,
      mergeParent: parent,
      mergeParentTree: "d".repeat(40),
    });
    expect(drifted.candidates).toEqual([head]);
    const pinned = freshness.releaseEvidenceCandidates({
      head,
      headTree: tree,
      validated: parent,
      validatedTree: "e".repeat(40),
    });
    expect(pinned.ok).toBe(false);
    expect(pinned.candidates).toEqual([]);
    expect(pinned.reason).toContain("merged tree is not the validated tree");
    expect(publish).toContain("releaseEvidenceCandidates");
    expect(publish).toContain("HEAD^2");
  });
});
