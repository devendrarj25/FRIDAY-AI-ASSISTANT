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

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const pipeline = require_(path.join(ROOT, "scripts/build-pipeline.cjs")) as {
  PHASES: string[];
  PHASE_COMMANDS: Record<string, string[]>;
};

const pr = read(".github/workflows/pr-validation.yml");
const packageJob = pr.slice(pr.indexOf("\n  package-windows:\n"), pr.indexOf("\n  validate:\n"));

/**
 * covered   → PR Validation runs it (`needle` must appear in package-windows).
 * inside    → it runs inside a covered command (`needle` names that command).
 * gap       → not run by PR Validation today; `why` says what runs it instead.
 */
const COVERAGE: Record<
  string,
  { how: "covered" | "inside" | "gap"; needle?: string; why?: string }
> = {
  "prepare-environment": {
    how: "gap",
    why: "CI jobs install their own toolchain (npm ci, ensure-electron); the CMD pack's setup-python / prefetch-toolkit / init-runtime run only there and in Release",
  },
  "verify-versions": { how: "covered", needle: "scripts/heal-workspace.cjs" },
  "stage-toolchain": { how: "inside", needle: "scripts/electron-pack.cjs" },
  "build-renderer": { how: "covered", needle: "npm run build:desktop" },
  package: { how: "covered", needle: "scripts/electron-pack.cjs --win nsis" },
  "packaged-requires": { how: "inside", needle: "scripts/verify-build.cjs nsis" },
  "sign-hook": {
    how: "gap",
    why: "signing is a no-op hook for NSIS; runs only in the shared pipeline",
  },
  manifest: { how: "inside", needle: "scripts/verify-build.cjs nsis" },
  "verify-artifacts": { how: "covered", needle: "scripts/verify-build.cjs nsis" },
  "verify-boot": {
    how: "gap",
    why: "scripts/verify-boot.cjs (portable/dir boot) runs only in the shared pipeline; the installer smoke boots the installed app instead",
  },
  readiness: {
    how: "gap",
    why: "scripts/readiness-test.cjs --pack runs only in the shared pipeline",
  },
  "packaged-self-check": {
    how: "gap",
    why: "bundled Python / pip / whisper / MCP self-check runs only in the shared pipeline",
  },
  "installer-smoke": { how: "covered", needle: "scripts/windows-installer-smoke.ps1" },
};

describe("every phase of the shared build is accounted for", () => {
  it("lists each pipeline phase, no more and no less", () => {
    expect(Object.keys(COVERAGE).sort()).toEqual([...pipeline.PHASES].sort());
  });

  it("finds the command PR Validation runs for every phase it claims to cover", () => {
    for (const [phase, row] of Object.entries(COVERAGE)) {
      if (row.how === "gap") continue;
      expect(row.needle, phase).toBeTruthy();
      expect(
        packageJob,
        `PR Validation package-windows must run: ${row.needle} (${phase})`,
      ).toContain(row.needle as string);
    }
  });

  it("writes down why each uncovered phase is uncovered", () => {
    const gaps = Object.entries(COVERAGE).filter(([, row]) => row.how === "gap");
    expect(gaps.map(([phase]) => phase).sort()).toEqual([
      "packaged-self-check",
      "prepare-environment",
      "readiness",
      "sign-hook",
      "verify-boot",
    ]);
    for (const [phase, row] of gaps) expect(row.why?.length ?? 0, phase).toBeGreaterThan(20);
  });
});

describe("the update path is proven by every caller", () => {
  it("runs from verify-build, which PR Validation, FRIDAY Release and the CMD pack all run", () => {
    expect(read("scripts/verify-build.cjs")).toContain("verify-update-path.cjs");
    expect(pipeline.PHASE_COMMANDS["verify-artifacts"]).toContain("scripts/verify-build.cjs");
    expect(packageJob).toContain("scripts/verify-build.cjs nsis");
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
    expect(packageJob).toContain("scripts/windows-installer-smoke.ps1");
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
