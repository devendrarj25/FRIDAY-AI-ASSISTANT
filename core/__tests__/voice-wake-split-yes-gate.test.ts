/**
 * A yes said after the wake word ("hey Friday yes", or a custom wake word) is still a spoken yes to a staged settings
 * change: the staged-settings gate runs on the command left after the wake split, so a change that opens the
 * microphone without the wake word or spends money still waits for a yes on the screen. Behind it, the settings
 * reader refuses a voice-origin yes for such a change too. Fake clock; no microphone, speech engine or network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import {
  clearPendingChange,
  noteSpokenLine,
  pendingChange,
  readSettingsIntent,
  setHandsFreeReader,
} from "../../src/lib/friday/brain/settings-intents";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & { mode: string; paused: boolean; handsFree: boolean };
  arbiter: SpeechArbiter;
  awakeUntil: number;
  followUpUntil: number;
  addressFacts: unknown;
  pendingHeard: unknown;
  handleHeard: (text: string) => void;
  speak: (text: string, meta?: Record<string, unknown>) => void;
  cancelSpeech: () => void;
  stopRecognition: () => void;
  startRecognition: () => void;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const START = new Date("2026-03-02T10:00:00Z").getTime();
let spoken: string[] = [];
let sent: string[] = [];
let handsFreeNow = false;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US", approvalTtlSec: 30 });
  autonomy.reset();
  clearPendingChange();
  handsFreeNow = false;
  setHandsFreeReader(() => handsFreeNow);
  Object.assign(d.state, { mode: "auto", paused: false, muted: false, pending: null });
  d.pendingHeard = null;
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.awakeUntil = START + 600_000;
  d.followUpUntil = START + 600_000;
  d.addressFacts = null;
  spoken = [];
  sent = [];
  d.speak = (text: string) => void spoken.push(text);
  d.cancelSpeech = () => undefined;
  d.stopRecognition = () => undefined;
  d.startRecognition = () => undefined;
  d.emit = () => undefined;
  // The Brain's settings reader is the real one: a yes that reaches it applies the staged change.
  vi.spyOn(brain, "send").mockImplementation(((text: string) => {
    sent.push(text);
    readSettingsIntent(text);
    return { accepted: true };
  }) as never);
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  clearPendingChange();
  setHandsFreeReader(null);
  autonomy.reset();
  preferences.setVoice({ wakeWord: "friday" });
  vi.restoreAllMocks();
});

describe("a yes after the wake word to a staged change that needs the screen", () => {
  it("'hey Friday yes' leaves hands-free off and the change waiting", () => {
    const setHandsFree = vi
      .spyOn(assistantMode, "setHandsFree")
      .mockImplementation(() => undefined);
    readSettingsIntent("turn hands-free on");
    expect(pendingChange()?.to).toBe("on");
    d.handleHeard("hey Friday yes");
    expect(setHandsFree).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(pendingChange()?.to).toBe("on");
    expect(spoken.join(" ")).toMatch(/tap on screen/);
  });

  it("a custom wake word ('Jarvis yes') is gated the same way", () => {
    preferences.setVoice({ wakeWord: "jarvis" });
    const setHandsFree = vi
      .spyOn(assistantMode, "setHandsFree")
      .mockImplementation(() => undefined);
    readSettingsIntent("turn hands-free on");
    d.handleHeard("Jarvis yes");
    expect(setHandsFree).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("a paid usage policy is not applied by 'Friday yes'", () => {
    readSettingsIntent("allow paid models");
    const staged = pendingChange();
    expect(staged).not.toBeNull();
    d.handleHeard("Friday yes");
    expect(sent).toEqual([]);
    expect(pendingChange()).toEqual(staged);
  });

  it("control: 'Friday yes' to hands-free OFF still goes on to the Brain", () => {
    handsFreeNow = true;
    const setHandsFree = vi
      .spyOn(assistantMode, "setHandsFree")
      .mockImplementation(() => undefined);
    readSettingsIntent("turn hands-free off");
    d.handleHeard("Friday yes");
    expect(sent).toEqual(["yes"]);
    expect(pendingChange()).toBeNull();
    return vi.waitFor(() => expect(setHandsFree).toHaveBeenCalledWith(false));
  });
});

describe("the settings reader behind the voice gate", () => {
  it("refuses a voice-origin yes for hands-free on and keeps the change for a typed yes", () => {
    readSettingsIntent("turn hands-free on");
    noteSpokenLine("yes");
    const out = readSettingsIntent("yes");
    expect(out?.kind).toBe("refused");
    expect(out?.message).toMatch(/screen/i);
    expect(pendingChange()?.to).toBe("on");
    // A typed yes (no spoken line behind it) applies it.
    expect(readSettingsIntent("yes")?.kind).toBe("applied");
  });

  it("refuses a voice-origin yes for a paid policy", () => {
    readSettingsIntent("allow paid models");
    noteSpokenLine("haan");
    expect(readSettingsIntent("haan")?.kind).toBe("refused");
    expect(pendingChange()).not.toBeNull();
  });

  it("a voice yes to a change that needs no screen still applies", () => {
    handsFreeNow = true;
    readSettingsIntent("turn hands-free off");
    noteSpokenLine("yes");
    expect(readSettingsIntent("yes")?.kind).toBe("applied");
  });
});

describe("the voice note is matched loosely and spent once", () => {
  it("a voice 'Yes.' is the same line as 'yes!' at the reader", () => {
    readSettingsIntent("turn hands-free on");
    noteSpokenLine("Yes.");
    expect(readSettingsIntent("yes!")?.kind).toBe("refused");
  });

  it("a note from an older voice line does not refuse a later typed yes", () => {
    noteSpokenLine("yes");
    readSettingsIntent("turn hands-free on");
    expect(readSettingsIntent("yes")?.kind).toBe("applied");
  });
});
