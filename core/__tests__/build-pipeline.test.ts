/**
 * One build recipe. The CMD wrapper, FRIDAY Release, and FRIDAY Test Build
 * must run these phases in this order. Named differences are options.
 */
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
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
    getPip: { command: string[] } | null;
    whisper: { command: string[] };
    sandbox: { command: string[] };
    mcp: { command: string[]; expect: string; also?: string };
    node: { command: string[] } | null;
    model: { kind: string; file: string } | null;
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
      "packaged-requires",
      "sign-hook",
      "manifest",
      "verify-artifacts",
      "verify-boot",
      "readiness",
      "packaged-self-check",
      "installer-smoke",
    ]);
    const flat = pipeline.commandsFor();
    expect(flat.indexOf("scripts/check-engines.cjs")).toBeLessThan(
      flat.indexOf("scripts/release-engine.cjs heal"),
    );
    expect(flat.indexOf("scripts/release-engine.cjs heal")).toBeLessThan(
      flat.indexOf("scripts/release-engine.cjs verify"),
    );
    expect(flat.indexOf("scripts/packaged-requires.cjs")).toBeGreaterThan(
      flat.indexOf("scripts/electron-pack.cjs"),
    );
    expect(flat.indexOf("scripts/packaged-requires.cjs")).toBeLessThan(
      flat.indexOf("scripts/readiness-test.cjs --pack"),
    );
    expect(flat.indexOf("scripts/verify-build.cjs")).toBeLessThan(
      flat.indexOf("scripts/readiness-test.cjs --pack"),
    );
    expect(flat).toContain("npm ci --no-audit --no-fund");
    expect(flat).toContain("scripts/windows-installer-smoke.ps1");
    expect(flat).toContain("python.exe -m pip --version");
    expect(flat.indexOf("scripts/readiness-test.cjs --pack")).toBeLessThan(
      flat.indexOf("python.exe -m pip --version"),
    );
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
    expect(plan.sum).toBe(205088081);
    expect(bounds.floor).toBe(Math.floor(plan.sum * 0.7));
    expect(bounds.ceiling).toBeLessThan(pipeline.GITHUB_ASSET_LIMIT);
    expect(bounds.floor).toBeGreaterThan(100_000_000);
    expect(bounds.assetLimit).toBe(2147483648);
  });

  it("copies staged packs into resources/<dest>, not a nested resources folder", async () => {
    const yaml = require("js-yaml") as { load: (text: string) => unknown };
    const { getFileMatchers } = require("app-builder-lib/out/fileMatcher.js") as {
      getFileMatchers: (
        config: unknown,
        name: string,
        destination: string,
        options: Record<string, unknown>,
      ) => Array<{
        from: string;
        to: string;
        isEmpty: () => boolean;
        prependPattern: (pattern: string) => void;
        createFilter: () => (file: string, stat: { isDirectory: () => boolean }) => boolean;
      }>;
    };
    const { copyDir } = require("builder-util/out/fs.js") as {
      copyDir: (
        src: string,
        destination: string,
        options?: { filter?: (file: string, stat: { isDirectory: () => boolean }) => boolean },
      ) => Promise<void>;
    };
    const config = yaml.load(fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "friday-extra-"));
    for (const rel of [
      "resources/toolchain/python-embed/pack.bin",
      "resources/speech/whisper-cpp/pack.bin",
      "resources/icons/friday.ico",
    ]) {
      const file = path.join(project, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(rel));
    }
    const resourcesDir = path.join(project, "win-unpacked", "resources");
    const matchers = getFileMatchers(config, "extraResources", resourcesDir, {
      macroExpander: (value: string) => value,
      customBuildOptions: {},
      globalOutDir: path.join(project, "out"),
      defaultSrc: project,
    });
    const resourcesMatcher = matchers.find(
      (matcher) => matcher.from === path.join(project, "resources"),
    );
    expect(resourcesMatcher, "resources extraResource").toBeTruthy();
    expect(resourcesMatcher?.to).toBe(resourcesDir);
    if (!resourcesMatcher) throw new Error("resources extraResource missing");
    if (resourcesMatcher.isEmpty()) resourcesMatcher.prependPattern("**/*");
    await copyDir(resourcesMatcher.from, resourcesMatcher.to, {
      filter: resourcesMatcher.createFilter(),
    });
    for (const rel of [
      "toolchain/python-embed/pack.bin",
      "speech/whisper-cpp/pack.bin",
      "icons/friday.ico",
    ]) {
      expect(fs.existsSync(path.join(resourcesDir, rel)), rel).toBe(true);
      expect(fs.existsSync(path.join(resourcesDir, "resources", rel)), `nested ${rel}`).toBe(false);
    }
    const main = fs.readFileSync(path.join(ROOT, "electron/main.cjs"), "utf8");
    expect(main).toContain('path.join(process.resourcesPath || "", "icons", "friday.ico")');
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
    expect(plan.getPip?.command).toEqual(["python.exe", "get-pip.py"]);
    expect(plan.mcp.also).toBe("FRIDAY is not running");
    expect(plan.whisper.command[0]).toContain("whisper-cli");
    expect(plan.sandbox.command[0]).toBe("python.exe");
    expect(plan.mcp.command).toEqual(["node", "electron/friday-mcp.cjs"]);
    expect(plan.mcp.expect).toBe("initialize");
    expect(plan.node?.command).toEqual(["node.exe", "--version"]);
    expect(plan.model?.kind).toBe("header");
    expect(plan.model?.file).toBe("ggml-base.bin");
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
    expect(cmd).toContain("%*");
    expect(source).toContain("FRIDAY_OFFLINE");
    expect(fs.readFileSync(path.join(ROOT, "scripts/stage-toolchain.cjs"), "utf8")).toContain(
      "offline build:",
    );
  });

  it("exports every win-spawn name the prepare step calls", () => {
    const spawn = require(path.join(ROOT, "scripts/win-spawn.cjs")) as Record<
      string,
      (...args: unknown[]) => { status: number | null }
    >;
    const source = fs.readFileSync(path.join(ROOT, "scripts/build-pipeline.cjs"), "utf8");
    const match = source.match(/const \{([^}]+)\} = require\("\.\/win-spawn\.cjs"\)/);
    expect(match).toBeTruthy();
    const names = String(match?.[1] || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    expect(names).toContain("spawnDirect");
    for (const name of names) {
      expect(typeof spawn[name], name).toBe("function");
    }
    const spawnDirect = spawn["spawnDirect"];
    if (!spawnDirect) throw new Error("spawnDirect is not exported");
    const result = spawnDirect(process.execPath, ["-e", "process.exit(0)"]);
    expect(result.status).toBe(0);
  });

  it("passes a .cmd launch to cmd.exe without a second round of quotes", () => {
    const spawn = require(path.join(ROOT, "scripts/win-spawn.cjs")) as {
      windowsCmdInvocation: (
        cmd: string,
        args?: string[],
      ) => { file: string; args: string[]; windowsVerbatimArguments: boolean };
    };
    const cmd = "C:\\Program Files\\FRIDAY\\gh.cmd";
    const launch = spawn.windowsCmdInvocation(cmd, ["release", "view", "v1.1.1.2"]);
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const operand = launch.args[3] || "";
    expect(operand.startsWith('"')).toBe(true);
    expect(operand.endsWith('"')).toBe(true);
    const last = operand.lastIndexOf('"');
    const runnable = operand.slice(1, last) + operand.slice(last + 1);
    expect(runnable.startsWith(`"${cmd}"`)).toBe(true);
    expect(runnable).toContain('"release" "view" "v1.1.1.2"');
    const runnerCmd = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\friday-resume-8Yytwd\\gh.cmd";
    const rejected = spawn.windowsCmdInvocation(runnerCmd, ["release", "view", "v1.1.1.2"]);
    expect(rejected.args[3]).toBe(`""${runnerCmd}" "release" "view" "v1.1.1.2""`);
    expect(rejected.windowsVerbatimArguments).toBe(true);
  });

  it("skips the packaged self-check off Windows and fails a missing unpack", () => {
    const checker = pipeline as unknown as {
      runPackagedSelfCheck: (input: Record<string, unknown>) => string;
      signingStatusLines: (env?: NodeJS.ProcessEnv) => string[];
      parseArgs: (argv: string[]) => { offline: boolean };
    };
    expect(checker.runPackagedSelfCheck({ platform: "linux" })).toMatch(
      /^skipped: packaged self-check runs on Windows only/,
    );
    expect(() =>
      checker.runPackagedSelfCheck({
        platform: "win32",
        unpackDir: path.join(os.tmpdir(), "friday-missing-unpack"),
      }),
    ).toThrow(/packaged app directory is missing/);
    const secret = "pfx-password-must-not-appear";
    const lines = checker.signingStatusLines({ CSC_KEY_PASSWORD: secret });
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).toMatch(/SmartScreen/);
    const remover = pipeline as unknown as {
      REMOVE_OPTIONS: { maxRetries: number; retryDelay: number; force: boolean };
      removeTree: (target: string) => void;
    };
    expect(remover.REMOVE_OPTIONS.maxRetries).toBe(5);
    expect(remover.REMOVE_OPTIONS.retryDelay).toBe(100);
    const locked = fs.mkdtempSync(path.join(os.tmpdir(), "friday-rm-"));
    fs.writeFileSync(path.join(locked, "keep.txt"), "x");
    remover.removeTree(locked);
    expect(fs.existsSync(locked)).toBe(false);
    const offline = checker.parseArgs(["node", "x", "--offline"]);
    expect(offline.offline).toBe(true);
  });

  it("runs the packaged probes from an extracted layout and fails a bad probe", () => {
    const checker = pipeline as unknown as {
      runPackagedSelfCheck: (input: Record<string, unknown>) => string;
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-self-"));
    const unpack = path.join(root, "win-unpacked");
    const body = Buffer.from("pack");
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const manifest = {
      budgetBytes: 100,
      packs: [
        {
          id: "python-embed",
          tier: "bundled",
          sha256: sha,
          bytes: body.length,
          license: "MIT",
        },
        {
          id: "whisper-cpp",
          tier: "bundled",
          sha256: sha,
          bytes: body.length,
          license: "MIT",
        },
      ],
    };
    for (const rel of [
      "resources/toolchain/python-embed/pack.bin",
      "resources/speech/whisper-cpp/pack.bin",
    ]) {
      const file = path.join(unpack, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    const ran: string[] = [];
    const commands: string[][] = [];
    const detail = checker.runPackagedSelfCheck({
      platform: "win32",
      unpackDir: unpack,
      root,
      manifest,
      extract: (_pack: string, dest: string) => {
        if (dest.endsWith("python")) fs.writeFileSync(path.join(dest, "python.exe"), "");
        else {
          fs.mkdirSync(path.join(dest, "Release"), { recursive: true });
          fs.writeFileSync(path.join(dest, "Release", "whisper-cli.exe"), "");
        }
      },
      runner: (probe: { name: string; command?: string[]; stdin?: string; expect?: string }) => {
        ran.push(probe.name);
        commands.push(probe.command || []);
        if (probe.name === "mcp") expect(probe.stdin || "").toContain("initialize");
        return { status: 0, stdout: probe.expect || "ok" };
      },
    });
    expect(ran).toEqual(["python", "sandbox", "whisper", "mcp"]);
    expect(commands[0]).toEqual(["python.exe", "-m", "pip", "--version"]);
    expect(commands[1]?.[0]).toBe("python.exe");
    expect(commands[2]?.join(" ")).toMatch(/-h$/);
    expect(commands[3]).toContain("electron/friday-mcp.cjs");
    expect(detail).toContain("python ok");
    expect(detail).toContain("mcp ok");
    expect(() =>
      checker.runPackagedSelfCheck({
        platform: "win32",
        unpackDir: unpack,
        root,
        manifest,
        workDir: path.join(root, "again"),
        extract: () => {},
        runner: (probe: { name: string }) => ({
          status: probe.name === "whisper" ? 1 : 0,
          stdout: "initialize",
        }),
      }),
    ).toThrow(/whisper failed \(1\): initialize/);
  });

  it("bootstraps pip from the pinned script and flattens the Node zip before the probes", () => {
    const checker = pipeline as unknown as {
      runPackagedSelfCheck: (input: Record<string, unknown>) => string;
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pip-"));
    const unpack = path.join(root, "win-unpacked");
    const body = Buffer.from("pack-bytes");
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const pack = (id: string) => ({
      id,
      tier: "bundled",
      sha256: sha,
      bytes: body.length,
      license: "MIT",
    });
    const manifest = {
      budgetBytes: 1000,
      packs: [pack("python-embed"), pack("get-pip"), pack("whisper-cpp"), pack("node-win")],
    };
    for (const rel of [
      "resources/toolchain/python-embed/pack.bin",
      "resources/toolchain/get-pip/pack.bin",
      "resources/speech/whisper-cpp/pack.bin",
      "resources/toolchain/node-win/pack.bin",
    ]) {
      const file = path.join(unpack, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    const commands: string[][] = [];
    const detail = checker.runPackagedSelfCheck({
      platform: "win32",
      unpackDir: unpack,
      root,
      manifest,
      extract: (_packFile: string, dest: string) => {
        if (dest.endsWith("python")) fs.writeFileSync(path.join(dest, "python.exe"), "");
        else if (dest.endsWith("whisper")) fs.writeFileSync(path.join(dest, "whisper-cli.exe"), "");
        else if (dest.endsWith("node")) {
          const nested = path.join(dest, "node-v22.23.3-win-x64");
          fs.mkdirSync(nested, { recursive: true });
          fs.writeFileSync(path.join(nested, "node.exe"), "");
        }
      },
      runner: (probe: {
        name: string;
        command?: string[];
        cwd?: string;
        expect?: string;
        stdin?: string;
      }) => {
        commands.push(probe.command || []);
        if (probe.name === "node" && probe.cwd) {
          expect(fs.existsSync(path.join(probe.cwd, "node.exe"))).toBe(true);
        }
        if (probe.name === "mcp") expect(probe.stdin || "").toContain("initialize");
        return { status: 0, stdout: probe.expect || "ok" };
      },
    });
    const pythonDir = path.join(root, "self-check", "python");
    expect(fs.readFileSync(path.join(pythonDir, "get-pip.py")).equals(body)).toBe(true);
    const pth = fs.readFileSync(path.join(pythonDir, "python312._pth"), "utf8");
    expect(pth).toMatch(/^import site$/m);
    expect(pth).not.toMatch(/^#import site/m);
    expect(commands[0]).toEqual(["python.exe", "get-pip.py"]);
    expect(commands[1]).toEqual(["python.exe", "-m", "pip", "--version"]);
    expect(commands.map((command) => command.join(" ")).join("\n")).toContain("whisper-cli.exe -h");
    expect(detail).toContain("get-pip ok");
    expect(detail).toContain("python ok");
    expect(detail).toContain("node ok");
  });

  it("names the official and test differences and keeps new checks in the pipeline", () => {
    const release = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
    const testBuild = fs.readFileSync(path.join(ROOT, ".github/workflows/test-build.yml"), "utf8");
    const smoke = fs.readFileSync(path.join(ROOT, "scripts/windows-installer-smoke.ps1"), "utf8");
    expect(release).toContain("--channel production");
    expect(testBuild).toContain("--channel test");
    expect(testBuild).toContain("--prerelease");
    expect(testBuild).toContain("Keep only the last 3 TEST prereleases");
    expect(testBuild).toContain("select(.isPrerelease)");
    expect(testBuild).toContain("gh release delete");
    expect(testBuild).toContain("official (non-prerelease) releases are never");
    expect(release).toContain("merged tree is not the validated tree");
    const publish = release.slice(release.indexOf("\n  publish:\n"));
    expect(publish).not.toContain("npm test");
    expect(publish).toContain("--require-reuse");
    expect(publish.indexOf("npm run typecheck")).toBeLessThan(
      publish.indexOf("Build with the shared pipeline"),
    );
    const notesAt = publish.indexOf("- name: Restore reviewed release notes before packaging");
    expect(notesAt).toBeGreaterThan(publish.indexOf("Require a fresh green PR Validation"));
    expect(publish.slice(notesAt, notesAt + 400)).toContain("guard-notes");
    const verifyAt = publish.indexOf("- name: Verify version/documentation synchronization");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(publish.indexOf("Build with the shared pipeline"));
    expect(smoke).toContain("Assert-NoInstallOrphans");
    expect(smoke).toContain("Verify-UpdateManifest");
    expect(smoke).toContain("kernel health");
    expect(smoke).toContain('ArgumentList @("/S"');
    expect(fs.readFileSync(path.join(ROOT, "scripts/build-pipeline.cjs"), "utf8")).toContain(
      '"-ReleaseDir"',
    );
    expect(testBuild).toContain("build-pipeline.cjs");
    expect(testBuild).not.toContain("windows-installer-smoke.ps1");
  });
});

function boundsSafe(data: { budgetBytes: number; packs: unknown[] }) {
  return pipeline.installerBounds(data).floor;
}
