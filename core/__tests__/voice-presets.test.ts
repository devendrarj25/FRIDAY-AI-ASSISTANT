import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BEST_PRESET,
  DEFAULT_ENGLISH_VOICE,
  DEFAULT_HINDI_VOICE,
  INDIAN_FEMALE_VOICES,
  PREVIEW_LINES,
  VOICE_PRESETS,
  bestVoiceFields,
  detectPreset,
  pitchOffsetHz,
  presetFields,
  upgradeVoiceDefaults,
} from "../../src/lib/friday/voice-presets";
import { neuralVoiceFor } from "../../src/lib/friday/voice-library";
import { preferences, DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import {
  assessTone,
  resetToneBaseline,
  seedToneBaseline,
  TONE_WARMUP,
} from "../../src/lib/friday/voice-tone";

/* eslint-disable @typescript-eslint/no-require-imports */
const neural = require("../../electron/neural-voice.cjs") as {
  PREFERRED: { id: string; lang: string }[];
  pitchOffsetHz: (pitch: number) => number;
};

const ROOT = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("FRIDAY's shipped voice", () => {
  it("is a female Indian voice for Hindi and one for English, both real online neural voices", () => {
    expect(DEFAULT_HINDI_VOICE).toBe("hi-IN-SwaraNeural");
    expect(DEFAULT_ENGLISH_VOICE).toBe("en-IN-NeerjaNeural");
    expect(DEFAULT_PREFERENCES.voice.hindiVoice).toBe(DEFAULT_HINDI_VOICE);
    expect(DEFAULT_PREFERENCES.voice.englishVoice).toBe(DEFAULT_ENGLISH_VOICE);
    for (const row of INDIAN_FEMALE_VOICES) {
      expect(row.id).toMatch(/^(hi|en)-IN-\w+Neural$/);
      expect(row.id.startsWith(row.lang.slice(0, 2))).toBe(true);
      // the voices the service lists as female for these locales; no male voice is offered as FRIDAY's own
      expect(row.id).not.toMatch(/Madhur|Prabhat/);
    }
    expect(INDIAN_FEMALE_VOICES.some((row) => row.lang === "hi-IN")).toBe(true);
    expect(
      INDIAN_FEMALE_VOICES.filter((row) => row.lang === "en-IN").length,
    ).toBeGreaterThanOrEqual(2);
    // every voice she offers is one the desktop can actually speak with
    const known = new Set(neural.PREFERRED.map((row) => row.id));
    for (const row of INDIAN_FEMALE_VOICES) expect(known.has(row.id), row.id).toBe(true);
  });

  it("starts on the natural delivery: the voice's own pitch, a touch slower than its own pace", () => {
    const natural = VOICE_PRESETS.find((p) => p.id === BEST_PRESET)!;
    expect(natural.pitch).toBe(1);
    expect(natural.rate).toBeGreaterThanOrEqual(0.9);
    expect(natural.rate).toBeLessThanOrEqual(1);
    expect(DEFAULT_PREFERENCES.voice).toMatchObject({
      rate: natural.rate,
      pitch: natural.pitch,
      volume: natural.volume,
    });
    // small changes sound better than large ones: no preset leaves a narrow band around the voice's own delivery
    for (const preset of VOICE_PRESETS) {
      expect(preset.rate).toBeGreaterThanOrEqual(0.9);
      expect(preset.rate).toBeLessThanOrEqual(1.1);
      expect(Math.abs(preset.pitch - 1)).toBeLessThanOrEqual(0.06);
      expect(preset.volume).toBeGreaterThanOrEqual(0.9);
    }
    expect(new Set(VOICE_PRESETS.map((p) => p.id)).size).toBe(VOICE_PRESETS.length);
  });

  it("names the preset the sliders equal, and 'custom' once they moved", () => {
    for (const preset of VOICE_PRESETS) {
      expect(detectPreset({ rate: preset.rate, pitch: preset.pitch, volume: preset.volume })).toBe(
        preset.id,
      );
      expect(presetFields(preset.id)).toMatchObject({ rate: preset.rate, voicePreset: preset.id });
    }
    expect(detectPreset({ rate: 1.3, pitch: 1, volume: 1 })).toBe("custom");
    expect(bestVoiceFields()).toMatchObject({
      hindiVoice: DEFAULT_HINDI_VOICE,
      englishVoice: DEFAULT_ENGLISH_VOICE,
      voicePreset: "natural",
      speakReplies: true,
      hinglish: true,
    });
  });

  it("has a preview line for Hindi, English and Hinglish", () => {
    expect(PREVIEW_LINES.hi).toMatch(/[ऀ-ॿ]/);
    expect(PREVIEW_LINES.en).not.toMatch(/[ऀ-ॿ]/);
    expect(PREVIEW_LINES.hinglish).toMatch(/[A-Za-z]/);
    expect(PREVIEW_LINES.hinglish).not.toMatch(/[ऀ-ॿ]/);
  });
});

describe("an install that never chose its voice numbers", () => {
  const old = { rate: 0.96, pitch: 1.12, volume: 1 };

  it("moves exactly the first shipped numbers to the natural preset, once", () => {
    const moved = upgradeVoiceDefaults({ ...old });
    expect(moved.changed).toBe(true);
    expect(moved.voice).toMatchObject({
      rate: 0.97,
      pitch: 1,
      volume: 1,
      voicePreset: "natural",
      voicePresetVersion: 1,
    });
    expect(upgradeVoiceDefaults(moved.voice).changed).toBe(false);
  });

  it("leaves anything the owner changed exactly as it is", () => {
    for (const mine of [
      { rate: 0.96, pitch: 1.12, volume: 0.8 },
      { rate: 1.1, pitch: 1.12, volume: 1 },
      { rate: 0.96, pitch: 1.2, volume: 1 },
    ]) {
      const result = upgradeVoiceDefaults({ ...mine });
      expect(result.voice).toMatchObject(mine);
      expect((result.voice as { voicePresetVersion?: number }).voicePresetVersion).toBe(1);
    }
    expect(upgradeVoiceDefaults({ ...old, voicePresetVersion: 1 }).changed).toBe(false);
  });
});

describe("the pitch setting is audible and safe", () => {
  it("maps the multiplier to a real Hz offset, zero at the voice's own pitch, clamped", () => {
    expect(pitchOffsetHz(1)).toBe(0);
    expect(pitchOffsetHz(1.04)).toBe(6);
    expect(pitchOffsetHz(0.96)).toBe(-6);
    expect(pitchOffsetHz(1.3)).toBe(40);
    expect(pitchOffsetHz(5)).toBe(40);
    expect(pitchOffsetHz(-5)).toBe(-40);
    expect(pitchOffsetHz(Number.NaN)).toBe(0);
    // the old mapping moved the whole slider by about 6 Hz; the first preset step is now that much by itself
    expect(Math.abs(pitchOffsetHz(1.3))).toBeGreaterThan(6);
  });

  it("is the same on the desktop side that sends it to the service", () => {
    for (const pitch of [0.7, 0.96, 1, 1.04, 1.12, 1.3, 2, Number.NaN]) {
      expect(neural.pitchOffsetHz(pitch)).toBe(pitchOffsetHz(pitch));
    }
    expect(read("electron/neural-voice.cjs")).toContain("offsetHz >= 0");
    expect(read("electron/neural-voice.cjs")).not.toContain("(Number(pitch) - 1) * 12");
  });
});

describe("which voice speaks a language", () => {
  it("uses the owner's own Hindi and English pick, then the shipped one", () => {
    preferences.setVoice({
      hindiVoice: DEFAULT_HINDI_VOICE,
      englishVoice: "en-IN-NeerjaExpressiveNeural",
    });
    expect(neuralVoiceFor("en-IN")).toBe("en-IN-NeerjaExpressiveNeural");
    expect(neuralVoiceFor("hi-IN")).toBe("hi-IN-SwaraNeural");
    // an explicit voice for that language still wins; one for the other language is ignored
    expect(neuralVoiceFor("en-IN", "en-IN-NeerjaNeural")).toBe("en-IN-NeerjaNeural");
    expect(neuralVoiceFor("hi-IN", "en-IN-NeerjaNeural")).toBe("hi-IN-SwaraNeural");
    // a bad value falls back to the shipped voice
    preferences.setVoice({ englishVoice: "hi-IN-SwaraNeural" });
    expect(neuralVoiceFor("en-IN")).toBe("en-IN-NeerjaNeural");
    preferences.setVoice({ hindiVoice: DEFAULT_HINDI_VOICE, englishVoice: DEFAULT_ENGLISH_VOICE });
  });
});

describe("the tone reading starts from the owner's own recordings", () => {
  it("reads the first sentence against the saved baseline instead of calling it steady", () => {
    resetToneBaseline();
    const loud = {
      ok: true,
      pitchHz: 260,
      energyDbfs: -12,
      pitchSpreadSemitones: 6,
      voicedShare: 0.8,
    };
    // no baseline yet: the first reading is only "still learning"
    expect(assessTone(loud)?.label).toBe("steady");
    resetToneBaseline();
    expect(seedToneBaseline({ pitchHz: 190, energyDbfs: -30, pitchSpreadSemitones: 3 })).toBe(true);
    const first = assessTone(loud);
    expect(first?.label).toBe("tense");
    expect(first?.line).not.toContain("still learning");
    expect(first?.samples).toBeGreaterThanOrEqual(TONE_WARMUP);
  });

  it("never replaces a baseline already learned from live speech, and ignores a bad seed", () => {
    resetToneBaseline();
    for (let i = 0; i < TONE_WARMUP + 1; i += 1) {
      assessTone({
        ok: true,
        pitchHz: 200,
        energyDbfs: -25,
        pitchSpreadSemitones: 3,
        voicedShare: 0.8,
      });
    }
    expect(seedToneBaseline({ pitchHz: 100, energyDbfs: -50, pitchSpreadSemitones: 1 })).toBe(
      false,
    );
    resetToneBaseline();
    expect(seedToneBaseline({ pitchHz: 0, energyDbfs: -30, pitchSpreadSemitones: 3 })).toBe(false);
    expect(
      seedToneBaseline({ pitchHz: 190, energyDbfs: Number.NaN, pitchSpreadSemitones: 3 }),
    ).toBe(false);
    resetToneBaseline();
  });
});

describe("the Settings screen", () => {
  it("shows FRIDAY's voice first and keeps one set of sliders, not two", () => {
    const page = read("src/components/friday/settings/VoiceSettings.tsx");
    expect(page).toContain("<FridayVoice />");
    expect(page.indexOf("<FridayVoice />")).toBeLessThan(page.indexOf('title="Voice & Wake Word"'));
    const panel = read("src/components/friday/settings/FridayVoice.tsx");
    for (const label of [
      "Hindi voice",
      "English voice",
      "Speaking rate",
      "Pitch",
      "Volume",
      "Hear Hindi",
      "Hear English",
      "Hear Hinglish",
      "Reset to the best voice",
    ]) {
      expect(panel, label).toContain(label);
    }
    // the sliders moved into the new panel; the old section no longer carries a second copy
    expect(page).not.toContain('label="Speaking rate"');
    expect(page).toContain("resetToBestVoice()");
    expect(page).not.toContain("pitch: 1.12");
  });

  it("writes a slider into the active library voice too, or it would change nothing", () => {
    const library = read("src/lib/friday/voice-library.ts");
    expect(library).toContain("export function setVoiceDelivery");
    expect(library).toMatch(/if \(voice\.activeId\) updateVoiceModel\(voice\.activeId, patch\)/);
    expect(library).toContain("export function applyVoicePreset");
    expect(library).toContain("export function resetToBestVoice");
  });

  it("moves an old install once at load", () => {
    expect(read("src/lib/friday/preferences.ts")).toContain(
      "upgradeVoiceDefaults({ ...stored.voice })",
    );
  });
});
