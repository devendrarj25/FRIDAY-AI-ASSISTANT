/**
 * A spoken "yes" that finishes an approval must not come from a clearly different voice.
 *
 * Found by reading `assistantMode.handleHeard`: the saved-voice check ran on the COMMAND ("delete my downloads"),
 * but the "yes" that approves it never went through it. With "Recognise my voice" on (the default) a guest, a
 * second person or a television saying "yes" inside the confirmation window ran the owner's consequential command.
 * The owner's own saved voice never approves anything (a match is not an approval), a voice that cannot be told
 * apart (too little speech, no saved voice, the setting off) behaves exactly as before, and a "no" from anyone
 * still cancels. The controller is driven with injected utterances and scores: no microphone, no model, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as voiceProfileModule from "../../src/lib/friday/voice-profile";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { brain } from "../../src/lib/friday/brain-engine";
import { APP_RESTART_TOOL } from "../../src/lib/friday/app-control";
import type { VoiceMatchResult } from "../../src/lib/friday/desktop";

type Driver = {
  state: Record<string, unknown> & {
    pending: { command: string; reason: string; at: number } | null;
  };
  handleHeard: (text: string) => void;
  dispatch: (command: string) => void;
  speak: (text: string) => void;
  caption: (who: string, text: string) => void;
  emit: () => void;
  cancelSpeech: () => void;
  voiceSettings: () => unknown;
  turnVoice: VoiceMatchResult | null;
  turnUnverified: boolean;
  lastApprovalMismatchAt: number;
  spokenText: string;
  echoUntil: number;
  awakeUntil: number;
  followUpUntil: number;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const voice = (similarity: number | null, enrolled = true): VoiceMatchResult => ({
  ok: true,
  enrolled,
  speaker: {
    enrolled,
    similarity,
    match: similarity != null && similarity >= 0.75,
    reason:
      similarity == null
        ? "too-little-speech"
        : similarity >= 0.75
          ? "speaker-match"
          : "speaker-mismatch",
  },
  wake: null,
});

const settings = (over: Record<string, unknown> = {}) => ({
  recogniseMyVoice: true,
  ownerVoiceOnly: false,
  personalWake: true,
  threshold: 0.75,
  ...over,
});

const COMMAND = "delete my downloads folder";
let dispatched: string[] = [];
let spoken: string[] = [];

beforeEach(() => {
  dispatched = [];
  spoken = [];
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    speaking: false,
    handsFree: false,
    pending: { command: COMMAND, reason: "exec", at: Date.now() },
  });
  d.turnVoice = null;
  d.turnUnverified = false;
  d.lastApprovalMismatchAt = 0;
  d.spokenText = "";
  d.echoUntil = 0;
  d.awakeUntil = Date.now() + 8000;
  d.followUpUntil = Date.now() + 8000;
  d.voiceSettings = () => settings();
  d.dispatch = (command: string) => void dispatched.push(command);
  d.speak = (text: string) => void spoken.push(text);
  d.caption = () => undefined;
  d.emit = () => undefined;
  d.cancelSpeech = () => undefined;
});

describe("a spoken yes for a waiting command", () => {
  it("is not accepted from a clearly different voice, and the command waits", () => {
    d.turnVoice = voice(0.2);
    d.handleHeard("yes");
    expect(dispatched).toEqual([]);
    expect(d.state.pending?.command).toBe(COMMAND);
    expect(spoken).toEqual(["That did not match the saved voice. Confirm it on the desktop."]);
  });

  it("is accepted from the owner's own voice (the control: the fix does not stop a real yes)", () => {
    d.turnVoice = voice(0.92);
    d.handleHeard("yes");
    expect(dispatched).toEqual([COMMAND]);
    expect(d.state.pending).toBeNull();
  });

  it("the owner can still approve after a different voice was refused, inside the window", () => {
    d.turnVoice = voice(0.2);
    d.handleHeard("haan kar do");
    expect(dispatched).toEqual([]);
    d.turnVoice = voice(0.9);
    d.handleHeard("haan kar do");
    expect(dispatched).toEqual([COMMAND]);
  });

  it("is accepted when the voice cannot be told apart: too little speech to score", () => {
    d.turnVoice = voice(null);
    d.handleHeard("yes");
    expect(dispatched).toEqual([COMMAND]);
  });

  it("is accepted when no voice is saved (behaviour is unchanged for everyone without a profile)", () => {
    d.turnVoice = voice(null, false);
    d.handleHeard("yes");
    expect(dispatched).toEqual([COMMAND]);
    expect(d.state.pending).toBeNull();
  });

  it("is accepted when the owner turned Recognise my voice off", () => {
    d.voiceSettings = () => settings({ recogniseMyVoice: false });
    d.turnVoice = voice(0.1);
    d.handleHeard("yes");
    expect(dispatched).toEqual([COMMAND]);
  });

  it("honours the owner's own threshold, not a fixed number", () => {
    d.voiceSettings = () => settings({ threshold: 0.5 });
    d.turnVoice = voice(0.6);
    d.handleHeard("yes");
    expect(dispatched).toEqual([COMMAND]);
  });

  it("a no from any voice still cancels: refusing is always safe", () => {
    d.turnVoice = voice(0.1);
    d.handleHeard("no");
    expect(dispatched).toEqual([]);
    expect(d.state.pending).toBeNull();
  });

  it("says the refusal once in a short while, not on every repeated yes", () => {
    d.turnVoice = voice(0.2);
    d.handleHeard("yes");
    d.handleHeard("yes");
    d.handleHeard("yes");
    expect(spoken.filter((line) => /did not match the saved voice/.test(line))).toHaveLength(1);
    expect(dispatched).toEqual([]);
  });

  it("a strong match is still not an approval: with nothing waiting, the old command never runs", () => {
    d.state.pending = null;
    d.turnVoice = voice(0.99);
    d.handleHeard("yes");
    expect(dispatched).not.toContain(COMMAND);
  });
});

describe("a turn made by a recogniser that gives no audio to score (Sarvam final text)", () => {
  beforeEach(() => {
    vi.spyOn(voiceProfileModule, "voiceProfileBuilt").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("is not accepted as the owner's yes for a waiting command when a voice is saved", () => {
    d.turnVoice = null;
    d.turnUnverified = true;
    d.handleHeard("yes");
    expect(dispatched).toEqual([]);
    expect(d.state.pending?.command).toBe(COMMAND);
    expect(spoken).toEqual([
      "I could not check your voice on this recogniser. Confirm it on the desktop.",
    ]);
  });

  it("leaves ordinary, non-sensitive talk alone", () => {
    d.state.pending = null;
    d.turnVoice = null;
    d.turnUnverified = true;
    d.handleHeard("Friday what time is it");
    expect(dispatched).toEqual(["what time is it"]);
  });

  it("is accepted when the owner turned Recognise my voice off", () => {
    d.voiceSettings = () => settings({ recogniseMyVoice: false });
    d.turnVoice = null;
    d.turnUnverified = true;
    d.handleHeard("yes");
    expect(dispatched).toEqual([COMMAND]);
  });

  it("is accepted when no voice is saved: nothing was promised", () => {
    d.turnVoice = null;
    d.turnUnverified = false;
    d.handleHeard("yes");
    expect(dispatched).toEqual([COMMAND]);
  });
});

describe("a spoken yes for a waiting app restart or shutdown", () => {
  const approve = vi.fn();
  beforeEach(() => {
    approve.mockReset();
    d.state.pending = null;
    (brain as unknown as { approve: unknown }).approve = approve;
    (brain.state as { approval: unknown }).approval = {
      tool: APP_RESTART_TOOL,
      at: Date.now(),
    };
  });

  it("is not accepted from a clearly different voice", () => {
    d.turnVoice = voice(0.2);
    d.handleHeard("yes");
    expect(approve).not.toHaveBeenCalled();
  });

  it("is accepted from the owner", () => {
    d.turnVoice = voice(0.9);
    d.handleHeard("yes");
    expect(approve).toHaveBeenCalledWith(true);
  });

  it("a no from a different voice still denies", () => {
    d.turnVoice = voice(0.2);
    d.handleHeard("no");
    expect(approve).toHaveBeenCalledWith(false);
  });
});
