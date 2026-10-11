/**
 * The command line cmd.exe runs after /d /s /c, proved without Windows.
 * /S strips one outer quote pair and leaves the quoted tokens.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { samePath } from "./helpers/paths";
import { makeTemp, removeTemp } from "./helpers/temp-dir";
import { prependPath, writeCommandStub } from "./helpers/platform-command";

const require_ = createRequire(import.meta.url);
const spawn = require_(path.resolve(__dirname, "../../scripts/win-spawn.cjs")) as {
  quote: (part: string) => string;
  cmdLineAfterSlashS: (operand: string) => string;
  windowsCmdInvocation: (
    cmd: string,
    args?: string[],
  ) => { file: string; args: string[]; windowsVerbatimArguments: boolean };
  planLaunch: (
    cmd: string,
    args?: string[],
    platform?: string,
  ) => { file: string; args: string[]; windowsVerbatimArguments: boolean; shell: boolean };
  batchLauncher: (cmd: string, platform?: string) => boolean;
  windowsExeName: (cmd: string, platform?: string) => string;
  captureOutput: (
    cmd: string,
    args?: string[],
    extra?: { timeout?: number },
  ) => Promise<string | null>;
};

const RUNNER = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\friday-resume-8Yytwd\\gh.cmd";

function stripped(cmd: string, args: string[] = []): string {
  const launch = spawn.windowsCmdInvocation(cmd, args);
  return spawn.cmdLineAfterSlashS(launch.args[3] || "");
}

describe("win-spawn command line", () => {
  it("keeps the hosted gh.cmd operand exactly", () => {
    const launch = spawn.windowsCmdInvocation(RUNNER, ["release", "view", "v1.1.1.2"]);
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(launch.args[3]).toBe(`""${RUNNER}" "release" "view" "v1.1.1.2""`);
    expect(stripped(RUNNER, ["release", "view", "v1.1.1.2"])).toBe(
      `"${RUNNER}" "release" "view" "v1.1.1.2"`,
    );
  });

  it.each([
    [
      "spaces",
      "C:\\Program Files\\FRIDAY\\gh.cmd",
      ["release"],
      `"C:\\Program Files\\FRIDAY\\gh.cmd" "release"`,
    ],
    ["quotes", "gh.cmd", ['say "hi"'], `"gh.cmd" "say ""hi"""`],
    ["caret", "gh.cmd", ["a^b"], `"gh.cmd" "a^b"`],
    ["percent", "gh.cmd", ["100%"], `"gh.cmd" "100%%"`],
    ["ampersand", "gh.cmd", ["a&b"], `"gh.cmd" "a&b"`],
    ["parentheses", "tool.bat", ["file(1)"], `"tool.bat" "file(1)"`],
    ["unicode", "语音.cmd", ["café"], `"语音.cmd" "café"`],
  ])("quotes %s for the line cmd.exe sees", (_label, cmd, args, expected) => {
    expect(stripped(cmd, args)).toBe(expected);
    expect(spawn.quote("100%")).toBe('"100%%"');
  });

  it("routes batch files through cmd.exe and real programs through .exe", () => {
    const batch = spawn.planLaunch("C:\\Program Files\\npm.cmd", ["--version"], "win32");
    expect(batch.windowsVerbatimArguments).toBe(true);
    expect(batch.shell).toBe(false);
    expect(batch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(spawn.cmdLineAfterSlashS(batch.args[3] || "")).toContain('"--version"');
    const git = spawn.planLaunch("git", ["status"], "win32");
    expect(git.file).toBe("git.exe");
    expect(git.args).toEqual(["status"]);
    expect(git.windowsVerbatimArguments).toBe(false);
    expect(spawn.planLaunch("powershell", ["-NoProfile"], "win32").file).toBe("powershell.exe");
    expect(spawn.planLaunch("python", ["-V"], "win32").file).toBe("python.exe");
    expect(spawn.planLaunch("tar", ["-tf", "pack.bin"], "win32").file).toBe("tar.exe");
    expect(spawn.planLaunch("npm", ["test"], "win32").windowsVerbatimArguments).toBe(true);
    expect(spawn.planLaunch("npx.CMD", ["vitest"], "win32").windowsVerbatimArguments).toBe(true);
    const posix = spawn.planLaunch("git", ["status"], "linux");
    expect(posix.file).toBe("git");
    expect(posix.windowsVerbatimArguments).toBe(false);
    expect(spawn.batchLauncher("npm.cmd", "linux")).toBe(false);
    expect(spawn.windowsExeName("C:\\Tools\\git.exe", "win32")).toBe("C:\\Tools\\git.exe");
  });

  it("captures a direct program and compares paths without a filesystem", async () => {
    const text = await spawn.captureOutput(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(text).toBe("ok");
    const dir = makeTemp("friday-path-");
    try {
      expect(samePath(path.join(dir, "A", "b"), path.join(dir, "A", "b"))).toBe(true);
      const stub = writeCommandStub(dir, "gh", path.join(dir, "gh-log.cjs"));
      expect(readFileSync(path.join(dir, "gh.cmd"), "utf8")).not.toContain("#!/bin/sh");
      expect(readFileSync(path.join(dir, "gh"), "utf8")).toContain("#!/bin/sh");
      expect(prependPath(dir, "other").split(path.delimiter)[0]).toBe(dir);
      expect(stub.file).toBe(path.join(dir, process.platform === "win32" ? "gh.cmd" : "gh"));
    } finally {
      removeTemp(dir);
    }
  });
});

describe("temp cleanup", () => {
  it("removes a directory it created", () => {
    const dir = makeTemp("friday-rm-");
    writeFileSync(path.join(dir, "lock.txt"), "x");
    removeTemp(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
