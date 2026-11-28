/**
 * The Windows CMD chain (npm run setup, npm run doctor, npm run build:win) ran end to end on the owner's PC.
 * These checks keep its shape and the guides that describe it from drifting apart: the number of steps each command
 * prints, the files the rulebook names, and the facts INSTALL.md gives a person who follows it.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("AGENTS.md names the CMD chain and every file it lists exists", () => {
    // The section heading starts "### The Windows CMD chain" (the older heading "... is finished and locked" too)
    // and runs to the next heading of level 2 or 3.
    const start = /^### The Windows CMD chain[^\n]*\n/m.exec(agents);
    expect(start).not.toBeNull();
    const rest = agents.slice(start!.index);
    const next = /^#{2,3} /m.exec(rest.slice(start![0].length));
    const block = next ? rest.slice(0, start![0].length + next.index) : rest;
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

describe("the chain's content lock (dormant by owner policy, available when switched on)", () => {
  type Kind = "workflows" | "cmd-chain";
  const lock = require_("../../scripts/workflow-lock.cjs") as {
    chainFiles: (base?: string) => string[];
    currentChain: (base?: string) => Record<string, string>;
    readChainLock: (base?: string) => Record<string, string>;
    writeChainLock: (base?: string) => void;
    isEnforced: (kind: Kind, base?: string) => boolean;
    verify: (kind: Kind, base?: string) => { enforced: boolean; problems: string[] };
    compare: (recorded: Record<string, string>, actual: Record<string, string>) => string[];
  };
  const script = path.join(root, "scripts", "workflow-lock.cjs");
  const lockRel = path.join("config", "cmd-chain-lock.json");

  it("the live chain list is the one AGENTS.md names, and the live lock holds while off or on", () => {
    const listed = lock.chainFiles();
    expect(listed).toHaveLength(15);
    expect(listed).toContain("scripts/setup-windows.ps1");
    expect(listed).toContain("scripts/build-windows.cmd");
    expect(lock.verify("cmd-chain").problems).toEqual([]);
    expect(typeof lock.verify("cmd-chain").enforced).toBe("boolean");
  });

  it("the live lock file is switched off by owner policy", () => {
    const body = JSON.parse(read(lockRel)) as { enforced?: unknown };
    expect(body.enforced).toBe(false);
    expect(lock.isEnforced("cmd-chain")).toBe(false);
  });

  it("names a changed, an added and a removed file", () => {
    expect(lock.compare({ a: "1", gone: "3" }, { a: "2", fresh: "4" })).toEqual([
      "a: changed since it was locked",
      "fresh: added, not in the lock",
      "gone: removed, still in the lock",
    ]);
  });

  describe("on a temporary copy", () => {
    let tmp = "";
    const section = (heading: string) =>
      [
        "# Rules",
        "",
        "## Changing something that already works",
        "",
        heading,
        "",
        "The files: `scripts/one.cjs`, `scripts/two.ps1`, `scripts/three.cmd`, `scripts/one.cjs`.",
        "Nothing else belongs here.",
        "",
      ].join("\n");
    const fixture = (heading: string) => {
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
      for (const name of ["one.cjs", "two.ps1", "three.cmd", "other.cjs"]) {
        fs.writeFileSync(path.join(tmp, "scripts", name), `// ${name}\n`);
      }
      fs.writeFileSync(
        path.join(tmp, "AGENTS.md"),
        `${section(heading)}\n### GitHub workflows\n\nSee \`scripts/other.cjs\`.\n`,
      );
    };
    const setEnforced = (value: unknown) => {
      const file = path.join(tmp, lockRel);
      const body = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      body["enforced"] = value;
      fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    };
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [script, "--cmd-chain", "--root", tmp, ...args], {
        encoding: "utf8",
      });
    const chainList = ["scripts/one.cjs", "scripts/three.cmd", "scripts/two.ps1"];

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-chain-"));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it.each([
      ["the current heading", "### The Windows CMD chain (setup, doctor, build)"],
      ["the older heading", "### The Windows CMD chain is finished and locked"],
    ])("lists exactly the files the section names, under %s", (_label, heading) => {
      fixture(heading);
      expect(lock.chainFiles(tmp)).toEqual(chainList);
      lock.writeChainLock(tmp);
      expect(Object.keys(lock.readChainLock(tmp))).toEqual(chainList);
    });

    it("writing throws and writes nothing when the section is missing or renamed", () => {
      fixture("### A renamed heading");
      expect(lock.chainFiles(tmp)).toEqual([]);
      expect(() => lock.writeChainLock(tmp)).toThrow(/lists no CMD chain files/);
      expect(fs.existsSync(path.join(tmp, lockRel))).toBe(false);
      const run = cli("--write");
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("lists no CMD chain files");
    });

    it("enforced true: unchanged holds, a changed file fails, the CLI follows", () => {
      fixture("### The Windows CMD chain (setup, doctor, build)");
      lock.writeChainLock(tmp);
      setEnforced(true);
      expect(lock.verify("cmd-chain", tmp)).toEqual({ enforced: true, problems: [] });
      expect(cli().status).toBe(0);
      fs.appendFileSync(path.join(tmp, "scripts", "two.ps1"), "# edit\n");
      expect(lock.verify("cmd-chain", tmp).problems).toEqual([
        "scripts/two.ps1: changed since it was locked",
      ]);
      const run = cli();
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("scripts/two.ps1: changed since it was locked");
      expect(cli("--write").status).toBe(0);
      expect(lock.isEnforced("cmd-chain", tmp)).toBe(true);
      expect(cli().status).toBe(0);
    });

    it("enforced false: a changed file passes, the CLI says the lock is off, --write keeps it off", () => {
      fixture("### The Windows CMD chain (setup, doctor, build)");
      lock.writeChainLock(tmp);
      fs.appendFileSync(path.join(tmp, "scripts", "two.ps1"), "# edit\n");
      expect(lock.verify("cmd-chain", tmp)).toEqual({ enforced: false, problems: [] });
      const run = cli();
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("lock is off");
      expect(cli("--write").status).toBe(0);
      expect(lock.isEnforced("cmd-chain", tmp)).toBe(false);
    });
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
