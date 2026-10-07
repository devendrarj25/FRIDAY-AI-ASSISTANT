/**
 * Voice / Auto Mode upgrade contracts — existing engines, not a second stack.
 * Hardware (physical mic, live whisper, live edge-tts) is not claimed here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { nextVoiceState } from "../../src/lib/friday/voice-state";
import { sttInitialPrompt, whisperLanguageArg } from "../../src/lib/friday/voice-stt";
import { shouldAttachTasksExtra } from "../../src/lib/friday/brain/tasks-observe";
import { commandNeedsApproval } from "../../src/lib/friday/brain/action-risk";
import { isContinuingCurrentGoal } from "../../src/lib/friday/brain/conversation-state";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Hinglish STT language handling", () => {
  it("does not lock Whisper to hi or en for regional prefs", () => {
    expect(whisperLanguageArg("hi-IN")).toBe("");
    expect(whisperLanguageArg("en-IN")).toBe("");
    expect(whisperLanguageArg("en")).toBe("");
    expect(whisperLanguageArg("hi")).toBe("");
    expect(whisperLanguageArg("fr-FR")).toBe("fr");
  });

  it("asks Whisper to keep mixed speech and technical terms", () => {
    const prompt = sttInitialPrompt({
      preference: "hi-IN",
      topic: "working on login bug",
    });
    expect(prompt).toMatch(/Hinglish/i);
    expect(prompt).toMatch(/filenames/);
    expect(prompt).toMatch(/login bug/);
  });

  it("passes initial_prompt and does not slice hi-IN down to a forced hi", () => {
    const stt = source("electron/stt.cjs");
    expect(stt).toContain("whisperLanguage");
    expect(stt).toContain("initial_prompt");
    expect(stt).not.toContain('String(req.language).slice(0, 5).split("-")[0]');
    expect(source("kernel/stt.py")).toContain("condition_on_previous_text");
    expect(source("kernel/stt.py")).toContain("--initial-prompt");
  });
});

describe("wake, barge-in, echo, and Auto Mode loop", () => {
  it("scores wake once during capture, then reuses a match at send", () => {
    const dictation = source("src/lib/friday/voice-stt.ts");
    expect(dictation).toContain("maybeEarlyWake");
    expect(dictation).toContain("onEarlyWake");
    expect(dictation).toContain("reused early");
    expect(dictation).toMatch(/private enqueue\(blob: Blob/);
    expect(dictation).toContain("queued — still transcribing the previous utterance");
    expect(source("src/lib/friday/assistant-mode.ts")).toContain("onEarlyWake:");
  });

  it("raises VAD while speaking instead of muting the gate", () => {
    const audio = source("src/lib/friday/voice-audio.ts");
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(audio).toContain("setSpeakingGuard");
    expect(audio).toContain("input.speakingGuard ? 8 : 3");
    expect(audio).toContain("advanceVad");
    expect(assistant).toContain("voiceGate.setSpeakingGuard(true)");
    expect(assistant).toContain("voiceGate.setSpeakingGuard(false)");
    expect(assistant).not.toMatch(/pauseForSpeech\(\) \{\s*voiceGate\.duck\(true\)/);
    expect(assistant).toContain("recentlySpeaking()");
    expect(assistant).toContain("brain.stop()");
    expect(assistant).toContain("commandNeedsApproval(command, this.state.mode)");
  });

  it("returns SPEAKING → barge-in → listening without a second machine", () => {
    expect(nextVoiceState("SPEAKING", "barge-in")).toBe("INTERRUPTED");
    expect(nextVoiceState("INTERRUPTED", "vad-speech")).toBe("SPEECH_DETECTED");
    expect(nextVoiceState("THINKING", "error")).toBe("ERROR");
    expect(nextVoiceState("ERROR", "mic-opened")).toBe("LISTENING");
    expect(nextVoiceState("SPEAKING", "tts-failed")).toBe("LISTENING");
  });

  it("clears the speaking guard when Auto Mode stops", () => {
    expect(source("src/lib/friday/assistant-mode.ts")).toContain(
      "voiceGate.setSpeakingGuard(false)",
    );
    expect(source("src/lib/friday/voice-audio.ts")).toContain("this.speakingGuard = false");
  });

  it("captions typed user lines and resets Auto captions when chat is cleared", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain('if (message.role === "user") this.caption("user", message.text)');
    expect(assistant).toContain("adoptTranscript()");
    expect(assistant).toContain("this.spokenUpTo = brain.getSnapshot().messages.length");
  });
});

describe("voice shares conversation, tasks, and approval with chat", () => {
  it("attaches the existing session digest on the voice dispatch path", () => {
    const assistant = source("src/lib/friday/assistant-mode.ts");
    const awareness = source("src/lib/friday/turn-awareness.ts");
    expect(assistant).toContain('turnAwarenessExtra(command, { kind: "voice" })');
    expect(assistant).toContain("brain.send(command, payload)");
    expect(awareness).toContain("VOICE SESSION");
    expect(awareness).toContain("shouldAttachTasksExtra(prompt)");
  });

  it("treats Hinglish follow-ups as the same goal and live tasks look", () => {
    expect(isContinuingCurrentGoal("Ab next kya?")).toBe(true);
    expect(isContinuingCurrentGoal("isko test karo")).toBe(true);
    expect(shouldAttachTasksExtra("Ab next kya?")).toBe(true);
    expect(shouldAttachTasksExtra("run npm test in the sandbox")).toBe(false);
  });

  it("keeps the shared approval policy on voice commands", () => {
    expect(commandNeedsApproval("delete the folder", "auto")).toBe(true);
    expect(commandNeedsApproval("what time is it", "auto")).toBe(false);
  });
});
