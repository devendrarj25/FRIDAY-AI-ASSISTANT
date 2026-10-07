import { describe, expect, it } from "vitest";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const terminal = require("../../electron/terminal.cjs");

const ROOT = path.resolve("/friday/workspace");

describe("workspace terminal", () => {
  it("classifies mutating commands as needing approval", () => {
    expect(terminal.classifyCommand("npm install")).toBe("exec");
    expect(terminal.classifyCommand("rm -rf build")).toBe("exec");
    expect(terminal.classifyCommand("git push")).toBe("exec");
    expect(terminal.classifyCommand("node --version")).toBe("write");
    expect(terminal.classifyCommand("git status")).toBe("write");
    expect(terminal.classifyCommand("npm test")).toBe("write");
    expect(terminal.classifyCommand("npm test && npm run typecheck")).toBe("write");
    expect(terminal.classifyCommand("npm test && rm -rf build")).toBe("exec");
    expect(terminal.classifyCommand("winget list")).toBe("write");
    expect(terminal.classifyCommand("winget install Git.Git")).toBe("exec");
  });

  it("keeps the working directory inside the workspace", () => {
    const up = terminal.resolveCd(ROOT, ROOT, "../../etc", () => true);
    expect(up.ok).toBe(false);
    expect(up.cwd).toBe(ROOT);
  });

  it("resolves a real child directory", () => {
    const into = terminal.resolveCd(ROOT, ROOT, "logs", () => true);
    expect(into.ok).toBe(true);
    expect(into.cwd).toBe(path.join(ROOT, "logs"));
  });

  it("reports a missing directory instead of moving", () => {
    const missing = terminal.resolveCd(ROOT, ROOT, "nope", () => false);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("no such directory");
  });

  it("refuses to run without a workspace", async () => {
    const result = await terminal.runCommand(null, { command: "echo hi" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("workspace");
  });

  it("executes a real command and captures its output", async () => {
    const result = await terminal.runCommand(process.cwd(), {
      command: "node -e \"console.log('friday-ok')\"",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("friday-ok");
  });
});
