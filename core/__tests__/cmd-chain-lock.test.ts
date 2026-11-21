/**
 * The Windows CMD chain (npm run setup, npm run doctor, npm run build:win) ran end to end on the owner's PC and is locked.
 * These checks keep its shape and the guides that describe it from drifting apart: the number of steps each command
 * prints, the files the rulebook names, and the facts INSTALL.md gives a person who follows it.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const pipeline = require_("../../scripts/build-pipeline.cjs") as { PHASES: string[] };
const doctor = require_("../../scripts/doctor.cjs") as { STEPS: unknown[] };

describe("the chain keeps its shape", () => {
  it("setup has nine numbered stages, Doctor ten checks, the build thirteen phases", () => {
    const setup = read("scripts/setup-windows.ps1");
    expect(setup).toContain("$script:StageTotal = 9");
    expect([...setup.matchAll(/^\s*Write-Stage (\d) '/gm)]).toHaveLength(9);
    expect(doctor.STEPS).toHaveLength(10);
    expect(pipeline.PHASES).toHaveLength(13);
  });

  it("the CMD wrapper still hands everything to the one pipeline and keeps its exit code", () => {
    const cmd = read("scripts/build-windows.cmd");
    expect(cmd).toContain('scripts\\build-pipeline.cjs" --channel production --caller cmd %*');
    expect(cmd).toContain("exit /b %FRIDAY_BUILD_CODE%");
    expect(read("package.json")).toContain('"build:win": "scripts\\\\build-windows.cmd"');
  });

  it("the setup script stays 7-bit ASCII with CRLF line ends, so Windows PowerShell 5.1 reads it", () => {
    const bytes = fs.readFileSync(path.join(root, "scripts", "setup-windows.ps1"));
    expect([...bytes].every((b) => b < 128)).toBe(true);
    const text = bytes.toString("latin1");
    expect(text.split("\n").length).toBeGreaterThan(100);
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});

describe("the rulebook and the install guide match the chain", () => {
  const agents = read("AGENTS.md");
  const install = read("INSTALL.md");

  it("AGENTS.md names the locked chain and every file it lists exists", () => {
    const at = agents.indexOf("### The Windows CMD chain is finished and locked");
    expect(at).toBeGreaterThan(-1);
    const block = agents.slice(at, agents.indexOf("### Changing something that already works"));
    const files = [...block.matchAll(/`(scripts\/[a-z0-9-]+\.(?:cjs|ps1|cmd))`/g)].map(
      (m) => m[1]!,
    );
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    for (const needle of ["Step N of 9", "doctor N/10", "build N/13", "▬", "√"]) {
      expect(block, needle).toContain(needle);
    }
  });

  it("INSTALL.md describes the same step counts and the outputs a person sees", () => {
    expect(install).toContain("nine numbered steps");
    expect(install).toContain("ten numbered checks");
    expect(install).toContain("thirteen numbered steps");
    for (const text of [
      "SETUP PASS - FRIDAY is ready to test, build and run.",
      "DOCTOR PASS - FRIDAY is ready to test, build and run.",
      "FRIDAY BUILD READY",
      "npm run setup",
      "npm run doctor",
      "npm run build:win",
      "npm run verify:install",
    ]) {
      expect(install, text).toContain(text);
    }
    for (const phase of pipeline.PHASES) expect(install, phase).toContain(phase);
  });

  it("INSTALL.md carries the shipping version of the repository", () => {
    const id = JSON.parse(read("config/friday-version.json")) as Record<string, number>;
    const version = [id["major"], id["minor"], id["patch"], id["revision"]].join(".");
    expect(install).toContain(`FRIDAY-Setup-${version}.exe`);
  });
});

describe("the chain's files are locked by content", () => {
  const lock = require_("../../scripts/workflow-lock.cjs") as {
    chainFiles: (base?: string) => string[];
    currentChain: (base?: string) => Record<string, string>;
    readChainLock: (file?: string) => Record<string, string>;
    compare: (recorded: Record<string, string>, actual: Record<string, string>) => string[];
  };

  it("records every file AGENTS.md lists, and nothing else", () => {
    const listed = lock.chainFiles();
    expect(listed).toHaveLength(15);
    expect(listed).toContain("scripts/setup-windows.ps1");
    expect(listed).toContain("scripts/build-windows.cmd");
    expect(Object.keys(lock.readChainLock()).sort()).toEqual(listed);
  });

  it("fails when a chain file changes without its lock (node scripts/workflow-lock.cjs --cmd-chain --write)", () => {
    // A change here needs the owner's request or a real log from his PC (AGENTS.md); then the edit and the new
    // lock land together. A new tool, package or model goes into its catalogue instead.
    expect(lock.compare(lock.readChainLock(), lock.currentChain())).toEqual([]);
  });

  it("names a changed, an added and a removed file", () => {
    expect(lock.compare({ a: "1", gone: "3" }, { a: "2", fresh: "4" })).toEqual([
      "a: changed since it was locked",
      "fresh: added, not in the lock",
      "gone: removed, still in the lock",
    ]);
  });
});

describe("what other work adds to setup without touching the chain", () => {
  it("a capability package names its import module in the requirements file, and pip never sees the comment", () => {
    const src = read("scripts/setup-python.cjs");
    const body = src.slice(
      src.indexOf("function parsePins(file) {"),
      src.indexOf("\nconst voiceNames"),
    );
    const parsePins = new Function("fs", `${body}; return parsePins;`)({
      readFileSync: () =>
        [
          "# comment",
          "opencv-python>=4.12.0  # import: cv2",
          'pywin32>=312; sys_platform == "win32"',
          "numpy>=2.5.4",
        ].join("\n"),
    }) as (file: string) => { name: string; spec: string; importName?: string }[];
    expect(parsePins("x")).toEqual([
      { name: "opencv-python", spec: "opencv-python>=4.12.0", importName: "cv2" },
      { name: "pywin32", spec: 'pywin32>=312; sys_platform == "win32"' },
      { name: "numpy", spec: "numpy>=2.5.4" },
    ]);
    expect(src).toContain("pin.importName ||");
  });

  it("the toolkit, the Install Manager catalogue and the runner pins are data the chain reads", () => {
    expect(read("scripts/prefetch-toolkit.cjs")).toContain("config/agent-toolkit.json");
    expect(read("scripts/prefetch-models.cjs")).toContain(
      'require("../config/local-runners.json")',
    );
    expect(read("scripts/setup-python.cjs")).toContain('"requirements-capabilities.txt"');
  });
});
