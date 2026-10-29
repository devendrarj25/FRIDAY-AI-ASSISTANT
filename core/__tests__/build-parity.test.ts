/**
 * One build, three callers. The CMD pack, FRIDAY Release and FRIDAY Test Build
 * run scripts/build-pipeline.cjs; PR Validation's package-windows job runs a
 * subset of the same commands. A green PR only means something for the phases it
 * actually runs, so every phase of the shared pipeline is listed here with how
 * PR Validation covers it, or why it does not yet. Adding a phase (or covering
 * one) fails this test until the table says so, so the gap can never grow quietly.
 * The workflow files are only read here.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { phasesRunByPr, pipeline } from "./helpers/pr-validation";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const pr = read(".github/workflows/pr-validation.yml");
const packageJob = pr.slice(pr.indexOf("\n  package-windows:\n"), pr.indexOf("\n  validate:\n"));

describe("PR Validation runs every phase of the shared build", () => {
  it("calls the shared pipeline with the production channel, exactly as FRIDAY Release does", () => {
    expect(packageJob).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller pr-validation --through verify-versions",
    );
    expect(packageJob).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller pr-validation --from stage-toolchain",
    );
    const release = read(".github/workflows/release.yml");
    expect(release).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller release --through verify-versions",
    );
    expect(release).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller release --from stage-toolchain",
    );
  });

  it("covers every phase of the pipeline: no gap between a green PR and a release build", () => {
    expect(phasesRunByPr()).toEqual(pipeline.PHASES);
  });

  it("builds both deliverables, unsigned and unpublished", () => {
    const parsed = pipeline.parseArgs([
      "node",
      "build-pipeline.cjs",
      "--channel",
      "production",
      "--caller",
      "pr-validation",
    ]);
    expect(parsed.targets).toEqual(["nsis", "portable"]);
    expect(packageJob).not.toContain("--publish");
    expect(packageJob).not.toContain("CSC_");
    expect(packageJob).not.toContain("WINDOWS_SIGNING");
  });

  it("keeps the old separate Windows steps out, so there is one way to build", () => {
    for (const old of [
      "node scripts/electron-pack.cjs",
      "node scripts/verify-build.cjs",
      "-File scripts/windows-installer-smoke.ps1",
      "run: npm run build:desktop",
    ]) {
      expect(packageJob, old).not.toContain(old);
    }
  });
});

describe("the update path is proven by every caller", () => {
  it("runs from verify-build, which PR Validation, FRIDAY Release and the CMD pack all run", () => {
    expect(read("scripts/verify-build.cjs")).toContain("verify-update-path.cjs");
    expect(pipeline.PHASE_COMMANDS["verify-artifacts"]).toContain("scripts/verify-build.cjs");
    expect(phasesRunByPr()).toContain("verify-artifacts");
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("scripts/build-pipeline.cjs --channel production --caller release");
  });

  it("checks that every electron module is inside the package, from verify-build as well as its own phase", () => {
    const verify = read("scripts/verify-build.cjs");
    expect(verify).toContain("packaged-requires.cjs");
    expect(verify).toContain('"--asar", asar');
    expect(pipeline.PHASE_COMMANDS["packaged-requires"]).toContain("scripts/packaged-requires.cjs");
  });

  it("is exercised by the installer smoke too: install, boot, reinstall, silent update, uninstall", () => {
    const smoke = read("scripts/windows-installer-smoke.ps1");
    for (const step of ["Run-Setup", "Verify-Boot", '"--updated", "--force-run"', "/DELETEDATA"]) {
      expect(smoke).toContain(step);
    }
    expect(phasesRunByPr()).toContain("installer-smoke");
  });
});

describe("the CMD pack is the same build as Release", () => {
  it("is a thin wrapper over the shared pipeline with the production channel", () => {
    const cmd = read("scripts/build-windows.cmd");
    expect(cmd).toContain('scripts\\build-pipeline.cjs" --channel production --caller cmd');
    expect(cmd).not.toContain("electron-pack.cjs");
    expect(cmd).not.toContain("release-manifest.cjs");
  });

  it("builds the same two deliverables and the same manifest as Release", () => {
    const parsed = (
      require_(path.join(ROOT, "scripts/build-pipeline.cjs")) as {
        parseArgs: (argv: string[]) => { targets: string[]; channel: string };
      }
    ).parseArgs(["node", "build-pipeline.cjs", "--channel", "production", "--caller", "cmd"]);
    expect(parsed.targets).toEqual(["nsis", "portable"]);
    expect(pipeline.PHASE_COMMANDS["manifest"]).toEqual(["scripts/release-manifest.cjs"]);
    // Release attaches exactly what the pipeline produces: the installer's block map included.
    const release = read(".github/workflows/release.yml");
    expect(release).toContain('exe.blockmap" \\');
  });
});
