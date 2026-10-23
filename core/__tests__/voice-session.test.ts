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
    expect(assistant).toContain("busyReply(command");
    expect(assistant).toContain('this.remember("busy-reply"');
    expect(assistant).toContain("this.armHoldLines(command)");
    expect(assistant).toContain("this.clearHoldLines()");
    // A real spoken request still interrupts, and a stop word still stops.
    expect(assistant).toContain("brain.stop()");
    const dispatch = assistant.slice(assistant.indexOf("private dispatch(command: string)"));
    expect(dispatch.indexOf("busyReply(command")).toBeLessThan(
      dispatch.indexOf("this.dropPlayback()"),
    );
  });
});
