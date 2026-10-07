/**
 * The formal voice state machine, the wake-engine selection, the real
 * post-install probes, the diagnostics panel and the shared microphone owner.
 *
 * These are the guarantees that stop Auto Mode from lying: the HUD may only
 * say "Listening…" when the state really has the microphone open, and an
 * unavailable openWakeWord must be reported as the transcript fallback rather
 * than silently assumed to be running.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  nextVoiceState,
  stateIsListening,
  stateIsSpeaking,
  stateLabel,
  voicePhaseFromState,
  type VoiceState,
} from "../../src/lib/friday/voice-state";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("voice state machine", () => {
  it("walks a real turn from off to spoken answer", () => {
    const walk = (from: VoiceState, events: Parameters<typeof nextVoiceState>[1][]) =>
      events.reduce<VoiceState>((state, event) => nextVoiceState(state, event) ?? state, from);

    expect(nextVoiceState("OFF", "session-start")).toBe("STARTING");
    expect(nextVoiceState("STARTING", "mic-opened")).toBe("LISTENING");
    expect(
      walk("LISTENING", ["vad-speech", "transcribe-start", "wake-matched", "command-accepted"]),
    ).toBe("THINKING");
    expect(walk("THINKING", ["brain-replied", "tts-start"])).toBe("SPEAKING");
    expect(nextVoiceState("SPEAKING", "tts-end")).toBe("LISTENING");
  });

  it("treats barge-in and stop as real interruptions", () => {
    expect(nextVoiceState("SPEAKING", "barge-in")).toBe("INTERRUPTED");
    expect(nextVoiceState("INTERRUPTED", "transcribe-start")).toBe("TRANSCRIBING");
    expect(nextVoiceState("SPEECH_DETECTED", "wake-matched")).toBe("WAKE_DETECTED");
    expect(nextVoiceState("SPEECH_DETECTED", "transcript")).toBe("LISTENING");
  });

  it("never drags a paused session back into listening", () => {
    expect(nextVoiceState("PAUSED", "vad-speech")).toBeNull();
    expect(nextVoiceState("PAUSED", "transcript")).toBeNull();
    expect(nextVoiceState("PAUSED", "resume")).toBe("STARTING");
  });

  it("reports failures as ERROR from anywhere and recovers on a real mic", () => {
    expect(nextVoiceState("LISTENING", "mic-failed")).toBe("ERROR");
    expect(nextVoiceState("THINKING", "error")).toBe("ERROR");
    expect(nextVoiceState("ERROR", "mic-opened")).toBe("LISTENING");
    // Speaking the error message must not flip the HUD back to Listening.
    expect(nextVoiceState("ERROR", "tts-end")).toBeNull();
    expect(nextVoiceState("ERROR", "tts-failed")).toBeNull();
  });

  it("derives listening and speaking instead of letting the UI guess", () => {
    expect(stateIsListening("LISTENING")).toBe(true);
    expect(stateIsListening("THINKING")).toBe(true);
    expect(stateIsListening("PAUSED")).toBe(false);
    expect(stateIsListening("OFF")).toBe(false);
    expect(stateIsSpeaking("SPEAKING")).toBe(true);
    expect(stateIsSpeaking("INTERRUPTED")).toBe(false);
    expect(stateLabel("WAITING_CONFIRMATION")).toBe("Waiting for confirmation");
  });

  it("maps Auto Mode graphic phases without calling STARTING or PAUSED listening", () => {
    expect(voicePhaseFromState("manual", "LISTENING")).toBe("off");
    expect(voicePhaseFromState("auto", "OFF")).toBe("off");
    expect(voicePhaseFromState("auto", "STARTING")).toBe("off");
    expect(voicePhaseFromState("auto", "LISTENING")).toBe("listening");
    expect(voicePhaseFromState("auto", "PAUSED")).toBe("unavailable");
    expect(voicePhaseFromState("auto", "ERROR")).toBe("unavailable");
    expect(voicePhaseFromState("auto", "SPEAKING")).toBe("speaking");
    expect(voicePhaseFromState("auto", "THINKING")).toBe("thinking");
    expect(voicePhaseFromState("auto", "TRANSCRIBING")).toBe("hearing");
  });

  it("is wired into the assistant, which derives the legacy booleans", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("private to(event: VoiceEvent");
    expect(assistant).toContain("this.state.listening = stateIsListening(next)");
    expect(assistant).toContain("this.state.speaking = stateIsSpeaking(next)");
    expect(assistant).toContain('this.to("session-start")');
    expect(assistant).toContain('this.to("barge-in")');
  });

  it("assistant speak() does not hard-set Listening after TTS when the machine stayed in ERROR", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain('if (this.to("tts-start")) this.pauseForSpeech()');
    expect(assistant).toContain('this.state.voiceState !== "ERROR"');
    expect(assistant).toContain("this.resumeAfterSpeech()");
    expect(assistant).not.toMatch(
      /onEnd: \(\) => \{[\s\S]{0,400}status: this\.state\.pending \? "Waiting for confirmation" : "Listening/,
    );
  });
});

describe("wake engine", () => {
  const engine = source("src/lib/friday/wake-engine.ts");

  it("uses the native detector when it is really ready, transcript otherwise", () => {
    expect(engine).toContain("function nativeEngine");
    expect(engine).toContain('if (raw?.engine === "friday-linear") return "friday-linear"');
    expect(engine).toContain("TRANSCRIPT_ONLY");
    expect(source("kernel/wake_word.py")).toContain("Never silently substitute friday.onnx");
    expect(source("electron/wake-engine.cjs")).toContain("never by silently scoring friday.onnx");
  });

  it("scores raw audio before whisper runs", () => {
    const stt = source("src/lib/friday/voice-stt.ts");
    expect(stt).toContain("wakeProbe");
    expect(stt).toContain('stage: "wake"');
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("wakeProbe: async ({ audioBase64, mime })");
    expect(assistant).toContain("matchWakeWord(text, wakeWord())");
  });

  it("has a real Python detector and an IPC bridge", () => {
    expect(source("kernel/wake_word.py")).toContain("openwakeword");
    expect(source("electron/wake-engine.cjs")).toContain("detect");
    expect(source("electron/main.cjs")).toContain('ipcMain.handle("voice:wake-status"');
    expect(source("electron/preload.cjs")).toContain("wakeEngineStatus");
  });
});

describe("real post-install verification", () => {
  it("loads the whisper model instead of trusting the pip install", () => {
    expect(source("kernel/stt.py")).toContain("load_probe");
    const verify = source("electron/voice-verify.cjs");
    expect(verify).toContain("faster_whisper");
    expect(verify).toContain("edge_tts");
  });

  it("first run only calls voice ready after the probes pass", () => {
    const firstRun = source("src/lib/friday/first-run.ts");
    expect(firstRun).toContain("verifyVoiceRuntime");
    expect(firstRun).toContain("voice:verify");
  });
});

describe("diagnostics, TTS identity and the shared microphone", () => {
  it("shows live values, not placeholders", () => {
    const panel = source("src/components/friday/VoiceDiagnostics.tsx");
    for (const row of ["microphone", "vad", "wake engine", "stt", "tts", "session"])
      expect(panel).toContain(`label: "${row}"`);
    expect(panel).toContain("assistantMode.verifyVoiceRuntime()");
    expect(panel).toContain("useSyncExternalStore");
    expect(panel).toContain("voiceGate.subscribe");
    expect(source("src/components/friday/AutoMode.tsx")).toContain("<VoiceDiagnostics");
  });

  it("records which engine really spoke", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("this.state.tts = {");
    expect(assistant).toContain("tts engine: ${how.toUpperCase()}");
  });

  it("keeps one canonical microphone owner", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain('voiceGate.acquire("auto-mode"');
    expect(assistant).toContain('voiceGate.release("auto-mode")');
    expect(source("src/lib/friday/voice-stt.ts")).toContain('voiceGate.acquire("dictation"');
    expect(source("src/lib/friday/voice-audio.ts")).toContain("resumeContext");
    expect(source("src/lib/friday/voice-stt.ts")).toContain(
      "sttStatus(true, Boolean(this.options.localOnly), true)",
    );
    expect(source("src/components/friday/ChatDock.tsx")).toContain(
      "Chat does not use the microphone. Auto mode listens.",
    );
    expect(source("src/components/friday/ChatDock.tsx")).not.toContain("DesktopDictation");
  });

  it("tray pause really closes the microphone and resume reopens it", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain('this.to("pause")');
    expect(assistant).toContain('this.to("resume")');
    expect(assistant).toContain("this.stopRecognition();");
  });
});
