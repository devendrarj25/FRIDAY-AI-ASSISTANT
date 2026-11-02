import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPendingState } from "../../src/lib/friday/persist";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("a text or font change is saved when the window closes", () => {
  it("writes a change that is still inside the debounce", async () => {
    const { preferences } = await import("../../src/lib/friday/preferences");
    preferences.setField("textScale", "125");
    preferences.setField("bodyFont", "Lexend");
    expect(store.has("friday.preferences")).toBe(false);
    flushPendingState();
    await Promise.resolve();
    const saved = JSON.parse(store.get("friday.preferences") ?? "{}");
    expect(saved.fields.textScale).toBe("125");
    expect(saved.fields.bodyFont).toBe("Lexend");
  });

  it("does nothing when no change is waiting", async () => {
    const { preferences } = await import("../../src/lib/friday/preferences");
    preferences.flushPending();
    flushPendingState();
    expect(store.size).toBe(0);
  });
});
