/**
 * The workspace-shell classifier is an allowlist: only known read and check commands are safe ("write"), and
 * every other line is "exec" (the owner approves it first). The old denylist let Remove-Item, Stop-Process, move,
 * ren, robocopy, schtasks and `python -c` through as safe. The renderer table and the main-process table must be the
 * same table, so the gate in the main process and the plan in the renderer never disagree.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  SAFE_COMMANDS,
  classifyCommand,
  extractTerminalRun,
  isRoutineTerminalCommand,
  terminalCommandRisk,
} from "../../src/lib/friday/terminal-command";

const terminal = createRequire(import.meta.url)("../../electron/terminal.cjs") as {
  SAFE_COMMANDS: Array<{ cmd: string }>;
  classifyCommand: (command: string) => "write" | "exec";
};

const MUTATING = [
  "Remove-Item -Recurse C:\\Users\\me\\Documents",
  "remove-item notes.txt",
  "Stop-Process -Name explorer",
  "move a.txt b.txt",
  "ren a.txt b.txt",
  "rename a.txt b.txt",
  "robocopy src dst /MIR",
  "schtasks /create /tn x /tr calc.exe /sc onlogon",
  "python -c \"import os; os.remove('x')\"",
  "python3 -c print(1)",
  "node -e \"require('fs').rmSync('x')\"",
  "copy a.txt b.txt",
  "xcopy src dst /e",
  "mkdir newdir",
  "attrib +h secret.txt",
  "Set-ExecutionPolicy Unrestricted",
  "New-Item x.txt",
  "Set-Content x.txt hi",
  "powershell -Command Remove-Item x",
  "cmd /c del x",
  "start calc",
  "git branch -D main",
  "git stash",
  "git diff --output=patch.txt",
  "npm run lint:fix",
  "npx eslint --fix src",
  "npx prettier --write .",
  "ruff check --fix kernel",
  "npm audit fix",
  "wmic process call create calc",
  "some-unknown-tool --do-things",
  "npm test && Remove-Item x",
  "git status; Stop-Process -Id 4",
];

const READS = [
  "git status",
  "git diff",
  "git log --oneline -5",
  "git branch",
  "git branch -a",
  "npm test",
  "npm run typecheck",
  "npm run lint",
  "npm run docs:check",
  "npm test && npm run typecheck",
  "npx vitest run core/__tests__/x.test.ts",
  "npx tsc --noEmit",
  "pytest kernel/tests",
  "ruff check kernel",
  "go test ./...",
  "cargo test",
  "node --version",
  "python --version",
  "dir",
  "ls -la",
  "pwd",
  "whoami",
  "hostname",
  "ipconfig",
  "tasklist",
  "systeminfo",
  "winget list",
  "Get-Date",
  "Get-ChildItem",
  "Get-Process",
];

describe("terminal commands: allowlist of reads and checks, everything else is exec", () => {
  it("treats each mutating line the old denylist missed as exec, in both processes", () => {
    for (const line of MUTATING) {
      expect(classifyCommand(line), line).toBe("exec");
      expect(terminal.classifyCommand(line), line).toBe("exec");
      expect(terminalCommandRisk(line), line).toBe("exec");
    }
  });

  it("keeps the known reads and checks safe, in both processes", () => {
    for (const line of READS) {
      expect(classifyCommand(line), line).toBe("write");
      expect(terminal.classifyCommand(line), line).toBe("write");
    }
  });

  it("an unknown command is not routine in Auto mode", () => {
    expect(isRoutineTerminalCommand("run Remove-Item notes.txt in the terminal")).toBe(false);
    expect(isRoutineTerminalCommand("run robocopy a b /MIR in the terminal")).toBe(false);
    expect(extractTerminalRun("powershell: Stop-Process -Name explorer")).toMatchObject({
      risk: "exec",
    });
    expect(isRoutineTerminalCommand("run git status in the terminal")).toBe(true);
  });

  it("is one table: the renderer and the main process hold the same allowlist", () => {
    expect(SAFE_COMMANDS.length).toBeGreaterThan(10);
    expect(JSON.stringify(terminal.SAFE_COMMANDS)).toBe(JSON.stringify(SAFE_COMMANDS));
    // Every rule names a command and the names do not repeat, so the first match is the only match.
    const names = SAFE_COMMANDS.map((rule) => rule.cmd);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name === name.toLowerCase() && name.trim() === name)).toBe(true);
  });

  it("an empty line is never exec (nothing runs)", () => {
    expect(classifyCommand("")).toBe("write");
    expect(terminal.classifyCommand("   ")).toBe("write");
  });
});
