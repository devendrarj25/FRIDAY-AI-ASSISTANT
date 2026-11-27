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

  it("writes the streaming ear and spoken-number settings when the window closes", async () => {
    const { preferences } = await import("../../src/lib/friday/preferences");
    preferences.setVoice({ streamEngine: "auto", itn: false });
    flushPendingState();
    await Promise.resolve();
    const saved = JSON.parse(store.get("friday.preferences") ?? "{}");
    expect(saved.voice.streamEngine).toBe("auto");
    expect(saved.voice.itn).toBe(false);
  });

  it("writes the listening front end settings, clamped, when the window closes", async () => {
    const { preferences } = await import("../../src/lib/friday/preferences");
    const now = preferences.getSnapshot().voice.ears;
    preferences.setVoice({ ears: { ...now, denoise: "gtcrn", vadStart: 0.95, preRollMs: 50 } });
    flushPendingState();
    await Promise.resolve();
    const saved = JSON.parse(store.get("friday.preferences") ?? "{}");
    expect(saved.voice.ears.v).toBe(1);
    expect(saved.voice.ears.denoise).toBe("gtcrn");
    expect(saved.voice.ears.vadStart).toBe(0.9);
    expect(saved.voice.ears.vadEnd).toBe(0.35);
    expect(saved.voice.ears.preRollMs).toBe(200);
    expect(saved.voice.noiseSuppression).toBe(true);
  });

  it("does nothing when no change is waiting", async () => {
    const { preferences } = await import("../../src/lib/friday/preferences");
    preferences.flushPending();
    flushPendingState();
    expect(store.size).toBe(0);
  });
});
