/**
 * Stop everything reaches the main process at once. The owner's state is saved to disk on a 400 ms delay, and in that
 * window an agent shell command, a tool call or a late Allow still ran. The renderer now tells the main process
 * through one synchronous message the moment the autonomy state is written; main reads that signal before the file,
 * keeps the last known state when the file cannot be read, and refuses a write or exec when it knows nothing at all.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const gate = createRequire(import.meta.url)("../../electron/tool-gate.cjs") as {
  createAutonomyReader: (readStored: () => unknown) => {
    read: () => { dial: string; halted: boolean };
    signalHalted: (value: unknown) => boolean;
  };
};

describe("the autonomy reader in the main process", () => {
  it("keeps today's answers for a stored state", () => {
    const none = gate.createAutonomyReader(() => null);
    expect(none.read()).toEqual({ dial: "balanced", halted: false });
    const full = gate.createAutonomyReader(() => ({ approvalLevel: "full", halted: false }));
    expect(full.read()).toEqual({ dial: "full", halted: false });
    const trusted = gate.createAutonomyReader(() => ({ approvalLevel: "trusted", halted: true }));
    expect(trusted.read()).toEqual({ dial: "balanced", halted: true });
    const other = gate.createAutonomyReader(() => ({ approvalLevel: "ask" }));
    expect(other.read()).toEqual({ dial: "ask", halted: false });
  });

  it("a halt signal wins over a stored file that has not caught up", () => {
    const reader = gate.createAutonomyReader(() => ({ approvalLevel: "full", halted: false }));
    expect(reader.signalHalted(true)).toBe(true);
    expect(reader.read()).toEqual({ dial: "full", halted: true });
  });

  it("a resume signal wins over a stored halt that has not been rewritten yet", () => {
    const reader = gate.createAutonomyReader(() => ({ approvalLevel: "ask", halted: true }));
    expect(reader.read().halted).toBe(true);
    reader.signalHalted(false);
    expect(reader.read().halted).toBe(false);
  });

  it("only a literal true halts: other values are a resume", () => {
    const reader = gate.createAutonomyReader(() => ({ halted: false }));
    expect(reader.signalHalted("true")).toBe(false);
    expect(reader.signalHalted(1)).toBe(false);
    expect(reader.read().halted).toBe(false);
  });

  it("fails closed when the file cannot be read and nothing is known", () => {
    const reader = gate.createAutonomyReader(() => {
      throw new Error("EBUSY");
    });
    expect(reader.read()).toEqual({ dial: "ask", halted: true });
  });

  it("keeps the last known state when a later read fails", () => {
    let fail = false;
    const reader = gate.createAutonomyReader(() => {
      if (fail) throw new Error("EBUSY");
      return { approvalLevel: "full", halted: false };
    });
    expect(reader.read()).toEqual({ dial: "full", halted: false });
    fail = true;
    expect(reader.read()).toEqual({ dial: "full", halted: false });
    reader.signalHalted(true);
    expect(reader.read()).toEqual({ dial: "full", halted: true });
  });

  it("a halt signal alone is enough when the file is unreadable", () => {
    const reader = gate.createAutonomyReader(() => {
      throw new Error("EBUSY");
    });
    reader.signalHalted(false);
    expect(reader.read().halted).toBe(false);
    reader.signalHalted(true);
    expect(reader.read().halted).toBe(true);
  });
});

describe("the synchronous halt message is wired end to end", () => {
  const main = read("../../electron/main.cjs");
  const preload = read("../../electron/preload.cjs");

  it("main sets the flag when the message arrives and reads it before the file", () => {
    expect(main).toMatch(/ipcMain\.on\("autonomy:halt-sync", \(event, halted\) => \{/);
    const at = main.indexOf('ipcMain.on("autonomy:halt-sync"');
    expect(main.slice(at, at + 400)).toContain("autonomyReader.signalHalted(halted)");
    expect(main.slice(at, at + 400)).toContain("event.returnValue");
    const fn = main.slice(main.indexOf("function ownerAutonomyState()"));
    expect(fn.slice(0, 200)).toContain("autonomyReader.read()");
    expect(main).toMatch(
      /toolGate\.createAutonomyReader\(\(\) =>\s*stateStore\.readState\(stateFile\("friday\.autonomy\.v1"\)\),?\s*\)/,
    );
  });

  it("the preload sends it synchronously and only through one named method", () => {
    expect(preload).toContain('ipcRenderer.sendSync("autonomy:halt-sync", halted === true)');
    expect(preload).toMatch(/signalHalted: \(halted\) =>/);
  });

  it("the app-restart and shutdown question checks the halt before and after it", () => {
    const body = main.slice(main.indexOf("async function authorizeToolCall"));
    const branch = body.slice(0, body.indexOf("const risk = await toolRisk(name)"));
    expect(branch).toContain("appLifecycle.alwaysAsk(name)");
    const before = branch.indexOf("ownerAutonomyState().halted === true");
    const ask = branch.indexOf("askOwnerForTool(name");
    const after = branch.indexOf("ownerAutonomyState().halted === true", ask);
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(ask);
    expect(after).toBeGreaterThan(ask);
  });
});

describe("the renderer tells main in the same tick the autonomy state is written", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function install() {
    const signalHalted = vi.fn(() => true);
    const setState = vi.fn(async () => true);
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      friday: { signalHalted, setState },
    });
    return { signalHalted, setState };
  }

  it("signals halted before the delayed disk write, and the resume too", async () => {
    const { signalHalted, setState } = install();
    const { writeState } = await import("../../src/lib/friday/persist");
    writeState("friday.autonomy.v1", { approvalLevel: "full", halted: true });
    expect(signalHalted).toHaveBeenLastCalledWith(true);
    expect(setState).not.toHaveBeenCalled();
    writeState("friday.autonomy.v1", { approvalLevel: "full", halted: false });
    expect(signalHalted).toHaveBeenLastCalledWith(false);
  });

  it("does not signal for any other namespace", async () => {
    const { signalHalted } = install();
    const { writeState } = await import("../../src/lib/friday/persist");
    writeState("friday.brain.v1", { halted: true });
    expect(signalHalted).not.toHaveBeenCalled();
  });

  it("a missing or throwing bridge never breaks a write", async () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      friday: {
        signalHalted: () => {
          throw new Error("no ipc");
        },
        setState: async () => true,
      },
    });
    const { writeState } = await import("../../src/lib/friday/persist");
    expect(() => writeState("friday.autonomy.v1", { halted: true })).not.toThrow();
  });
});
