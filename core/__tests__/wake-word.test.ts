/**
 * Wake word: Auto Mode must actually recognise its own name.
 *
 * The old `\bfriday\b` RegExp missed nearly every transcript faster-whisper
 * really produces — punctuation, carriers ("hey friday"), Hindi spelling and
 * one-character recognition slips. These are behavioural tests on the real
 * matcher, not source-text assertions.
 */
import { describe, expect, it } from "vitest";
import {
  isSelfEchoTranscript,
  isStopCommand,
  isWakeToken,
  matchWakeWord,
} from "../../src/lib/friday/wake-word";

describe("wake word", () => {
  it("matches the plain name in every casing and with punctuation", () => {
    for (const text of ["friday open chrome", "Friday, open chrome", "FRIDAY! open chrome"]) {
      const match = matchWakeWord(text);
      expect(match.matched).toBe(true);
      expect(match.command).toBe("open chrome");
    }
  });

  it("accepts natural carriers in front of the name", () => {
    for (const text of ["hey friday what time is it", "okay Friday, what time is it"]) {
      const match = matchWakeWord(text);
      expect(match.matched).toBe(true);
      expect(match.command).toBe("what time is it");
    }
  });

  it("recognises the Hindi spellings of the name", () => {
    expect(isWakeToken("फ्राइडे", "friday")).toBe(true);
    expect(isWakeToken("फ्रायडे", "friday")).toBe(true);
    const match = matchWakeWord("फ्राइडे लाइट बंद करो");
    expect(match.matched).toBe(true);
    expect(match.command).toBe("लाइट बंद करो");
  });

  it("tolerates a single transcription slip but not a different word", () => {
    expect(matchWakeWord("fridey open notepad").matched).toBe(true);
    expect(matchWakeWord("fryday open notepad").matched).toBe(true);
    expect(matchWakeWord("holiday open notepad").matched).toBe(false);
    expect(matchWakeWord("open notepad").matched).toBe(false);
  });

  it("wakes on a mid-sentence name but keeps the whole request", () => {
    const match = matchWakeWord("and friday please open chrome");
    expect(match.matched).toBe(true);
    expect(match.command).toBe("and friday please open chrome");
  });

  it("returns an empty command for the bare name so FRIDAY can answer 'Yes?'", () => {
    expect(matchWakeWord("Friday?").command).toBe("");
  });

  it("honours a custom wake word from preferences", () => {
    expect(matchWakeWord("jarvis open chrome", "jarvis").matched).toBe(true);
    expect(matchWakeWord("friday open chrome", "jarvis").matched).toBe(false);
  });

  it("treats stop words as an interruption, never a command", () => {
    for (const text of ["stop", "Friday, stop", "cancel", "रुक जाओ", "Ruko.", "ruk jao"])
      expect(isStopCommand(text)).toBe(true);
    expect(isStopCommand("stop the music")).toBe(false);
    expect(isStopCommand("ruko pehle second wala batao")).toBe(false);
  });

  it("rejects FRIDAY's own spoken line as microphone echo", () => {
    expect(
      isSelfEchoTranscript(
        "Is file mein teen issues hain",
        "Is file mein teen issues hain. Pehle wala login timeout hai.",
      ),
    ).toBe(true);
    expect(
      isSelfEchoTranscript("ruko pehle second wala batao", "Is file mein teen issues hain"),
    ).toBe(false);
  });
});

describe("auto mode voice session", () => {
  it("keeps the stored hands-free flag starting false and still matches the wake word", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(source).toContain("handsFree: false");
    expect(source).toContain("matchWakeWord(text, wakeWord())");
    expect(source).not.toContain("wakeExpression");
  });

  it("never drops an utterance just because whisper is busy", async () => {
    const { readFileSync } = await import("node:fs");
    const dictation = readFileSync("src/lib/friday/voice-stt.ts", "utf8");
    expect(dictation).toMatch(/private enqueue\(blob: Blob/);
    expect(dictation).toContain("private async pump()");
    expect(dictation).toContain("queued — still transcribing the previous utterance");
  });
});
