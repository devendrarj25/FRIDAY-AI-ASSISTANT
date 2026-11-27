/**
 * The opt-in Trelis Hinglish ear is reachable end to end: the stored choice (off by default, sanitized), the
 * request option the bridge forwards, the status and result facts it keeps, the Doctor row, the Settings control,
 * and the stream ear's denoise report in the Doctor row. Source-pinned where a GPU or microphone would be needed.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_EARS,
  preferences,
  sanitizeHinglishEar,
} from "../../src/lib/friday/preferences";
import { earsStatsNow, noteStreamDenoise } from "../../src/lib/friday/voice-audio";
import { earsRows } from "../../src/lib/friday/voice-diagnostics-rows";
import { hinglishEarRow, voiceLayerChecks } from "../../src/lib/friday/voice-doctor";

const require = createRequire(import.meta.url);
const stt = require("../../electron/stt.cjs");
const read = (file: string) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("hinglishEar preference", () => {
  it("is off by default and unknown words read off", () => {
    expect(preferences.getSnapshot().voice.hinglishEar).toBe("off");
    expect(sanitizeHinglishEar("trelis")).toBe("trelis");
    for (const bad of ["TRELIS", "large", 1, null, undefined, {}]) {
      expect(sanitizeHinglishEar(bad)).toBe("off");
    }
  });

  it("is stored through setVoice and an odd patch is cleaned", () => {
    preferences.setVoice({ hinglishEar: "trelis" });
    expect(preferences.getSnapshot().voice.hinglishEar).toBe("trelis");
    preferences.setVoice({ hinglishEar: "bogus" as never });
    expect(preferences.getSnapshot().voice.hinglishEar).toBe("off");
  });
});

describe("the bridge forwards the Hinglish ear", () => {
  it("sends the one named engine and nothing for anything else", () => {
    expect(stt.decodeExtras({ hinglishEar: "trelis" })).toEqual({ hinglishEar: "trelis" });
    expect(stt.decodeExtras({ hinglishEar: "off" })).toEqual({});
    expect(stt.decodeExtras({ hinglishEar: "other" })).toEqual({});
    expect(stt.decodeExtras({})).toEqual({});
  });

  it("the renderer sends it from the one decode-fields line and reads the status keys", () => {
    const sttSrc = read("src/lib/friday/voice-stt.ts");
    expect(sttSrc).toMatch(/hinglishEar === "trelis" \? \{ hinglishEar \}/);
    expect(sttSrc).toContain("raw.hinglishEarTrelisReady");
    expect(sttSrc).toContain("raw.hinglishEarSkipped");
    const main = read("electron/stt.cjs");
    expect(main).toContain("parsed.hinglishEarTrelisReady");
    expect(main).toContain("value.hinglishEarSkipped");
  });
});

describe("the Doctor row voice:hinglish-ear-trelis", () => {
  it("shows installed, not installed and the skipped reason", () => {
    const ok = hinglishEarRow({ pref: "trelis", ready: true });
    expect(ok.id).toBe("voice:hinglish-ear-trelis");
    expect(ok.status).toBe("Ready");
    expect(ok.detail).toMatch(/installed/);
    expect(ok.detail).toMatch(/Not tried/);

    const missing = hinglishEarRow({ pref: "trelis", ready: false });
    expect(missing.status).toBe("Warning");
    expect(missing.detail).toMatch(/not installed/);
    expect(missing.steps?.join(" ")).toMatch(/Models page/);

    const skipped = hinglishEarRow({ pref: "trelis", ready: true, skipped: "no-gpu" });
    expect(skipped.status).toBe("Warning");
    expect(skipped.detail).toContain("no-gpu");
  });

  it("is not a warning while the choice is off, and reaches the layer checks", () => {
    expect(hinglishEarRow({ pref: "off", ready: false }).status).toBe("Ready");
    expect(hinglishEarRow({ pref: "off", ready: null }).detail).toMatch(/not reported/);
    const rows = voiceLayerChecks(undefined, {
      prefs: DEFAULT_VOICE_EARS,
      stats: null,
      hinglish: { pref: "trelis", ready: false },
    });
    expect(rows.filter((r) => r.id === "voice:hinglish-ear-trelis")).toHaveLength(1);
  });

  it("the Settings control keeps the hint short with the caveat first", () => {
    const src = read("src/components/friday/settings/VoiceEarsSettings.tsx");
    const hint = "Large model for mixed Hindi-English. GPU only, not tried yet.";
    expect(src).toContain(hint);
    expect(hint.length).toBeLessThanOrEqual(70);
    expect(src).toContain('hinglishEar: prefs.voice.hinglishEar === "trelis" ? "off" : "trelis"');
  });
});

describe("the stream ear's denoise report", () => {
  it("is kept like the gate engine and shown with its real numbers", () => {
    noteStreamDenoise({ engine: "gtcrn", active: true, rtf: 0.05, latencyMs: 16 });
    const stats = earsStatsNow();
    expect(stats?.denoise).toMatchObject({
      engine: "gtcrn",
      active: true,
      rtf: 0.05,
      latencyMs: 16,
    });
    const row = earsRows({ ...DEFAULT_VOICE_EARS, denoise: "gtcrn" }, stats).find(
      (r) => r.id === "ears-denoise",
    );
    expect(row?.state).toBe("ok");
    expect(row?.value).toMatch(/real-time factor 0\.05/);
    expect(row?.value).toMatch(/16 ms delay/);
    noteStreamDenoise(null);
  });

  it("an inactive report is absent with its reason, and no report reads as not measured", () => {
    noteStreamDenoise({ engine: "gtcrn", active: false, reason: "weights-missing" });
    const row = earsRows({ ...DEFAULT_VOICE_EARS, denoise: "gtcrn" }, earsStatsNow()).find(
      (r) => r.id === "ears-denoise",
    );
    expect(row?.state).toBe("absent");
    expect(row?.value).toContain("weights-missing");
    noteStreamDenoise({ nonsense: 1 });
    expect(earsStatsNow()?.denoise ?? null).toBeNull();
    expect(read("src/lib/friday/voice-stt.ts")).toContain("noteStreamDenoise(");
  });

  it("the Settings label names the real 85 Hz corner", () => {
    expect(read("src/components/friday/settings/VoiceEarsSettings.tsx")).toContain("below 85 Hz");
    expect(read("src/lib/friday/voice-engine/front-end-dsp.ts")).toContain("HPF_HZ = 85");
  });
});
