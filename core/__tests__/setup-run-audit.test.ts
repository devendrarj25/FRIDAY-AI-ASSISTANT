/**
 * What a second read of the owner's full setup, Doctor and build log (2026-11-20) found, and the checks that keep it fixed:
 * a second `npm run setup` on an up-to-date folder wiped and reinstalled 700 packages; the environment table cut the end
 * off every path inside the FRIDAY folder and repeated "(newer compatible releases pass)" on every row; the closing rule
 * of that table was 78 characters under a 120 character table; a model that was already on disk was announced as
 * "fetching ... once"; an INFO row reported the big speech sizes that were in the plan as if something was unusual; and
 * the build never said that the install-and-chat check exists.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("setup does not install what is already installed", () => {
  it("asks the pipeline's own check before npm ci, and FRIDAY_FORCE_NPM_CI=1 installs anyway", () => {
    const ps = read("scripts/setup-windows.ps1");
    const ask = ps.indexOf("& node.exe scripts\\node-modules-current.cjs");
    const ci = ps.indexOf("with-activity.cjs --label 'npm ci'");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(ci);
    expect(ps).toContain("node_modules already matches package-lock.json; npm ci skipped");
    // The retry with the registry flag is still there inside the install branch.
    expect(ps).toContain("--registry https://registry.npmjs.org/");
    const forced = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "node-modules-current.cjs")],
      {
        env: { ...process.env, FRIDAY_FORCE_NPM_CI: "1" },
      },
    );
    expect(forced.status).toBe(1);
  });
});

describe("the environment table", () => {
  const source = read("scripts/check-environment.cjs");

  it("shows a path inside the FRIDAY folder from the folder, and does not repeat the heading's own sentence", () => {
    expect(source).toContain("const shortPath = (text) =>");
    expect(source).toContain("(newer compatible releases pass)");
    expect(source).toContain("BOILERPLATE");
    // The same table width at the head and at the foot, not 78 under a 120 character table.
    expect(source).not.toContain('"-".repeat(78)');
    expect(source.match(/"-"\.repeat\(tableWidth\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("prints no blank line after the one-line summary of a setup run", () => {
    expect(source).toMatch(
      /if \(summaryOnly\) \{\s*console\.log\(`\[friday\] environment check: all/,
    );
    expect(source).toMatch(/\} else \{\s*console\.log\(""\);\s*\}/);
  });
});

describe("what Doctor and setup say", () => {
  it("a planned big speech size is a PASS row; INFO only when none is planned", () => {
    expect(read("scripts/voice-stack.cjs")).toContain('bigStt.length ? "PASS" : "INFO"');
  });

  it("a semantic-memory model that is already on disk is checked, not 'fetched once'", () => {
    const python = read("scripts/setup-python.cjs");
    expect(python).toContain("is already on disk; checking that it loads");
    expect(python).toContain('"onnx_models", "all-MiniLM-L6-v2", "onnx", "model.onnx"');
  });

  it("the build names the optional install-and-chat check when it skipped it", () => {
    const pipeline = read("scripts/build-pipeline.cjs");
    expect(pipeline).toContain(
      "npm run verify:install runs this build once and chats with it (optional).",
    );
    expect(pipeline).toContain('phase.name === "readiness" && phase.status === "skipped"');
  });
});
