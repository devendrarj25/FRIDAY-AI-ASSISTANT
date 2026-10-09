/**
 * Auto mode is the only listen/speak surface. Chat does not open a microphone.
 * Hardware is not claimed here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptsVoiceTurn,
  duplicateFinalUtterance,
  endpointSilenceMs,
  microphoneAllowed,
  nextSpokenCursor,
  spokenReplyAllowed,
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
