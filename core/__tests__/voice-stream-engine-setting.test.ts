/**
 * voice.streamEngine ("off" | "auto" | "nemotron" | "stream-ear-nemotron", default "auto": the PC decides, see
 * voice-hardware-adaptive.test.ts) and voice.itn (default on):
 * stored and normalised like the other voice settings, shown in Voice settings, and migrated from an old stored shape.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  STREAM_ENGINE_PICKS,
  sanitizeStreamEngine,
  type FridayPreferences,
} from "../../src/lib/friday/preferences";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const stt = createRequire(import.meta.url)("../../electron/stt.cjs");

describe("voice.streamEngine and voice.itn defaults", () => {
  it("the streaming ear is auto (this PC decides) and spoken-number writing is on, out of the box", () => {
    expect(DEFAULT_PREFERENCES.voice.streamEngine).toBe("auto");
    expect(DEFAULT_PREFERENCES.voice.streamEngine).not.toBe("nemotron");
    expect(DEFAULT_PREFERENCES.voice.itn).toBe(true);
  });

  it("the picks are exactly the engines the main process accepts", () => {
    expect([...STREAM_ENGINE_PICKS]).toEqual(stt.STREAM_ENGINES);
  });

  it("sanitizeStreamEngine keeps a known pick and reads anything else as off", () => {
    for (const pick of STREAM_ENGINE_PICKS) expect(sanitizeStreamEngine(pick)).toBe(pick);
    for (const junk of ["", "Auto", "whisper", null, undefined, 3, true, {}]) {
      expect(sanitizeStreamEngine(junk)).toBe("off");
    }
  });
});

describe("storing and migrating the two settings", () => {
  async function hydrateFrom(stored: unknown) {
    vi.resetModules();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify(stored),
        setItem: () => undefined,
      },
    });
    const { preferences } = await import("../../src/lib/friday/preferences");
    return (await preferences.hydrate()) as FridayPreferences;
  }
  afterEach(() => vi.unstubAllGlobals());

  it("an old stored shape without them migrates to auto and on, and keeps what it had", async () => {
    const merged = await hydrateFrom({ voice: { liveWords: true } });
    expect(merged.voice.streamEngine).toBe("auto");
    expect(merged.voice.itn).toBe(true);
    expect(merged.voice.liveWords).toBe(true);
  });

  it("a stored choice survives, a bad one reads off, and only an explicit false turns itn off", async () => {
    const kept = await hydrateFrom({ voice: { streamEngine: "nemotron", itn: false } });
    expect(kept.voice.streamEngine).toBe("nemotron");
    expect(kept.voice.itn).toBe(false);
    // A stored off is the owner's (the old default cannot be told apart from a choice): it stays off.
    expect((await hydrateFrom({ voice: { streamEngine: "off" } })).voice.streamEngine).toBe("off");
    const bad = await hydrateFrom({ voice: { streamEngine: "bogus", itn: "no" } });
    expect(bad.voice.streamEngine).toBe("off");
    expect(bad.voice.itn).toBe(true);
  });

  it("setVoice normalises: a junk engine never reaches the store", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => undefined } });
    const { preferences } = await import("../../src/lib/friday/preferences");
    preferences.setVoice({ streamEngine: "auto" });
    expect(preferences.getSnapshot().voice.streamEngine).toBe("auto");
    preferences.setVoice({ streamEngine: "junk" as never });
    expect(preferences.getSnapshot().voice.streamEngine).toBe("off");
  });
});

describe("Voice settings", () => {
  const ui = read("src/components/friday/settings/VoiceSettings.tsx");

  it("shows an engine picker that writes through the sanitiser, with every pick listed", () => {
    expect(ui).toContain("sanitizeStreamEngine(prefs.voice.streamEngine)");
    expect(ui).toContain(
      "preferences.setVoice({ streamEngine: sanitizeStreamEngine(e.target.value) })",
    );
    for (const pick of STREAM_ENGINE_PICKS) expect(ui).toContain(`<option value="${pick}"`);
  });

  it("shows the spoken-number toggle, on unless explicitly off", () => {
    expect(ui).toContain("on={prefs.voice.itn !== false}");
    expect(ui).toContain("preferences.setVoice({ itn: prefs.voice.itn === false })");
  });
});

describe("the renderer bridge", () => {
  it("names the three calls the preload allowlists, and nothing opens a microphone", () => {
    const desktop = read("src/lib/friday/desktop.ts");
    for (const name of ["openSttStream", "feedSttStream", "closeSttStream"]) {
      expect(desktop).toContain(`${name}?:`);
      expect(read("electron/preload.cjs")).toContain(`${name}: (payload) =>`);
    }
  });
});
