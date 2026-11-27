import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** terminal:exec: what FRIDAY chooses to run goes through the permission gate; what the owner types is his own. */
describe("terminal:exec gate", () => {
  const main = read("../../electron/main.cjs");
  const start = main.indexOf('ipcMain.handle("terminal:exec"');
  const handler = main.slice(start, start + 1400);

  it("an agent-origin command that is not a read is gated and a halted FRIDAY refuses it", () => {
    expect(start).toBeGreaterThan(0);
    expect(handler).toContain('origin === "agent"');
    expect(handler).toMatch(
      /terminal\.classifyCommand\(command, \{\s*untrusted: terminal\.isUntrustedFolder\(root, request\.cwd\),?\s*\}\)/,
    );
    // The folder that is judged is the folder the command runs in: the same root and cwd reach runCommand.
    expect(handler).toMatch(/terminal\.runCommand\(\s*root,/);
    expect(handler).toContain('authorizeToolCall("terminal.exec"');
    expect(handler).toContain("halted === true");
  });

  it("the origin marker is stripped before the run and is set only by FRIDAY's own runner", () => {
    expect(handler).toMatch(/const \{ origin, \.\.\.request \}/);
    expect(handler).not.toMatch(/runCommand\([^)]*origin/);
    const ops = read("../../src/lib/friday/ops-engine.ts");
    expect(ops).toContain('{ ...options, origin: "agent" }');
    expect(ops).toMatch(/executeReal[\s\S]{0,300}this\.spawn\(command, \{\}\)/);
  });

  it("a late Allow after Stop everything does not run the tool", () => {
    const gate = main.slice(main.indexOf("async function authorizeToolCall"));
    const ask = gate.indexOf("persistToolDecision(name, risk, answer.granted");
    expect(gate.slice(ask, ask + 500)).toContain("ownerAutonomyState().halted === true");
  });
});

describe("a folder with its own repository or project is untrusted", () => {
  const terminal = createRequire(import.meta.url)("../../electron/terminal.cjs") as {
    isUntrustedFolder: (root: string, cwd: unknown) => boolean;
  };

  it("judges the run folder and every folder between it and the workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-trust-"));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      mkdirSync(join(root, "src", "deep"), { recursive: true });
      mkdirSync(join(root, "clone", ".git"), { recursive: true });
      mkdirSync(join(root, "clone", "pkg"), { recursive: true });
      mkdirSync(join(root, "py"), { recursive: true });
      writeFileSync(join(root, "py", "pyproject.toml"), "");
      mkdirSync(join(root, "wt"), { recursive: true });
      writeFileSync(join(root, "wt", ".git"), "gitdir: elsewhere");

      // The workspace root is the owner's own project; a plain sub-folder stays trusted.
      expect(terminal.isUntrustedFolder(root, "")).toBe(false);
      expect(terminal.isUntrustedFolder(root, undefined)).toBe(false);
      expect(terminal.isUntrustedFolder(root, "src/deep")).toBe(false);
      expect(terminal.isUntrustedFolder(root, join(root, "src"))).toBe(false);
      // A cloned repository (a .git folder or a .git file), or another project, is not.
      expect(terminal.isUntrustedFolder(root, "clone")).toBe(true);
      expect(terminal.isUntrustedFolder(root, "clone/pkg")).toBe(true);
      expect(terminal.isUntrustedFolder(root, join(root, "clone", "pkg"))).toBe(true);
      expect(terminal.isUntrustedFolder(root, "py")).toBe(true);
      expect(terminal.isUntrustedFolder(root, "wt")).toBe(true);
      // A folder outside the root never runs (runCommand refuses it); it is never called trusted either.
      expect(terminal.isUntrustedFolder(root, "..")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("contact detail screen stays linear", () => {
  it("a 16k run of 'a-' classifies in well under a second", async () => {
    const { createRequire } = await import("node:module");
    const firewall = createRequire(import.meta.url)("../../electron/privacy-firewall.cjs");
    const started = Date.now();
    firewall.classify("a-".repeat(16000));
    expect(Date.now() - started).toBeLessThan(500);
    expect(firewall.classify("write to dev.person@example.com today").level).not.toBe("public");
  });
});
