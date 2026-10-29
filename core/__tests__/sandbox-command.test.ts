import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import {
  extractSandboxRun,
  isRoutineSandboxCommand,
  summarizeSandboxOutput,
} from "../../src/lib/friday/sandbox-command";
import { SANDBOX_TEMPLATES } from "../../src/lib/friday/sandbox-lab";

const lab = createRequire(import.meta.url)("../../electron/sandbox-lab.cjs") as {
  TEMPLATES: Record<string, unknown>;
  RUNTIME: Array<{ id: string; toolId: string }>;
};

describe("sandbox command classification", () => {
  it("maps sandbox checks/tests as Auto Mode safe, and installs as exec", () => {
    expect(extractSandboxRun("run npm test in the sandbox")).toMatchObject({
      op: "run",
      command: "npm test",
      risk: "safe",
      tool: "sandbox.exec",
    });
    expect(extractSandboxRun("run the tests in the sandbox")).toMatchObject({
      command: "npm test",
      risk: "safe",
    });
    expect(extractSandboxRun("sandbox: git status --short")).toMatchObject({
      command: "git status --short",
      risk: "safe",
    });
    expect(extractSandboxRun("run sandbox checks")).toMatchObject({ op: "checks", risk: "safe" });
    expect(extractSandboxRun("run npm install in the sandbox")).toMatchObject({
      command: "npm install",
      risk: "exec",
    });
    expect(extractSandboxRun("run cargo test in the sandbox")).toMatchObject({
      command: "cargo test",
      risk: "safe",
    });
    expect(extractSandboxRun("run go vet in the sandbox")).toMatchObject({
      command: "go vet ./...",
      risk: "safe",
    });
    expect(extractSandboxRun("run docker build . in the sandbox")).toMatchObject({
      risk: "exec",
    });
    expect(isRoutineSandboxCommand("run npm test in the sandbox")).toBe(true);
    expect(isRoutineSandboxCommand("run npm install in the sandbox")).toBe(false);
  });

  it("does not steal terminal-only phrases or English questions", () => {
    expect(extractSandboxRun("run git status in the terminal")).toBeNull();
    expect(extractSandboxRun("run the tests")).toBeNull();
    expect(extractSandboxRun("explain how the sandbox works")).toBeNull();
    expect(extractSandboxRun("create a file in the sandbox")).toBeNull();
  });

  it("creates a named project and refuses apply as a runnable auto action", () => {
    expect(extractSandboxRun("create a python sandbox called demo")).toMatchObject({
      op: "create",
      template: "python",
      name: "demo",
      risk: "write",
    });
    expect(extractSandboxRun("apply the sandbox changes")).toMatchObject({
      op: "apply",
      risk: "exec",
    });
    expect(isRoutineSandboxCommand("create a python sandbox called demo")).toBe(false);
    expect(isRoutineSandboxCommand("apply the sandbox changes")).toBe(false);
  });

  it("only reports real error lines from a buffer", () => {
    expect(summarizeSandboxOutput("ok\nall tests passed\n")).toBe("");
    expect(summarizeSandboxOutput("ok\nError: boom\nexit code 1\n")).toMatch(/Error: boom/);
  });

  it("keeps the renderer template list in lockstep with the lab", () => {
    expect(SANDBOX_TEMPLATES.map((t) => t.id).sort()).toEqual(Object.keys(lab.TEMPLATES).sort());
    expect(lab.RUNTIME.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        "node",
        "npm",
        "git",
        "python",
        "docker",
        "go",
        "ruff",
        "pytest",
        "cargo",
        "tsc",
        "prettier",
        "dotnet",
        "podman",
      ]),
    );
  });
});
