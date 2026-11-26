/**
 * The stored `voice.understanding` shape (version 1) and `voice.approvalTtlSec`: defaults, key-by-key fill of an
 * older file, coercion of wrong types and the 10 to 60 second clamp. Nothing here opens a microphone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  DEFAULT_VOICE_UNDERSTANDING,
  sanitizeApprovalTtlSec,
  sanitizeVoiceUnderstanding,
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

describe("defaults", () => {
  it("ships the safe version 1 shape and a 30 second approval window", () => {
    expect(DEFAULT_VOICE_UNDERSTANDING).toEqual({
      v: 1,
      selfRepair: true,
      commandLane: true,
      lexiconFix: "hints",
    });
    expect(DEFAULT_PREFERENCES.voice.understanding).toEqual(DEFAULT_VOICE_UNDERSTANDING);
    expect(DEFAULT_PREFERENCES.voice.approvalTtlSec).toBe(30);
  });
});

describe("sanitizeVoiceUnderstanding", () => {
  it("reads the defaults for a missing or non-object value", () => {
    for (const bad of [undefined, null, "x", 7, []]) {
      expect(sanitizeVoiceUnderstanding(bad)).toEqual(DEFAULT_VOICE_UNDERSTANDING);
    }
  });

  it("fills key by key and keeps a real false", () => {
    expect(sanitizeVoiceUnderstanding({ selfRepair: false })).toEqual({
      ...DEFAULT_VOICE_UNDERSTANDING,
      selfRepair: false,
    });
  });

  it("coerces wrong types and unknown words to the defaults", () => {
    const u = sanitizeVoiceUnderstanding({ selfRepair: "no", commandLane: 0, lexiconFix: "bogus" });
    expect(u).toEqual(DEFAULT_VOICE_UNDERSTANDING);
  });

  it("accepts off, hints and apply for lexiconFix", () => {
    for (const w of ["off", "hints", "apply"]) {
      expect(sanitizeVoiceUnderstanding({ lexiconFix: w }).lexiconFix).toBe(w);
    }
  });
});

describe("sanitizeApprovalTtlSec", () => {
  it("clamps to 10..60 and reads a non-number as 30", () => {
    expect(sanitizeApprovalTtlSec(1)).toBe(10);
    expect(sanitizeApprovalTtlSec(500)).toBe(60);
    expect(sanitizeApprovalTtlSec(45)).toBe(45);
    expect(sanitizeApprovalTtlSec("30")).toBe(30);
    expect(sanitizeApprovalTtlSec(null)).toBe(30);
    expect(sanitizeApprovalTtlSec(Number.NaN)).toBe(30);
  });
});

describe("stored old and odd shapes", () => {
  it("an old file reads the defaults", async () => {
    const p = await load({ voice: { rate: 1 } });
    expect(p.voice.understanding).toEqual(DEFAULT_VOICE_UNDERSTANDING);
    expect(p.voice.approvalTtlSec).toBe(30);
  });

  it("odd stored values are made safe", async () => {
    const p = await load({
      voice: { understanding: { lexiconFix: "bogus", commandLane: false }, approvalTtlSec: 9999 },
    });
    expect(p.voice.understanding).toEqual({ ...DEFAULT_VOICE_UNDERSTANDING, commandLane: false });
    expect(p.voice.approvalTtlSec).toBe(60);
  });

  it("a stored null approvalTtlSec reads 30", async () => {
    const p = await load({ voice: { approvalTtlSec: null } });
    expect(p.voice.approvalTtlSec).toBe(30);
  });
});
