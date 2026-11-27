/**
 * A forgotten memory stays forgotten through Backup and Restore: it leaves the stored backup, a restore filters
 * the fabric's tombstones, and a missing browser copy falls back to the desktop copy.
 */
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

const titles = () => memory.getSnapshot().items.map((item) => item.title);

describe("forget survives backup and restore", () => {
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

  it("drops a forgotten id from the stored backup, so Restore cannot bring it back", () => {
    const keep = memory.remember({
      tier: "semantic",
      title: "Keep",
      text: "keep this fact about tea",
      source: "user",
    });
    const gone = memory.remember({
      tier: "semantic",
      title: "Gone",
      text: "forget this fact about milk",
      source: "user",
    });
    expect(memory.backup()).toBeGreaterThan(1);
    memory.forget(gone.id);
    expect(memory.restoreBackup()).toBeGreaterThan(0);
    expect(titles()).toContain("Keep");
    expect(titles()).not.toContain("Gone");
    expect(memory.getSnapshot().items.some((item) => item.id === keep.id)).toBe(true);
  });

  it("refuses a tombstoned id that is still inside a stored backup", () => {
    const stale = memory.remember({
      tier: "semantic",
      title: "Stale",
      text: "an old fact about oat milk",
      source: "user",
    });
    const keep = memory.remember({
      tier: "semantic",
      title: "Keep",
      text: "keep this fact",
      source: "user",
    });
    forgetEverywhere(stale.id);
    // A backup written by an older build, from before the forget: it still carries the forgotten record.
    writeState("friday.memory.backup.v1", { at: 1, items: [stale, keep] });
    expect(memory.restoreBackup()).toBe(1);
    expect(titles()).toEqual(["Keep"]);
  });

  it("falls back to the desktop copy when the browser copy is missing", async () => {
    const item = memory.remember({
      tier: "semantic",
      title: "Disk",
      text: "a fact that lives on disk only",
      source: "user",
    });
    const gone = memory.remember({
      tier: "semantic",
      title: "Gone",
      text: "this one was forgotten",
      source: "user",
    });
    const saved = { at: 1, items: [item, gone] };
    stubWindow({ getState: async () => saved, setState: async () => undefined });
    memory.resetForTests();
    forgetEverywhere(gone.id);
    expect(memory.restoreBackup()).toBe(0); // nothing in the browser copy: the disk copy is read next
    await vi.waitFor(() => expect(titles()).toContain("Disk"));
    expect(titles()).not.toContain("Gone");
  });
});
