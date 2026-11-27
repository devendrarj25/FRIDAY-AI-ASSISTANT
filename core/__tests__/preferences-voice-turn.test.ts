/**
 * The stored `voice.turn` shape (version 1): its defaults, the key-by-key fill of an older file, the coercion of
 * wrong types, and the text voice keys that a stored null must not break. Nothing here opens a microphone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  DEFAULT_VOICE_TURN,
  sanitizeVoiceTurn,
} from "../../src/lib/friday/preferences";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.resetModules();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function load(stored: unknown) {
  store.set("friday.preferences", JSON.stringify(stored));
  const mod = await import("../../src/lib/friday/preferences");
  return mod.preferences.hydrate();
}

describe("voice.turn defaults", () => {
  it("ships the safe version 1 shape", () => {
    expect(DEFAULT_VOICE_TURN).toEqual({
      v: 1,
      calibrate: false,
      eotPrior: true,
      classifier: "shadow",
      maxWaitMs: 2400,
    });
    expect(DEFAULT_PREFERENCES.voice.turn).toEqual(DEFAULT_VOICE_TURN);
  });

  it("does not change the existing voice defaults", () => {
    expect(DEFAULT_PREFERENCES.voice.pcmPlayback).toBe(true);
    expect(DEFAULT_PREFERENCES.voice.fastFirstClause).toBe(true);
  });
});

describe("sanitizeVoiceTurn", () => {
  it("fills a missing or non-object value from the defaults", () => {
    for (const bad of [undefined, null, "x", 3, []]) {
      expect(sanitizeVoiceTurn(bad)).toEqual(DEFAULT_VOICE_TURN);
    }
  });

  it("fills a partial object key by key", () => {
    expect(sanitizeVoiceTurn({ calibrate: true })).toEqual({
      ...DEFAULT_VOICE_TURN,
      calibrate: true,
    });
  });

  it("reads an unknown classifier word as shadow and accepts off, shadow and live", () => {
    expect(sanitizeVoiceTurn({ classifier: "bogus" }).classifier).toBe("shadow");
    for (const c of ["off", "shadow", "live"]) {
      expect(sanitizeVoiceTurn({ classifier: c }).classifier).toBe(c);
    }
  });

  it("clamps maxWaitMs to 1200..4000 and reads a non-number as 2400", () => {
    expect(sanitizeVoiceTurn({ maxWaitMs: 10 }).maxWaitMs).toBe(1200);
    expect(sanitizeVoiceTurn({ maxWaitMs: 99999 }).maxWaitMs).toBe(4000);
    expect(sanitizeVoiceTurn({ maxWaitMs: "soon" }).maxWaitMs).toBe(2400);
    expect(sanitizeVoiceTurn({ maxWaitMs: Number.NaN }).maxWaitMs).toBe(2400);
  });

  it("coerces wrong boolean types to the defaults", () => {
    const t = sanitizeVoiceTurn({ calibrate: "yes", eotPrior: "no" });
    expect(t.calibrate).toBe(false);
    expect(t.eotPrior).toBe(true);
  });
});

describe("stored old and odd shapes", () => {
  it("an old file without voice.turn reads the defaults", async () => {
    const p = await load({ voice: { rate: 1 } });
    expect(p.voice.turn).toEqual(DEFAULT_VOICE_TURN);
  });

  it("a stored bogus classifier and wild wait are made safe", async () => {
    const p = await load({
      voice: { turn: { classifier: "bogus", maxWaitMs: 5, calibrate: true } },
    });
    expect(p.voice.turn).toEqual({ ...DEFAULT_VOICE_TURN, calibrate: true, maxWaitMs: 1200 });
  });

  it("a stored wakeWord of null reads the default word", async () => {
    const p = await load({ voice: { wakeWord: null } });
    expect(p.voice.wakeWord).toBe(DEFAULT_PREFERENCES.voice.wakeWord);
  });

  it("other text voice keys of the wrong type read their defaults; real strings stay", async () => {
    const p = await load({
      voice: { recognitionLang: 5, speechLang: null, voiceName: {}, addressName: "Dev" },
    });
    expect(p.voice.recognitionLang).toBe(DEFAULT_PREFERENCES.voice.recognitionLang);
    expect(p.voice.speechLang).toBe(DEFAULT_PREFERENCES.voice.speechLang);
    expect(p.voice.voiceName).toBe(DEFAULT_PREFERENCES.voice.voiceName);
    expect(p.voice.addressName).toBe("Dev");
  });
});
