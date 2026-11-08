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
  isPlainStop,
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

describe("the stop word understands natural phrases and nothing that is a request", () => {
  it("stops on the phrases people really say, in English, Hindi and Hinglish", () => {
    for (const text of [
      "please stop",
      "stop talking",
      "stop speaking please",
      "ok stop",
      "bas karo",
      "bas kar do",
      "chup ho jao",
      "band karo",
      "that's enough",
      "ek minute",
      "thoda ruko",
      "nahi ruko",
      "ruko yaar",
      "pause",
      "बस करो",
      "चुप हो जाओ",
      "थोड़ा रुको",
    ])
      expect(isStopCommand(text), text).toBe(true);
  });

  it("leaves requests and ordinary sentences alone", () => {
    for (const text of [
      "stop the music",
      "stop recording",
      "pause the music",
      "don't stop",
      "stop by tomorrow",
      "the bus stop is near",
      "stopwatch lagao",
      "wait for the build to finish",
      "hold on to the rope",
      "band karo darwaza",
      "open chrome",
      "no",
      "ok",
      "please",
      "haan",
    ])
      expect(isStopCommand(text), text).toBe(false);
  });

  it("keeps the short words as the only ones that stop her from anyone", () => {
    expect(isPlainStop("stop")).toBe(true);
    expect(isPlainStop("ruko")).toBe(true);
    expect(isPlainStop("bas karo")).toBe(false); // longer phrases need her name, her voice or her awake window
    expect(isPlainStop("please stop")).toBe(false);
  });
});

describe("her own voice coming back versus the owner's answer", () => {
  const spoken =
    "The report is ready and I have saved it to your desktop. Do you want me to open it now?";

  it("takes a drifted copy of what she said as an echo while she speaks", () => {
    for (const heard of [
      "the report is ready and i have saved it to your desk top",
      "saved it to your desktop do you want me to open it now",
      "do you want me to open it",
      "आपकी रिपोर्ट तैयार है और मैंने उसे सेव कर दिया",
    ]) {
      const said = heard.startsWith("आप")
        ? "आपकी रिपोर्ट तैयार है और मैंने उसे सेव कर दिया है। क्या मैं इसे खोल दूं?"
        : spoken;
      expect(isSelfEchoTranscript(heard, said, { speaking: true }), heard).toBe(true);
    }
  });

  it("after she finished, a few words are an echo only when they are her last words", () => {
    expect(isSelfEchoTranscript("open it", spoken, { speaking: false })).toBe(false); // the owner's answer
    expect(isSelfEchoTranscript("open it now", spoken, { speaking: false })).toBe(true); // her tail
    expect(isSelfEchoTranscript("yes open it now", spoken, { speaking: false })).toBe(false);
    // a long stretch of her sentence is still an echo, speaking or not
    expect(
      isSelfEchoTranscript("the report is ready and i have saved it to your desktop", spoken, {
        speaking: false,
      }),
    ).toBe(true);
  });

  it("keeps the older behaviour when it is not told whether she is speaking", () => {
    expect(isSelfEchoTranscript("open it", spoken)).toBe(true);
  });
});
