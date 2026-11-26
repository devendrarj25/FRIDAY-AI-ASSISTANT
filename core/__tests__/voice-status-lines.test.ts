/**
 * The live status line follows the owner's wake word and reply language, a muted, paused or failed state never
 * tells the owner to say the wake word, and the live state carries the phase and the dictation flag the chips read.
 *
 * Pure rules (`STATUS_LINES`, `statusLine`) are tested directly; the conductor is driven with injected state and a
 * stubbed gate (no microphone, speech engine or network), plus source pins for the wiring the driver cannot reach
 * (the download row, the privacy remedy, the plain error line).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import { brain } from "../../src/lib/friday/brain-engine";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";
import {
  STATUS_LINES,
  statusLine,
  type StatusKey,
} from "../../src/lib/friday/voice-engine/narration-policy";

const source = (path: string) => readFileSync(path, "utf8");
const KEYS = Object.keys(STATUS_LINES) as StatusKey[];
const DEVANAGARI = /[ऀ-ॿ]/;
/** States that never ask the owner to speak: the microphone is closed or the voice path failed. */
const SILENT: StatusKey[] = [
  "muted",
  "paused",
  "stopped",
  "stop-on",
  "call-open",
  "voice-error",
  "reset-mic",
];

(globalThis as unknown as { window?: unknown }).window ??= globalThis;

describe("status lines in three languages", () => {
  it("has the keys the conductor sets", () => {
    for (const key of [
      "wake-needed",
      "awake",
      "listening",
      "thinking",
      "muted",
      "paused",
      "stopped",
      "call-open",
      "waiting-yesno",
      "waiting-confirm",
      "confirm-expired",
      "approval-expired",
      "starting-mic",
      "voice-error",
      "reset-mic",
      "mic-privacy-opened",
    ])
      expect(KEYS).toContain(key);
    expect(KEYS.length).toBeGreaterThanOrEqual(20);
  });

  it("gives every key an English, a Hindi (Devanagari) and a Hinglish (Latin) line", () => {
    for (const key of KEYS) {
      const row = STATUS_LINES[key];
      expect(row.en.trim(), key).not.toBe("");
      expect(row.hi.trim(), key).not.toBe("");
      expect(row.hinglish.trim(), key).not.toBe("");
      expect(DEVANAGARI.test(row.en), `${key} en`).toBe(false);
      expect(DEVANAGARI.test(row.hi), `${key} hi`).toBe(true);
      expect(DEVANAGARI.test(row.hinglish), `${key} hinglish`).toBe(false);
      expect(row.hi, key).not.toBe(row.en);
      expect(row.hinglish, key).not.toBe(row.hi);
    }
  });

  it("keeps the English lines the app showed before", () => {
    expect(statusLine("wake-needed", "en", "friday")).toBe("Say “FRIDAY …” to start");
    expect(statusLine("muted", "en")).toBe("Muted. Microphone is off");
    expect(statusLine("paused", "en")).toBe("Microphone paused");
    expect(statusLine("confirm-expired", "en")).toBe("Confirmation expired");
    expect(statusLine("waiting-yesno", "en")).toBe("Waiting for yes or no");
    expect(statusLine("thinking", "en")).toBe("Thinking…");
  });

  it("puts the wake word the owner chose into the line, in every language", () => {
    expect(statusLine("wake-needed", "en", "jarvis")).toContain("Jarvis");
    expect(statusLine("wake-needed", "hi", "jarvis")).toContain("Jarvis");
    expect(statusLine("wake-needed", "hinglish", "jarvis")).toContain("Jarvis");
    expect(statusLine("wake-needed", "hinglish", "")).toContain("FRIDAY");
    expect(statusLine("booting", "en", "jarvis")).toBe("Waiting for Jarvis to finish starting");
    for (const lang of ["en", "hi", "hinglish"] as const)
      for (const key of KEYS)
        expect(statusLine(key, lang, "jarvis"), `${key} ${lang}`).not.toContain("{wake}");
  });

  it("never says the wake word in a muted, paused, stopped or error line", () => {
    for (const key of SILENT)
      for (const lang of ["en", "hi", "hinglish"] as const) {
        const line = statusLine(key, lang, "jarvis");
        expect(line, `${key} ${lang}`).not.toMatch(/jarvis|friday/i);
        expect(line, `${key} ${lang}`).not.toMatch(/\bsay\b|bolo|कहिए/i);
      }
  });

  it("falls back to English for an unknown language", () => {
    expect(statusLine("muted", "fr" as never)).toBe(STATUS_LINES.muted.en);
  });
});

describe("the conductor shows them", () => {
  type Driver = {
    state: Record<string, unknown> & {
      status: string;
      phase: string;
      dictating: boolean;
      muted: boolean;
      paused: boolean;
    };
    arbiter: SpeechArbiter;
    wantRunning: boolean;
    recognitionPending: boolean;
    autoMicDeferred: boolean;
    callHold: boolean;
    setMuted: (muted: boolean) => void;
    setPaused: (paused: boolean) => void;
    cancelSpeech: () => void;
    stopRecognition: () => void;
    startRecognition: () => void;
    openAutoMic: () => void;
    emit: () => void;
    idleLine: () => string;
  };
  const d = assistantMode as unknown as Driver;
  const realStart = d.startRecognition;
  const realStop = d.stopRecognition;
  const realOpen = d.openAutoMic;
  const realEmit = d.emit;
  const before = preferences.getSnapshot().voice;

  beforeEach(async () => {
    await preferences.hydrate();
    autonomy.reset();
    Object.assign(d.state, {
      mode: "auto",
      paused: false,
      muted: false,
      micReady: true,
      speaking: false,
    });
    d.arbiter = new SpeechArbiter({ now: () => Date.now() });
    d.wantRunning = true;
    d.recognitionPending = false;
    d.autoMicDeferred = false;
    d.callHold = false;
    d.cancelSpeech = () => undefined;
    d.stopRecognition = () => undefined;
    d.startRecognition = () => undefined;
    d.openAutoMic = () => undefined;
    vi.spyOn(brain, "stop").mockImplementation(() => undefined);
    vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
  });

  afterEach(() => {
    d.stopRecognition = realStop;
    d.startRecognition = realStart;
    d.openAutoMic = realOpen;
    d.emit = realEmit;
    preferences.setVoice({
      speechLang: before.speechLang,
      hinglish: before.hinglish,
      wakeWord: before.wakeWord,
    });
    vi.restoreAllMocks();
    autonomy.reset();
  });

  it("mute shows the line in the owner's reply language", () => {
    preferences.setVoice({ hinglish: false, speechLang: "hi-IN" });
    d.setMuted(true);
    expect(d.state.status).toBe(statusLine("muted", "hi"));
    d.state.muted = false;
    preferences.setVoice({ hinglish: true });
    d.setMuted(true);
    expect(d.state.status).toBe(statusLine("muted", "hinglish"));
    d.state.muted = false;
    preferences.setVoice({ hinglish: false, speechLang: "en-US" });
    d.setMuted(true);
    expect(d.state.status).toBe(statusLine("muted", "en"));
  });

  it("the idle line asks for the wake word only while the microphone listens", () => {
    preferences.setVoice({ hinglish: false, speechLang: "en-US", wakeWord: "jarvis" });
    Object.assign(d.state, { voiceState: "LISTENING" });
    expect(d.idleLine()).toBe(statusLine("wake-needed", "en", "jarvis"));
    d.state.muted = true;
    expect(d.idleLine()).toBe(statusLine("muted", "en"));
    d.state.muted = false;
    d.state.paused = true;
    expect(d.idleLine()).toBe(statusLine("paused", "en"));
    d.state.paused = false;
    Object.assign(d.state, { voiceState: "ERROR" });
    expect(d.idleLine()).toBe(statusLine("voice-error", "en"));
    expect(d.idleLine()).not.toMatch(/say/i);
    Object.assign(d.state, { voiceState: "LISTENING" });
  });

  it("emit derives phase from the voice state and dictating from a running note", () => {
    d.emit = realEmit;
    Object.assign(d.state, { mode: "auto", voiceState: "SPEAKING" });
    d.emit();
    expect(assistantMode.getSnapshot().phase).toBe("speaking");
    Object.assign(d.state, { voiceState: "PAUSED" });
    d.emit();
    expect(assistantMode.getSnapshot().phase).toBe("unavailable");
    Object.assign(d.state, { voiceState: "THINKING" });
    d.emit();
    expect(assistantMode.getSnapshot().phase).toBe("thinking");
    expect(assistantMode.getSnapshot().dictating).toBe(false);
    Object.assign(d.state, { mode: "manual" });
    d.emit();
    expect(assistantMode.getSnapshot().phase).toBe("off");
  });
});

describe("the wiring the driver cannot reach", () => {
  const src = source("src/lib/friday/assistant-mode.ts");

  it("declares dictating and phase on the state", () => {
    expect(src).toMatch(/dictating: boolean;/);
    expect(src).toMatch(/phase: VoicePhase;/);
    expect(src).toContain("voicePhaseFromState(this.state.mode, this.state.voiceState)");
  });

  it("no longer sets the status from a hard-coded English line", () => {
    for (const text of [
      "Say “FRIDAY …” to start",
      "Muted. Microphone is off",
      "Microphone paused",
      "Confirmation expired",
      "Approval expired",
      "Waiting for yes or no",
      "Press Reset microphone",
    ])
      expect(src, text).not.toContain(`this.state.status = "${text}"`);
  });

  it("keeps a failed voice-model download until the owner acts or a new event arrives", () => {
    expect(src).not.toContain('next.stage === "failed" ? 20000 : 4000');
    expect(src).toMatch(/next\.stage === "ready" \|\| next\.stage === "check"/);
    expect(src).not.toMatch(/next\.stage === "failed"/);
  });

  it("opens the Windows microphone privacy page through the desktop bridge", () => {
    expect(src).toMatch(
      /action === "show-mic-privacy"[\s\S]{0,400}openExternalUrl\?\.\(MIC_PRIVACY_LINK\)/,
    );
  });

  it("holds the plain fault line in the error field and the raw text in the trace", () => {
    expect(src).toContain("plainFaultLine(");
    expect(src).toMatch(/this\.trace\("error", message\);/);
  });
});
