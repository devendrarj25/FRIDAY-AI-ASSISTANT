import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const terminal = require("../../electron/terminal.cjs");

describe("terminal shell profiles", () => {
  it("exposes real shell profiles with availability probed from PATH", () => {
    const shells = terminal.listShells({});
    expect(shells.length).toBeGreaterThan(3);
    const node = shells.find((s: { id: string }) => s.id === "node");
    expect(node?.available).toBe(true);
    expect(shells.some((s: { default: boolean }) => s.default)).toBe(true);
  });

  it("resolves executables on PATH and rejects unknown ones", () => {
    expect(terminal.whichSync("node")).toBeTruthy();
    expect(terminal.whichSync("definitely-not-a-real-binary-xyz")).toBeNull();
  });

  it("runs a command through a named shell profile", async () => {
    const result = await terminal.runCommand(process.cwd(), {
      command: "console.log('node-shell-ok')",
      shell: "node",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("node-shell-ok");
  });

  it("reports a missing shell instead of pretending it ran", async () => {
    const result = await terminal.runCommand(process.cwd(), {
      command: "echo hi",
      shell: "pwsh",
    });
    if (!result.ok) expect(String(result.error)).toMatch(/not installed|no such|not available/i);
  });

  it("refuses Termux with the Android reason instead of spawning", async () => {
    const result = await terminal.runCommand(process.cwd(), {
      command: "echo hi",
      shell: "termux",
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Android/i);
  });

  it("refuses stdin and cancel for runs that do not exist", () => {
    expect(terminal.writeStdin("nope", "y").ok).toBe(false);
    expect(terminal.cancelRun("nope").ok).toBe(false);
    expect(Array.isArray(terminal.listRuns())).toBe(true);
  });

  it("tracks a running command and can cancel it", async () => {
    const runId = "test-long-run";
    const promise = terminal.runCommand(process.cwd(), {
      command: "setTimeout(() => {}, 5000)",
      shell: "node",
      runId,
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(terminal.listRuns().some((r: { runId: string }) => r.runId === runId)).toBe(true);
    expect(terminal.cancelRun(runId).ok).toBe(true);
    const result = await promise;
    expect(result.ok).toBe(false);
  });

  it("lists extra profiles including honest Termux-unavailable", () => {
    const shells = terminal.listShells({});
    expect(shells.some((s: { id: string }) => s.id === "wsl")).toBe(true);
    expect(shells.some((s: { id: string }) => s.id === "git-bash")).toBe(true);
    const termux = shells.find((s: { id: string }) => s.id === "termux");
    expect(termux?.available).toBe(false);
  });
});
