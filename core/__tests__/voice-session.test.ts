/**
 * Auto mode is the only listen/speak surface. Chat does not open a microphone.
 * Hardware is not claimed here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptsVoiceTurn,
  busyReply,
  duplicateFinalUtterance,
  endpointSilenceMs,
  holdLines,
  microphoneAllowed,
  nextSpokenCursor,
  replyLanguage,
  spokenReplyAllowed,
  spokenRouteError,
  clarifyPrompt,
  takeSpeakable,
} from "../../src/lib/friday/voice-session";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("microphone and speech stay in Auto mode", () => {
  it("opens the microphone only while Auto mode is listening", () => {
    expect(microphoneAllowed("auto", false)).toBe(true);
    expect(microphoneAllowed("auto", true)).toBe(false);
    expect(microphoneAllowed("manual", false)).toBe(false);
  });

  it("speaks only in Auto mode, and mute stops that", () => {
    expect(spokenReplyAllowed("auto", false)).toBe(true);
    expect(spokenReplyAllowed("auto", true)).toBe(false);
    expect(spokenReplyAllowed("manual", false)).toBe(false);
  });

  it("treats a sentence in Auto mode as a turn, and a saved wake-word choice as a gate", () => {
    const open = {
      mode: "auto" as const,
      paused: false,
      wakeMatched: false,
      awake: false,
      handsFree: true,
      wakeWordRequired: false,
      words: 4,
      stop: false,
    };
    expect(acceptsVoiceTurn(open)).toBe(true);
    expect(acceptsVoiceTurn({ ...open, mode: "manual" })).toBe(false);
    expect(acceptsVoiceTurn({ ...open, paused: true })).toBe(false);
    expect(
      acceptsVoiceTurn({
        ...open,
        handsFree: false,
        wakeWordRequired: true,
        words: 6,
      }),
    ).toBe(false);
    expect(acceptsVoiceTurn({ ...open, words: 1, wakeMatched: true })).toBe(true);
    expect(acceptsVoiceTurn({ ...open, words: 1, stop: true, handsFree: false })).toBe(true);
  });

  it("ends an open turn on a shorter pause than a wake-word wait", () => {
    expect(endpointSilenceMs(true)).toBeLessThan(endpointSilenceMs(false));
    expect(endpointSilenceMs(true)).toBeGreaterThanOrEqual(300);
    expect(endpointSilenceMs(false)).toBeLessThanOrEqual(1200);
  });

  it("speaks a finished sentence before the rest of the answer arrives", () => {
    expect(takeSpeakable("The build is fine. The tests are still", false)).toEqual({
      spoken: "The build is fine.",
      consumed: "The build is fine. ".length,
    });
    expect(takeSpeakable("version v1.2 is next", false).spoken).toBe("");
    expect(takeSpeakable("version v1.2 is next", true).spoken).toBe("version v1.2 is next");
  });

  it("asks which one is meant only when there is no conversation to resolve it", () => {
    expect(clarifyPrompt("open it")).toBe("Which one do you mean?");
    expect(clarifyPrompt("open it", true)).toBe("");
    expect(clarifyPrompt("what is that")).toBe(""); // a question is never held up
    expect(clarifyPrompt("open the invoice")).toBe("");
  });

  it("tells a rewritten answer from more text by what was already spoken", () => {
    expect(nextSpokenCursor(13, 40)).toEqual({ cursor: 13, rewritten: false });
    expect(nextSpokenCursor(13, 5)).toEqual({ cursor: 0, rewritten: true }); // shorter than the spoken part
    const spoken = { prefix: "First draft. ", text: "First draft. Second part grows" };
    expect(nextSpokenCursor(13, 30, spoken).rewritten).toBe(false);
    // same length or longer, but the spoken part is no longer its start
    expect(
      nextSpokenCursor(13, 28, { prefix: "First draft. ", text: "Completely new answer. Next" })
        .rewritten,
    ).toBe(true);
    // a change of spaces or markdown marks is not a rewrite
    expect(
      nextSpokenCursor(13, 40, { prefix: "First draft. ", text: "**First** draft.  Second part" })
        .rewritten,
    ).toBe(false);
  });

  it("never cuts a sentence after an abbreviation, an initial or a list number", () => {
    const wait = (text: string) => expect(takeSpeakable(text, false).spoken, text).toBe("");
    wait("Please ask Dr. Singh about it");
    wait("Call at 5 p.m. tomorrow, ok");
    wait("Use e.g. this one");
    wait("Meet Mr. Rao and Mrs. Iyer");
    wait("1. First item\n2. Second item\n3. Third");
    // the sentence that really ends is still spoken, abbreviations inside it kept whole
    expect(takeSpeakable("Please ask Dr. Singh about it. Then call me back", false).spoken).toBe(
      "Please ask Dr. Singh about it.",
    );
    expect(takeSpeakable("J. K. Rowling wrote it. Yes", false).spoken).toBe(
      "J. K. Rowling wrote it.",
    );
    expect(takeSpeakable("I am here. I said it", false).spoken).toBe("I am here.");
    // and the tail is always spoken when the answer is final
    expect(takeSpeakable("Please ask Dr. Singh about it", true).spoken).toBe(
      "Please ask Dr. Singh about it",
    );
    // a number split across two streamed pieces is not a sentence end
    expect(takeSpeakable("The total is 3.", false).spoken).toBe("");
  });

  it("speaks a route failure as one sentence and keeps the chat text intact", () => {
    const full = [
      "I can't answer that one on my own — it needs a connected AI model, and none is reachable right now.",
      "Want me to help you connect a model in Models, or start a local one with Ollama?",
    ].join("\n\n");
    expect(spokenRouteError(full)).toBe(
      "No model is reachable. Connect one in Models, or start a local engine.",
    );
    expect(spokenRouteError("Checked the key. Try again.")).toBe("Checked the key. Try again.");
    expect(spokenRouteError("Hello there.\n\n[This model id is gone.]")).toBe(
      "This model id is gone.",
    );
    expect(spokenRouteError("")).toBe("");
  });

  it("drops a repeated final and restarts speech when the answer is replaced", () => {
    expect(duplicateFinalUtterance("open chrome", "open chrome", 400)).toBe(true);
    expect(duplicateFinalUtterance("open chrome", "open chrome", 2500)).toBe(false);
    expect(duplicateFinalUtterance("open chrome", "close chrome", 10)).toBe(false);
    expect(duplicateFinalUtterance("", "open chrome", 10)).toBe(false);
    expect(nextSpokenCursor(40, 12)).toEqual({ cursor: 0, rewritten: true });
    expect(nextSpokenCursor(40, 80)).toEqual({ cursor: 40, rewritten: false });
  });
});

describe("the existing voice owners enforce that policy", () => {
  it("gates capture, speech, and late playback in the auto-mode store", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("microphoneAllowed");
    expect(assistant).toContain("spokenReplyAllowed");
    expect(assistant).toContain("acceptsVoiceTurn");
    expect(assistant).toContain("takeSpeakable");
    expect(assistant).toContain("endpointSilenceMs");
    expect(assistant).toContain("this.speechGen");
    expect(assistant).toContain("handsFree: false");
    expect(assistant).toContain("duplicateFinalUtterance");
    expect(assistant).toContain("captionUserTurn");
    expect(assistant).toContain("nextSpokenCursor");
    expect(assistant).toContain("spokenRouteError");
    expect(assistant).toContain("voicedFaultFor");
  });

  it("does not let chat open a microphone or a browser recogniser", () => {
    const dock = source("src/components/friday/ChatDock.tsx");
    expect(dock).toContain("Chat does not use the microphone. Auto mode listens.");
    expect(dock).not.toContain("DesktopDictation");
    expect(dock).not.toContain("webkitSpeechRecognition");
    expect(dock).not.toContain("sttStatus");
    expect(dock).not.toContain("getUserMedia");
    expect(dock).toContain("if (!sent.accepted)");
  });

  it("does not speak a chat reply from the brain store", () => {
    const engine = source("src/lib/friday/brain-engine.ts");
    expect(engine).toContain("private speakReply");
    expect(engine).not.toContain("speakText");
    expect(engine).toContain("Manual and chat stay silent");
  });

  it("keeps the settings microphone control on the real pause path", () => {
    const settings = source("src/components/friday/settings/VoiceSettings.tsx");
    expect(settings).toContain('label="Mute microphone"');
    expect(settings).toContain("assistantMode.setPaused(!voice.paused)");
    expect(settings).toContain("FRIDAY speaks only in Auto mode");
  });
});

describe("FRIDAY stays responsive while a turn is running", () => {
  const work = { task: "summarise the quarterly report", elapsedMs: 12_400 };

  it("answers a status question or a thank-you at once, in the language it was asked in", () => {
    const english = busyReply("are you still working?", work);
    expect(english).toContain("I'm on it");
    expect(english).toContain("summarise the quarterly report");
    expect(english).toContain("12 seconds");
    const hinglish = busyReply("kya kar rahi ho abhi", work);
    expect(hinglish).toMatch(/^Haan, main/);
    expect(hinglish).toContain("12 second");
    expect(busyReply("क्या कर रही हो ho gaya", work)).toMatch(/^Haan, main/);
    expect(busyReply("thanks", work)).toBe("Still on it.");
    expect(busyReply("theek hai", work)).toBe("Haan, kaam chal raha hai.");
  });

  it("leaves a real request to the normal path, so nothing is answered with a guess", () => {
    for (const text of [
      "open the downloads folder",
      "kal ki meeting ka summary banao",
      "write an email to the team",
      "",
    ]) {
      expect(busyReply(text, work)).toBe("");
    }
  });

  it("picks Hinglish for Hindi and Hinglish speech and English otherwise", () => {
    expect(replyLanguage("kya kar rahi ho")).toBe("hi");
    expect(replyLanguage("यह क्या है")).toBe("hi");
    expect(replyLanguage("what are you doing")).toBe("en");
    expect(holdLines("kya haal hai").first).toBe("Ek second, dekh rahi hu.");
    expect(holdLines("open the report").first).toBe("One moment, I'm on it.");
    expect(holdLines("open the report").later).not.toBe(holdLines("open the report").first);
  });

  it("is wired into Auto mode: an instant in-place reply, a hold line, and no stop for a remark", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain("whileBusy(");
    expect(assistant).toContain('this.remember("busy-reply"');
    expect(assistant).toContain("this.armHoldLines(command)");
    expect(assistant).toContain("this.clearHoldLines()");
    // A real spoken request still interrupts, and a stop word still stops.
    expect(assistant).toContain("brain.stop()");
    const dispatch = assistant.slice(assistant.indexOf("private dispatch(command: string)"));
    expect(dispatch.indexOf("whileBusy(")).toBeLessThan(dispatch.indexOf("this.dropPlayback()"));
  });
});

import { suggestLargerSpeech } from "../../src/lib/friday/voice-session";

describe("a larger speech size, suggested only on repeated doubt", () => {
  const doubtful = (model: string, lp = -1.1) => ({ model, avgLogprob: lp, text: "heard" });
  it("suggests the next size after three doubtful transcripts on one size", () => {
    const out = suggestLargerSpeech({
      recent: [doubtful("small"), doubtful("small"), doubtful("small")],
    });
    expect(out.suggest).toBe("medium");
    expect(out.reason).toMatch(/last 3 transcripts on small were doubtful/);
  });

  it("stays quiet for too few turns, a mixed run, a confident turn or an empty one", () => {
    expect(
      suggestLargerSpeech({ recent: [doubtful("small"), doubtful("small")] }).suggest,
    ).toBeNull();
    expect(
      suggestLargerSpeech({ recent: [doubtful("small"), doubtful("base"), doubtful("small")] })
        .suggest,
    ).toBeNull();
    expect(
      suggestLargerSpeech({
        recent: [doubtful("small"), doubtful("small", -0.2), doubtful("small")],
      }).suggest,
    ).toBeNull();
    expect(
      suggestLargerSpeech({
        recent: [
          doubtful("small"),
          doubtful("small"),
          { model: "small", avgLogprob: -1, text: " " },
        ],
      }).suggest,
    ).toBeNull();
  });

  it("respects the PC's ceiling, the largest size and the battery", () => {
    const three = (m: string) => [doubtful(m), doubtful(m), doubtful(m)];
    expect(suggestLargerSpeech({ recent: three("medium") }).suggest).toBeNull();
    // the ladder now has the big turbo size between medium and large-v3: one step at a time
    expect(suggestLargerSpeech({ recent: three("medium"), maxSize: "large-v3" }).suggest).toBe(
      "large-v3-turbo",
    );
    expect(
      suggestLargerSpeech({ recent: three("medium"), maxSize: "large-v3-turbo" }).suggest,
    ).toBe("large-v3-turbo");
    expect(
      suggestLargerSpeech({ recent: three("large-v3-turbo"), maxSize: "large-v3" }).suggest,
    ).toBe("large-v3");
    expect(
      suggestLargerSpeech({ recent: three("large-v3-turbo"), maxSize: "large-v3-turbo" }).suggest,
    ).toBeNull();
    expect(
      suggestLargerSpeech({ recent: three("medium"), battery: true, maxSize: "large-v3" }).suggest,
    ).toBeNull();
    expect(suggestLargerSpeech({ recent: three("large-v3"), maxSize: "large-v3" }).reason).toMatch(
      /largest/,
    );
    expect(suggestLargerSpeech({ recent: three("small"), battery: true }).suggest).toBeNull();
    expect(suggestLargerSpeech({ recent: three("tiny") }).suggest).toBe("base");
  });
});
