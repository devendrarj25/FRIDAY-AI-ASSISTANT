/**
 * The restore flow reads the disk copy once, tells "no snapshot" from "nothing left to restore", and the snapshot
 * date also sees the desktop copy so the Settings button stays reachable after the browser keys were cleared.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeState, flushPendingState } from "../../src/lib/friday/persist";
import { forgetEverywhere, resetMemoryFabric } from "../../src/lib/friday/brain/memory-fabric";
import { memory } from "../../src/lib/friday/self/memory-engine";

type Bridge = { getState: (ns: string) => Promise<unknown>; setState: () => Promise<void> };

function stubWindow(bridge?: Bridge): void {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    ...(bridge ? { friday: bridge } : {}),
  });
}

const seed = (title: string) =>
  memory.remember({ tier: "semantic", title, text: `${title} fact`, source: "user" });

describe("restore snapshot flow", () => {
  beforeEach(() => {
    stubWindow();
    flushPendingState();
    memory.resetForTests();
    resetMemoryFabric();
  });
  afterEach(() => {
    flushPendingState();
    vi.unstubAllGlobals();
  });

  it("reads the desktop copy once when the browser copy is missing", async () => {
    const item = seed("Disk");
    const getState = vi.fn(async () => ({ at: 7, items: [item] }));
    stubWindow({ getState, setState: async () => undefined });
    memory.resetForTests();
    const result = await memory.restoreSnapshot();
    expect(result).toEqual({ found: true, restored: 1 });
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it("reports no snapshot when neither copy exists", async () => {
    stubWindow({ getState: async () => null, setState: async () => undefined });
    expect(await memory.restoreSnapshot()).toEqual({ found: false, restored: 0 });
  });

  it("reports a snapshot with nothing to restore when every item was forgotten", async () => {
    const gone = seed("Gone");
    forgetEverywhere(gone.id);
    writeState("friday.memory.backup.v1", { at: 5, items: [gone] });
    expect(await memory.restoreSnapshot()).toEqual({ found: true, restored: 0 });
  });

  it("reports a snapshot with nothing to restore when it is empty", async () => {
    writeState("friday.memory.backup.v1", { at: 5, items: [] });
    expect(await memory.restoreSnapshot()).toEqual({ found: true, restored: 0 });
  });

  it("lastBackupAtAnywhere sees the desktop copy when the browser keys are gone", async () => {
    stubWindow({ getState: async () => ({ at: 42, items: [] }), setState: async () => undefined });
    expect(memory.lastBackupAt()).toBeNull();
    expect(await memory.lastBackupAtAnywhere()).toBe(42);
  });

  it("the panels use the single-read restore and the disk-aware date", () => {
    const dir = resolve(__dirname, "../../src/components/friday");
    for (const [file, engine] of [
      ["MemoryConsole.tsx", "memoryEngine"],
      ["settings/MemorySettings.tsx", "memory"],
    ] as const) {
      const source = readFileSync(resolve(dir, file), "utf8");
      expect(source).toContain(`${engine}.restoreSnapshot()`);
      expect(source).not.toMatch(/restoreBackup\(\)/);
      expect(source).toContain("Nothing to restore");
      expect(source).toContain("No backup found");
    }
    const settings = readFileSync(resolve(dir, "settings/MemorySettings.tsx"), "utf8");
    expect(settings).toContain("lastBackupAtAnywhere()");
  });
});
