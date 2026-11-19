import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_PROMPTS,
  DEFAULT_THRESHOLD,
  GOOD_WAKE_TAKES,
  MIN_SPEECH_CLIPS,
  SPEECH_PROMPTS,
  WAKE_PROMPTS,
  enrollProgress,
  ownerVoice,
  parseThreshold,
  parseVocabulary,
  promptText,
  scoreUtterance,
  speakerInput,
  voiceTurnGate,
  type VoiceSettingsView,
} from "../../src/lib/friday/voice-profile";
import { speakerDecision } from "../../src/lib/friday/voice-session";
import type { VoiceMatchResult } from "../../src/lib/friday/desktop";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

const settings = (over: Partial<VoiceSettingsView> = {}): VoiceSettingsView => ({
  recogniseMyVoice: true,
  ownerVoiceOnly: false,
  personalWake: true,
  threshold: DEFAULT_THRESHOLD,
  ...over,
});

const voice = (
  similarity: number | null,
  wake?: Partial<NonNullable<VoiceMatchResult["wake"]>>,
): VoiceMatchResult => ({
  ok: true,
  enrolled: true,
  speaker: { enrolled: true, similarity, match: (similarity ?? 0) >= 0.75, reason: "x" },
  wake: { ready: true, matched: false, reason: "x", ...(wake ?? {}) },
});

describe("the guided prompts", () => {
  it("cover the wake word with varied takes and English, Hindi and Hinglish sentences", () => {
    expect(WAKE_PROMPTS).toHaveLength(GOOD_WAKE_TAKES);
    expect(new Set(WAKE_PROMPTS.map((p) => p.hint)).size).toBe(GOOD_WAKE_TAKES);
    expect(SPEECH_PROMPTS.length).toBeGreaterThanOrEqual(MIN_SPEECH_CLIPS);
    expect(new Set(SPEECH_PROMPTS.map((p) => p.language))).toEqual(
      new Set(["en", "hi", "hinglish"]),
    );
    expect(SPEECH_PROMPTS.some((p) => /[ऀ-ॿ]/.test(p.text))).toBe(true);
    expect(new Set(ALL_PROMPTS.map((p) => p.id)).size).toBe(ALL_PROMPTS.length);
    expect(ALL_PROMPTS.every((p) => /^[a-z0-9-]+$/.test(p.id))).toBe(true);
  });

  it("say the wake word the owner chose", () => {
    expect(promptText(WAKE_PROMPTS[0]!, "Jarvis")).toBe("Jarvis");
    expect(promptText(SPEECH_PROMPTS[0]!, "Jarvis")).toContain("Jarvis,");
    expect(promptText(WAKE_PROMPTS[0]!, "")).toBe("Friday");
  });
});

describe("how much is enough", () => {
  it("says what is still missing, in plain words", () => {
    expect(enrollProgress(undefined)).toMatchObject({ canBuild: false });
    const some = enrollProgress({
      total: 3,
      wakeTakes: 3,
      speechClips: 0,
      speechSeconds: 0,
      byPrompt: {},
    });
    expect(some.canBuild).toBe(false);
    expect(some.missing).toContain("6 more sentences");
    expect(some.missing).toContain("2 more takes");
    const enough = enrollProgress({
      total: 14,
      wakeTakes: 8,
      speechClips: 6,
      speechSeconds: 24,
      byPrompt: {},
    });
    expect(enough).toMatchObject({
      canBuild: true,
      wakeEnough: true,
      speechEnough: true,
      missing: "",
    });
    // sentences alone are worth building: the voiceprint needs no wake takes
    expect(
      enrollProgress({ total: 6, wakeTakes: 0, speechClips: 6, speechSeconds: 21, byPrompt: {} })
        .canBuild,
    ).toBe(true);
    expect(
      enrollProgress({ total: 6, wakeTakes: 0, speechClips: 6, speechSeconds: 10, byPrompt: {} })
        .missing,
    ).toContain("seconds");
  });
});

describe("is it the owner's voice", () => {
  it("is unknown, never a mismatch, when it cannot be told", () => {
    expect(ownerVoice(null)).toBeNull();
    expect(ownerVoice({ ok: true, enrolled: false, speaker: null })).toBeNull();
    expect(ownerVoice(voice(null))).toBeNull();
    expect(ownerVoice(voice(0.9))).toBe(true);
    expect(ownerVoice(voice(0.5))).toBe(false);
    expect(ownerVoice(voice(0.6), 0.5)).toBe(true);
  });

  it("reads the owner's bar and falls back to the calibrated edge", () => {
    expect(parseThreshold(undefined)).toBe(0.75);
    expect(parseThreshold("0.82")).toBe(0.82);
    expect(parseThreshold("banana")).toBe(0.75);
    expect(parseThreshold("5")).toBe(0.75);
    expect(parseThreshold("0.1")).toBe(0.75);
  });
});

describe("what Auto mode does with a scored utterance", () => {
  const base = { transcriptWake: false, isStop: false, words: 2 };

  it("changes nothing without a saved voice", () => {
    for (const s of [settings(), settings({ ownerVoiceOnly: true })]) {
      expect(voiceTurnGate({ voice: null, settings: s, ...base })).toMatchObject({
        ignore: false,
        personalWake: false,
      });
      expect(
        voiceTurnGate({ voice: { ok: true, enrolled: false }, settings: s, ...base }),
      ).toMatchObject({ ignore: false });
    }
  });

  it("ignores another voice only when asked, only when sure, and never a stop", () => {
    const stranger = voice(0.4);
    expect(voiceTurnGate({ voice: stranger, settings: settings(), ...base }).ignore).toBe(false);
    expect(
      voiceTurnGate({ voice: stranger, settings: settings({ ownerVoiceOnly: true }), ...base })
        .ignore,
    ).toBe(true);
    expect(
      voiceTurnGate({
        voice: stranger,
        settings: settings({ ownerVoiceOnly: true }),
        ...base,
        isStop: true,
      }).ignore,
    ).toBe(false);
    expect(
      voiceTurnGate({ voice: voice(0.9), settings: settings({ ownerVoiceOnly: true }), ...base })
        .ignore,
    ).toBe(false);
    // too little speech to tell: heard, not dropped
    expect(
      voiceTurnGate({ voice: voice(null), settings: settings({ ownerVoiceOnly: true }), ...base })
        .ignore,
    ).toBe(false);
  });

  it("wakes on the owner's own template only when it is ready, matched, short and not another voice", () => {
    const hit = voice(0.9, { matched: true });
    expect(voiceTurnGate({ voice: hit, settings: settings(), ...base }).personalWake).toBe(true);
    expect(
      voiceTurnGate({ voice: hit, settings: settings({ personalWake: false }), ...base })
        .personalWake,
    ).toBe(false);
    expect(
      voiceTurnGate({ voice: hit, settings: settings(), ...base, transcriptWake: true })
        .personalWake,
    ).toBe(false);
    expect(
      voiceTurnGate({ voice: hit, settings: settings(), ...base, words: 6 }).personalWake,
    ).toBe(false);
    expect(
      voiceTurnGate({ voice: voice(0.9, { matched: false }), settings: settings(), ...base })
        .personalWake,
    ).toBe(false);
    expect(
      voiceTurnGate({
        voice: voice(0.9, { matched: true, ready: false }),
        settings: settings(),
        ...base,
      }).personalWake,
    ).toBe(false);
    // the template matched but the voice clearly is not the owner's: no wake
    expect(
      voiceTurnGate({ voice: voice(0.3, { matched: true }), settings: settings(), ...base })
        .personalWake,
    ).toBe(false);
    // the voice could not be told: the template alone may wake
    expect(
      voiceTurnGate({ voice: voice(null, { matched: true }), settings: settings(), ...base })
        .personalWake,
    ).toBe(true);
  });

  it("feeds the speaker check only when recognition is on, and a match still approves nothing", () => {
    expect(speakerInput(voice(0.9), settings({ recogniseMyVoice: false }))).toMatchObject({
      enrolled: false,
      similarity: null,
    });
    expect(speakerInput(null, settings())).toMatchObject({ enrolled: false });
    const mine = speakerInput(voice(0.9), settings());
    expect(speakerDecision({ ...mine, sensitive: true })).toEqual({
      allow: true,
      execute: false,
      reason: "speaker-match",
    });
    const other = speakerInput(voice(0.5), settings());
    expect(speakerDecision({ ...other, sensitive: true })).toEqual({
      allow: false,
      execute: false,
      reason: "speaker-mismatch",
    });
    expect(speakerDecision({ ...other, sensitive: false }).allow).toBe(true);
    // no saved voice: ordinary and sensitive lines are heard exactly as before
    expect(speakerDecision({ similarity: null, enrolled: false, sensitive: true }).allow).toBe(
      true,
    );
    // the owner's own bar is honoured
    expect(
      speakerDecision({ similarity: 0.6, enrolled: true, sensitive: true, threshold: 0.5 }).allow,
    ).toBe(true);
    expect(
      speakerDecision({ similarity: 0.6, enrolled: true, sensitive: true, threshold: 0.9 }).allow,
    ).toBe(false);
  });

  it("scores nothing, and asks the desktop nothing, while no voice is saved", async () => {
    expect(await scoreUtterance({ audioBytes: new Uint8Array(10), mime: "audio/webm" })).toBeNull();
  });
});

describe("the owner's own words", () => {
  it("are split, trimmed, de-duplicated and capped", () => {
    expect(parseVocabulary("Devendra, Pune;  Hinglish\n chai,devendra ,")).toEqual([
      "Devendra",
      "Pune",
      "Hinglish",
      "chai",
    ]);
    expect(parseVocabulary(undefined)).toEqual([]);
    expect(parseVocabulary(Array.from({ length: 50 }, (_, i) => `w${i}`).join(",")).length).toBe(
      30,
    );
  });
});

describe("the wiring", () => {
  it("records through the one shared microphone, never by opening a second one", () => {
    const recorder = read("src/lib/friday/voice-enroll-recorder.ts");
    expect(recorder).toContain("voiceGate.acquire(HOLDER");
    expect(recorder).toContain("voiceGate.release(HOLDER)");
    expect(recorder).toContain("subscribeCaptureFrames");
    expect(recorder).not.toMatch(/getUserMedia|new AudioContext|MediaRecorder/);
    // a hard cap, so a recording that is never stopped cannot keep the microphone open
    expect(recorder).toContain("MAX_SAMPLE_MS");
  });

  it("scores every utterance beside the transcription and hands the result to the turn", () => {
    const stt = read("src/lib/friday/voice-stt.ts");
    expect(stt).toContain("voiceProbe");
    expect(stt).toContain("VOICE_PROBE_MS");
    expect(stt).toContain("voice,\n            wake,");
    const assistant = read("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("voiceProbe: ({ audioBytes, mime }) => scoreUtterance");
    expect(assistant).toContain("this.turnVoice = meta?.voice ?? null");
    expect(assistant).toContain("voiceTurnGate({");
    // One helper makes the saved-voice verdict for the command gate and for the approving "yes", and it
    // carries whether the turn's audio could be scored at all.
    expect(assistant).toContain(
      "...speakerInput(this.turnVoice, this.voiceSettings(), this.turnUnverified)",
    );
    expect(assistant.match(/this\.speakerVerdict\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(assistant).toContain("this.turnPersonalWake");
    // the old hard-coded "never scored" speaker check is gone
    expect(assistant).not.toMatch(
      /similarity: null,\s*enrolled: false,\s*sensitive: heardSensitive/,
    );
  });

  it("is reachable from Settings and carries every channel from the page to the main process", () => {
    expect(read("src/components/friday/settings/VoiceSettings.tsx")).toContain(
      "<VoiceEnrollment />",
    );
    const channels = [
      "status",
      "save-sample",
      "delete-sample",
      "read-sample",
      "build",
      "score",
      "clear-recordings",
      "forget",
    ].map((name) => `voice-enroll:${name}`);
    const preload = read("electron/preload.cjs");
    const main = read("electron/main.cjs");
    const budget = read("electron/ipc-budget-table.cjs");
    for (const channel of channels) {
      expect(preload, channel).toContain(`"${channel}"`);
      expect(main, channel).toContain(`ipcMain.handle("${channel}"`);
      expect(budget, channel).toContain(`"${channel}"`);
    }
    expect(budget).toContain('"voice-enroll:build": "long-job"');
  });

  it("keeps the recordings out of the cloud and the profile encrypted", () => {
    const main = read("electron/voice-enroll.cjs");
    expect(main).toContain("secretBox.encryptText");
    expect(main).not.toMatch(/fetch\(|https?:\/\//);
    expect(read("kernel/voice_enroll.py")).not.toMatch(/requests|httpx|urllib|socket/);
  });
});
