/**
 * One build recipe. The CMD wrapper, FRIDAY Release, and FRIDAY Test Build
 * must run these phases in this order. Named differences are options.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const pipeline = require(path.join(ROOT, "scripts/build-pipeline.cjs")) as {
  PHASES: string[];
  PHASE_COMMANDS: Record<string, string[]>;
  GITHUB_ASSET_LIMIT: number;
  parseArgs: (argv: string[]) => {
    channel: string;
    targets: string[];
    version: string;
    publish: boolean;
    from: string;
    through: string;
  };
  selectedPhases: (options: { from: string; through: string }) => string[];
  commandsFor: (phases?: string[]) => string[];
  installerBounds: (manifest: { budgetBytes: number; packs: unknown[] }) => {
    floor: number;
    ceiling: number;
    assetLimit: number;
  };
  assertPackagedLayout: (input: { releaseDir: string; manifest: unknown; targets: string[] }) => {
    ok: boolean;
  };
  runtimeSmokePlan: (manifest?: unknown) => {
    python: { command: string[] };
    whisper: { command: string[] };
    sandbox: { command: string[] };
    mcp: { command: string[]; expect: string };
  };
};

const stage = require(path.join(ROOT, "scripts/stage-toolchain.cjs")) as {
  stagePlan: (manifest: unknown) => {
    packs: { id: string; dest: string; bytes: number }[];
    sum: number;
  };
};

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "config/toolchain-manifest.json"), "utf8"));
}

describe("build pipeline", () => {
  it("lists one phase order for every caller", () => {
    expect(pipeline.PHASES).toEqual([
      "prepare-environment",
      "verify-versions",
      "stage-toolchain",
      "build-renderer",
      "package",
      "sign-hook",
      "manifest",
      "verify-artifacts",
      "verify-boot",
      "readiness",
      "installer-smoke",
    ]);
    const flat = pipeline.commandsFor();
    expect(flat.indexOf("scripts/check-engines.cjs")).toBeLessThan(
      flat.indexOf("scripts/release-engine.cjs heal"),
    );
    expect(flat.indexOf("scripts/release-engine.cjs heal")).toBeLessThan(
      flat.indexOf("scripts/release-engine.cjs verify"),
    );
    expect(flat.indexOf("scripts/verify-build.cjs")).toBeLessThan(
      flat.indexOf("scripts/readiness-test.cjs --pack"),
    );
    expect(flat).toContain("npm ci --no-audit --no-fund");
    expect(flat).toContain("scripts/windows-installer-smoke.ps1");
  });

  it("parses the owner-facing targets and the named differences", () => {
    const cmd = pipeline.parseArgs([
      "node",
      "build-pipeline.cjs",
      "--channel",
      "production",
      "dir",
    ]);
    expect(cmd.channel).toBe("production");
    expect(cmd.targets).toEqual(["dir"]);
    const test = pipeline.parseArgs([
      "node",
      "build-pipeline.cjs",
      "--channel",
      "test",
      "--version",
      "1.0.1.2-test.4",
      "--targets",
      "nsis,portable",
      "--publish",
    ]);
    expect(test.channel).toBe("test");
    expect(test.version).toBe("1.0.1.2-test.4");
    expect(test.publish).toBe(true);
    expect(test.targets).toEqual(["nsis", "portable"]);
    expect(() => pipeline.parseArgs(["node", "x", "--channel", "beta"])).toThrow(/channel/);
  });

  it("a partial range is still the same phase list, not a second recipe", () => {
    const options = pipeline.parseArgs([
      "node",
      "x",
      "--from",
      "build-renderer",
      "--through",
      "package",
    ]);
    expect(pipeline.selectedPhases(options)).toEqual(["build-renderer", "package"]);
  });

  it("derives the installer floor from the toolchain budget and stays under 2 GiB", () => {
    const bounds = pipeline.installerBounds(manifest());
    const plan = stage.stagePlan(manifest());
    expect(plan.sum).toBe(205084080);
    expect(bounds.floor).toBe(Math.floor(plan.sum * 0.7));
    expect(bounds.ceiling).toBeLessThan(pipeline.GITHUB_ASSET_LIMIT);
    expect(bounds.floor).toBeGreaterThan(100_000_000);
    expect(bounds.assetLimit).toBe(2147483648);
  });

  it("rejects a small installer and a missing staged pack", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-"));
    const release = path.join(root, "release");
    fs.mkdirSync(release, { recursive: true });
    const body = Buffer.alloc(64, 1);
    fs.writeFileSync(path.join(release, "FRIDAY-Setup-1.0.1.2.exe"), body);
    fs.writeFileSync(path.join(release, "FRIDAY-Portable-1.0.1.2.exe"), body);
    const data = manifest();
    expect(() =>
      pipeline.assertPackagedLayout({
        releaseDir: release,
        manifest: data,
        targets: ["nsis", "portable"],
      }),
    ).toThrow(/refusing a small EXE/);

    const plan = stage.stagePlan(data);
    for (const pack of plan.packs) {
      const dir = path.join(release, "win-unpacked", "resources", pack.dest, pack.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pack.bin"), Buffer.alloc(8));
    }
    const big = Buffer.alloc(boundsSafe(data), 2);
    fs.writeFileSync(path.join(release, "FRIDAY-Setup-1.0.1.2.exe"), big);
    fs.writeFileSync(path.join(release, "FRIDAY-Portable-1.0.1.2.exe"), big);
    expect(
      pipeline.assertPackagedLayout({
        releaseDir: release,
        manifest: data,
        targets: ["nsis", "portable"],
      }).ok,
    ).toBe(true);
  });

  it("names the clean-runner probes for Python, whisper.cpp, and the sandbox", () => {
    const plan = pipeline.runtimeSmokePlan();
    expect(plan.python.command).toEqual(["python.exe", "-m", "pip", "--version"]);
    expect(plan.whisper.command[0]).toContain("whisper-cli");
    expect(plan.sandbox.command[0]).toBe("python.exe");
    expect(plan.mcp.command).toEqual(["node", "electron/friday-mcp.cjs"]);
    expect(plan.mcp.expect).toBe("initialize");
  });

  it("keeps the CMD pack, FRIDAY Release, and FRIDAY Test Build on one phase list", () => {
    const cmd = fs.readFileSync(path.join(ROOT, "scripts/build-windows.cmd"), "utf8");
    const release = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
    const testBuild = fs.readFileSync(path.join(ROOT, ".github/workflows/test-build.yml"), "utf8");
    expect(cmd).toContain("--channel production");
    expect(cmd).not.toContain("--from");
    expect(cmd).not.toContain("--through");
    for (const src of [release, testBuild]) {
      expect(src).toContain("--through verify-versions");
      expect(src).toContain("--from stage-toolchain");
    }
    expect(release).toContain("--channel production");
    expect(testBuild).toContain("--channel test");
    const head = pipeline.selectedPhases({
      from: "prepare-environment",
      through: "verify-versions",
    });
    const tail = pipeline.selectedPhases({ from: "stage-toolchain", through: "installer-smoke" });
    expect([...head, ...tail]).toEqual(pipeline.PHASES);
  });

  it("points the CMD wrapper and the npm pack scripts at this pipeline", () => {
    const cmd = fs.readFileSync(path.join(ROOT, "scripts/build-windows.cmd"), "utf8");
    expect(cmd).toContain("build-pipeline.cjs");
    expect(cmd).toContain("22.19.0");
    expect(cmd).not.toContain('if exist "release\\"');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["build:all", "release:package", "build:portable"]) {
      expect(pkg.scripts[name], name).toContain("scripts/build-pipeline.cjs");
    }
    const source = fs.readFileSync(path.join(ROOT, "scripts/build-pipeline.cjs"), "utf8");
    expect(source).toContain("npm cache verify");
    expect(source).toContain("registry.npmjs.org");
    expect(source).toContain("CSC_LINK");
    expect(source).toContain("unsigned build");
    expect(source).toContain("sign-windows.ps1");
    expect(source.indexOf("scripts/release-engine.cjs heal")).toBeLessThan(
      source.indexOf("scripts/electron-pack.cjs"),
    );
  });
});

function boundsSafe(data: { budgetBytes: number; packs: unknown[] }) {
  return pipeline.installerBounds(data).floor;
}
