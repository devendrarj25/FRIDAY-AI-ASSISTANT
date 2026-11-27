import { readFileSync } from "node:fs";
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
    expect(handler).toContain("terminal.classifyCommand(command)");
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
