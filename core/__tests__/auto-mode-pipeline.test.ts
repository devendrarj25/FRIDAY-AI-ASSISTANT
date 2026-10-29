/**
 * BUG 3 — Auto Mode went permanently deaf and said nothing about it.
 *
 * Root cause proven here: `DesktopDictation` latched `speaking = true` before
 * it knew a segment could start. When a transcription was still in flight (or
 * MediaRecorder threw) no recorder existed, nothing ever cleared the latch,
 * and `speech && !speaking` never fired again — every later utterance was
 * dropped with no error, no caption and no log.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const dictation = source("src/lib/friday/voice-stt.ts");
const assistant = source("src/lib/friday/assistant-mode.ts");
const ui = source("src/components/friday/AutoMode.tsx");

describe("capture never latches itself deaf", () => {
  it("only marks speech as captured when a segment really started", () => {
    expect(dictation).toContain("this.speaking = this.beginSegment()");
    expect(dictation).not.toMatch(/this\.speaking = true;\s*\n\s*this\.options\.onSpeechStart/);
  });

  it("beginSegment reports failure instead of pretending", () => {
    expect(dictation).toContain("private beginSegment(): boolean");
    expect(dictation).toContain("still transcribing the previous utterance");
  });

  it("always releases the latch when an utterance finishes, however it ended", () => {
    expect(dictation).toMatch(/finally \{[\s\S]*this\.speaking = false;/);
  });

  it("never discards audio silently", () => {
    expect(dictation).toContain("utterance too short to transcribe");
    expect(dictation).toContain("no transcribe bridge");
    expect(dictation).toContain('stage: "transcript"');
    expect(dictation).toContain("utterance captured · ${chunkCount} chunks");
  });
});

describe("the whole pipeline is observable", () => {
  it("traces every stage from microphone to wake word", () => {
    for (const stage of ["speech", "segment", "dropped", "transcribing", "transcript", "wake"]) {
      expect(assistant).toContain(`"${stage}"`);
    }
    expect(assistant).toContain("onDiagnostic: (event)");
    expect(assistant).toContain("voiceLog: VoiceTrace[]");
  });

  it("logs why a wake-word attempt was accepted or rejected", () => {
    expect(source("src/lib/friday/wake-word.ts")).toContain("wake word matched");
    expect(assistant).toContain("no wake word, not awake, not a hands-free turn");
  });

  it("gives Whisper enough time before calling a short command noise", () => {
    expect(assistant).toContain("voiceGate.heardSpeechWithin(6000)");
    expect(assistant).not.toContain("voiceGate.heardSpeechWithin(1500)");
  });

  it("keeps barge-in and shows it in the trace", () => {
    expect(assistant).toContain("barge-in — stopping playback");
    expect(assistant).toContain("if (this.state.speaking) {");
    expect(assistant).toContain("this.cancelSpeech();");
    expect(assistant).toContain("brain.stop()");
    expect(assistant).toContain('result.reason === "busy"');
  });

  it("shows the live trace in the Auto Mode screen", () => {
    expect(ui).toContain("voice.voiceLog");
    expect(ui).toContain("voice pipeline");
  });
});
