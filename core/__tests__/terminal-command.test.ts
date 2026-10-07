import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import {
  classifyCommand,
  classifyConsoleInput,
  extractTerminalRun,
  isRoutineTerminalCommand,
  looksLikeShellCommand,
  resolveTerminalShell,
} from "../../src/lib/friday/terminal-command";

const terminal = createRequire(import.meta.url)("../../electron/terminal.cjs") as {
  classifyCommand: (command: string) => "write" | "exec";
  listShells: (ctx?: object) => Array<{
    id: string;
    available: boolean;
    reason?: string;
  }>;
};

describe("terminal command classification", () => {
  it("keeps renderer classifyCommand in lockstep with electron/terminal.cjs", () => {
    const samples = [
      "git status",
      "npm install",
      "npm test",
      "npm test && npm run typecheck",
      "npm test && npm install",
      "npm run build",
      "rm -rf build",
      "git push",
      "git commit -m ok",
      "dir",
      "winget list",
      "winget install Git.Git",
      "curl https://example.com",
      "echo hi | more",
      "docker build .",
      "go test ./...",
      "cargo test",
      "dotnet restore",
      "uv pip install ruff",
    ];
    for (const sample of samples) {
      expect(classifyCommand(sample), sample).toBe(terminal.classifyCommand(sample));
    }
  });

  it("lets checks and tests through; keeps installs and chains with installs as exec", () => {
    expect(classifyCommand("npm test")).toBe("write");
    expect(classifyCommand("npm test && npm run typecheck")).toBe("write");
    expect(classifyCommand("git status")).toBe("write");
    expect(classifyCommand("winget list")).toBe("write");
    expect(classifyCommand("npm install")).toBe("exec");
    expect(classifyCommand("npm test && npm install")).toBe("exec");
    expect(classifyCommand("winget install Git.Git")).toBe("exec");
    expect(classifyCommand("git commit -am fix")).toBe("exec");
    expect(classifyCommand("npm run build")).toBe("exec");
    expect(classifyCommand("docker build .")).toBe("exec");
    expect(classifyCommand("go test ./...")).toBe("write");
    expect(classifyCommand("cargo test")).toBe("write");
    expect(classifyCommand("dotnet restore")).toBe("exec");
  });

  it("sends English questions to FRIDAY instead of cmd.exe", () => {
    expect(classifyConsoleInput("why did npm test fail").kind).toBe("ask");
    expect(classifyConsoleInput("? explain that error").kind).toBe("ask");
    expect(classifyConsoleInput("! git status").kind).toBe("shell");
    expect(classifyConsoleInput("git status").kind).toBe("shell");
    expect(classifyConsoleInput("help").kind).toBe("builtin");
  });

  it("extracts Auto Mode / chat runs onto the workspace terminal", () => {
    expect(extractTerminalRun("run git status in the terminal")).toMatchObject({
      command: "git status",
      tool: "shell.cmd",
    });
    expect(extractTerminalRun("powershell: Get-Date")).toMatchObject({
      command: "Get-Date",
      tool: "shell.powershell",
      shell: "powershell",
    });
    expect(extractTerminalRun("run dir")).toMatchObject({ command: "dir", risk: "safe" });
    expect(extractTerminalRun("run git status in the terminal")).toMatchObject({ risk: "safe" });
    expect(extractTerminalRun("run npm install in the terminal")).toMatchObject({
      command: "npm install",
      risk: "exec",
    });
    expect(extractTerminalRun("run the tests")).toMatchObject({
      command: "npm test",
      risk: "safe",
    });
    expect(extractTerminalRun("run typecheck")).toMatchObject({
      command: "npm run typecheck",
      risk: "safe",
    });
    expect(extractTerminalRun("install npm dependencies")).toMatchObject({
      command: "npm ci",
      risk: "exec",
    });
    expect(extractTerminalRun("explain how the terminal works")).toBeNull();
    expect(extractTerminalRun("write me an essay")).toBeNull();
    expect(extractTerminalRun("copy that")).toBeNull();
    expect(looksLikeShellCommand("npm test")).toBe(true);
    expect(looksLikeShellCommand("what is npm")).toBe(false);
    expect(isRoutineTerminalCommand("npm test")).toBe(true);
    expect(isRoutineTerminalCommand("npm install")).toBe(false);
  });

  it("does not send OS commands through the Python/Node REPL profiles", () => {
    expect(resolveTerminalShell("python", "python", "npm test")).toBe("cmd");
    expect(resolveTerminalShell("python", "cmd", "npm test")).toBe("cmd");
    expect(resolveTerminalShell("python", "python", "print(1)")).toBe("python");
    expect(resolveTerminalShell("powershell", "powershell", "npm test")).toBe("powershell");
  });
});

describe("honest extra shells", () => {
  it("lists Termux as unavailable and never pretends it ran", () => {
    const shells = terminal.listShells({});
    const termux = shells.find((s) => s.id === "termux");
    expect(termux).toBeTruthy();
    expect(termux?.available).toBe(false);
    expect(String(termux?.reason)).toMatch(/Android/i);
    expect(shells.some((s) => s.id === "wsl")).toBe(true);
    expect(shells.some((s) => s.id === "git-bash")).toBe(true);
    expect(shells.some((s) => s.id === "cmd")).toBe(true);
    expect(shells.some((s) => s.id === "powershell")).toBe(true);
  });
});
