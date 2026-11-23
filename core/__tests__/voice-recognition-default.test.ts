/**
 * A fresh install listens in auto. An install that already stored a recognition language keeps it: a stored hi-IN
 * cannot be told from an explicit pick, so nothing here rewrites it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

async function fresh(saved: unknown) {
  vi.resetModules();
  store.clear();
  if (saved !== undefined) store.set("friday.preferences", JSON.stringify(saved));
  return (await import("../../src/lib/friday/preferences")).preferences;
}

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the recognition language default and its migration", () => {
  it("is auto on a fresh install", async () => {
    const prefs = await fresh(undefined);
    await prefs.hydrate();
    expect(prefs.getSnapshot().voice.recognitionLang).toBe("auto");
  });

  it("is auto when an older file never stored a voice section", async () => {
    const prefs = await fresh({ theme: "dark", toggles: {}, fields: {} });
    await prefs.hydrate();
    expect(prefs.getSnapshot().voice.recognitionLang).toBe("auto");
  });

  it.each(["hi-IN", "en-IN", "en-US", "hi-Latn"])("keeps a stored %s", async (lang) => {
    const prefs = await fresh({ voice: { recognitionLang: lang } });
    await prefs.hydrate();
    expect(prefs.getSnapshot().voice.recognitionLang).toBe(lang);
  });

  it("keeps an owner's later choice of auto or Hindi", async () => {
    const prefs = await fresh(undefined);
    await prefs.hydrate();
    prefs.setVoice({ recognitionLang: "hi-IN" });
    expect(prefs.getSnapshot().voice.recognitionLang).toBe("hi-IN");
    prefs.setVoice({ recognitionLang: "auto" });
    expect(prefs.getSnapshot().voice.recognitionLang).toBe("auto");
  });
});
