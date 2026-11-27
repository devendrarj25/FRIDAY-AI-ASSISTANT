/**
 * The words the owner reads in the voice settings, Doctor, catalog and installer messages use FRIDAY names, and no
 * other developer's credit or licence text sits in these files (credits live in docs/FRIDAY_VOICE_ENGINE.md only).
 * Label-only: ids, stored words, repo ids and pin keys stay. Companion to voice-friday-names.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const CREDIT =
  /CC-BY|OpenRAIL|Apache-2\.0|GPL-3|Katiyar|Trelis Research|Collabora|credit in the Models row/;

/** Where an upstream name stays on purpose (file: reason). */
export const ALLOWLIST = [
  "electron/voice-weights.cjs: repo constants, pin keys, catalog ids and the licence field of a pin (data)",
  "src/lib/friday/catalog.ts: install-catalog ids and urls of upstream packages",
  "stored words (trelis, nemotron, supertonic, silero, gtcrn, dpdfnet2) and engine ids stay in code",
];

const FILES = [
  "src/components/friday/settings/VoiceEarsSettings.tsx",
  "src/lib/friday/voice-doctor.ts",
  "src/lib/friday/voice-pack-view.ts",
  "src/lib/friday/desktop.ts",
  "src/lib/friday/preferences.ts",
  "electron/stt.cjs",
  "electron/neural-voice.cjs",
  "electron/voice-weights.cjs",
];

describe("FRIDAY names in the remaining voice text", () => {
  it("carries no credit or licence notice in these files", () => {
    for (const f of FILES) {
      // A pin's `license:` field is data the licence gate reads; it is not shown as text.
      const text = read(f).replace(/^\s*license: .*$/gm, "");
      expect(text, f).not.toMatch(CREDIT);
    }
  });

  it("names the denoise and listen-gate choices as FRIDAY", () => {
    const ui = read("src/components/friday/settings/VoiceEarsSettings.tsx");
    expect(ui).toContain('silero: "FRIDAY Listen Gate"');
    expect(ui).toContain('dpdfnet2: "FRIDAY Denoise"');
    expect(ui).toContain('gtcrn: "FRIDAY Denoise Lite (very small)"');
    expect(ui).not.toMatch(/"(GTCRN|DPDFNet 2|RNNoise|The small speech model)/);
  });

  it("shows FRIDAY Ear Hinglish Large in the Doctor row text, not the pin id", () => {
    const doc = read("src/lib/friday/voice-doctor.ts");
    expect(doc).toContain("pin the Hinglish mixed-script ear (FRIDAY Ear Hinglish Large)");
    expect(doc).not.toContain("(hinglish-ear-trelis), then");
  });

  it("speaks FRIDAY Ear in the speech engine messages, never whisper.cpp or faster-whisper", () => {
    const stt = read("electron/stt.cjs");
    expect(stt).toContain("The FRIDAY Ear speech engine is not installed yet.");
    expect(stt).toContain("needs a wav capture");
    expect(stt).not.toMatch(
      /"[^"\n]*(whisper\.cpp|faster-whisper) (is|files|needs|returned)[^"\n]*"/,
    );
    expect(stt).not.toContain("faster-whisper is not installed yet");
    expect(stt).not.toMatch(/Supertonic|IndicConformer|Trelis (Hinglish|Research)/);
  });

  it("names the installed voice FRIDAY Voice in the neural voice header", () => {
    const nv = read("electron/neural-voice.cjs");
    expect(nv).toContain("Offline speech is FRIDAY Voice");
    expect(nv).not.toMatch(/Supertonic/);
  });

  it("describes the voice catalog rows with FRIDAY names", () => {
    const cat = read("src/lib/friday/catalog.ts");
    expect(cat).toContain("Offline speech is FRIDAY Voice when that model is installed");
    expect(cat).toContain("Runs FRIDAY Ear Hindi inside the one speech worker");
    const voiceRows = cat.slice(cat.indexOf('"faster-whisper",'), cat.indexOf('"pyaec",'));
    expect(voiceRows).not.toMatch(CREDIT);
    expect(cat).not.toContain("IndicConformer int8");
    expect(cat).not.toContain("piper-tts is GPL");
  });
});
