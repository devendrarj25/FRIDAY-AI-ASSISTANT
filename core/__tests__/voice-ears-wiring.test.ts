/**
 * The listening settings reach the audio path: capture start configures the front end from `voice.ears`, the AGC
 * mode decides the browser gain constraint, the stream-open payload carries `ears` and its reply's gate engine is
 * kept, and the Doctor and Settings read what was measured. Source-pinned where a real microphone would be needed.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyEarsToFrontEnd,
  audioConstraints,
  earsStatsNow,
  noteStreamVad,
} from "@/lib/friday/voice-audio";
import { frontEndStats, resetFrontEnd } from "@/lib/friday/voice-engine/front-end-dsp";
import { DEFAULT_VOICE_EARS, preferences } from "@/lib/friday/preferences";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const setEars = (patch: Partial<typeof DEFAULT_VOICE_EARS>) =>
  preferences.setVoice({ ears: { ...preferences.getSnapshot().voice.ears, ...patch } });

describe("voice ears wiring", () => {
  beforeEach(() => {
    setEars({ ...DEFAULT_VOICE_EARS });
    resetFrontEnd();
    noteStreamVad(null);
  });

  it("agc 'own' and 'off' turn the browser gain control off, 'browser' keeps it on", () => {
    setEars({ agc: "own" });
    expect(audioConstraints().autoGainControl).toBe(false);
    setEars({ agc: "off" });
    expect(audioConstraints().autoGainControl).toBe(false);
    setEars({ agc: "browser" });
    expect(audioConstraints().autoGainControl).toBe(true);
  });

  it("source: the constraint is read from the stored agc, not a literal", () => {
    const src = read("src/lib/friday/voice-audio.ts");
    expect(src).toMatch(/autoGainControl: earsPrefs\(\)\.agc === "browser"/);
    expect(src).not.toMatch(/autoGainControl: true/);
  });

  it("applyEarsToFrontEnd hands hpf and agc to the front end and follows a change", () => {
    setEars({ hpf: false, agc: "own" });
    applyEarsToFrontEnd();
    expect(frontEndStats()).toMatchObject({ hpf: false, agc: "own" });
    setEars({ hpf: true, agc: "off" });
    applyEarsToFrontEnd();
    expect(frontEndStats()).toMatchObject({ hpf: true, agc: "off" });
  });

  it("capture start configures the front end and watches the setting", () => {
    const src = read("src/lib/friday/voice-audio.ts");
    expect(src).toMatch(/if \(step === 0\) \{\s*watchEars\(\);/);
    expect(src).toContain("preferences.subscribe(applyEarsToFrontEnd)");
  });

  it("stream-open carries the stored ears and keeps the reply's gate engine", () => {
    const src = read("src/lib/friday/voice-stt.ts");
    expect(src).toContain("bridge: earsBridge(desktop())");
    expect(src).toMatch(/ears: preferences\.getSnapshot\(\)\.voice\.ears/);
    expect(src).toContain("noteStreamVad(");
  });

  it("measured stats are null with nothing running, and show the gate engine once a stream opened", () => {
    expect(earsStatsNow()).toBeNull();
    noteStreamVad("silero");
    expect(earsStatsNow()).toEqual({ vad: { engine: "silero", p: null, speechMs: null } });
    noteStreamVad("bogus");
    expect(earsStatsNow()).toBeNull();
  });

  it("the Doctor and the settings page both read the measured stats", () => {
    expect(read("src/lib/friday/doctor-engine.ts")).toMatch(
      /voiceLayerChecks\(voiceDoctorMarks\(\), earsDoctorInput\(\)\)/,
    );
    expect(read("src/components/friday/settings/VoiceSettings.tsx")).toContain(
      "<VoiceEarsSettings readStats={readEarsStats} />",
    );
  });
});
