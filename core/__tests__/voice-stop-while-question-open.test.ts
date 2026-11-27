/**
 * "Stop everything" said while a question is open (a read-back, a confirmation digest, a lapsed confirmation) is the
 * kill switch, never a "no" to that question: the no-words hold stop, roko and band, so the open-question blocks used
 * to take it as a cancel and return before the command lane and the conduct path ever ran. The stop-all phrases are
 * read first, with or without the wake word, in English, Roman Hindi and Devanagari. Driven with injected state and
 * a fake clock: no microphone, speech engine or network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import {
  clearPendingChange,
  pendingChange,
  readSettingsIntent,
  setHandsFreeReader,
} from "../../src/lib/friday/brain/settings-intents";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    pending: { command: string; reason: string; at: number } | null;
  };
  arbiter: SpeechArbiter;
  awakeUntil: number;
  followUpUntil: number;
  addressFacts: unknown;
  pendingHeard: { command: string; at: number } | null;
  handleHeard: (text: string) => void;
  dispatch: (command: string) => void;
  speak: (text: string) => void;
  playSpoken: (text: string, gen: number) => Promise<void>;
  cancelSpeech: () => void;
  stopRecognition: () => void;
  startRecognition: () => void;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

const START = new Date("2026-03-02T10:00:00Z").getTime();
const COMMAND = "delete my downloads folder";
let spoken: string[] = [];
let played: string[] = [];
let dispatched: string[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US", approvalTtlSec: 30 });
  autonomy.reset();
  clearPendingChange();
  setHandsFreeReader(() => true);
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    speaking: false,
    pending: { command: COMMAND, reason: "exec", at: Date.now() },
  });
  d.pendingHeard = null;
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.awakeUntil = START + 600_000;
  d.followUpUntil = START + 600_000;
  d.addressFacts = null;
  spoken = [];
  played = [];
  dispatched = [];
  d.speak = (text: string) => void spoken.push(text);
  d.playSpoken = (text: string) => {
    played.push(text);
    return Promise.resolve();
  };
  d.dispatch = (command: string) => void dispatched.push(command);
  d.cancelSpeech = () => undefined;
  d.stopRecognition = () => undefined;
  d.startRecognition = () => undefined;
  d.emit = () => undefined;
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
  vi.spyOn(brain, "send").mockImplementation((() => ({ accepted: true })) as never);
});

afterEach(() => {
  vi.useRealTimers();
  clearPendingChange();
  setHandsFreeReader(null);
  autonomy.resume();
  autonomy.reset();
  Object.assign(d.state, { pending: null, paused: false });
  d.pendingHeard = null;
  vi.restoreAllMocks();
});

const halted = () => autonomy.getSnapshot().halted;

describe("stop everything while a confirmation waits", () => {
  for (const line of [
    "Friday stop everything",
    "stop everything",
    "stop everything please",
    "sab roko",
    "Friday, sab band karo",
    "सब बंद करो",
    "stop all",
  ]) {
    it(`"${line}" throws the kill switch and drops the confirmation`, () => {
      d.handleHeard(line);
      expect(halted(), line).toBe(true);
      expect(d.state.pending).toBeNull();
      expect(dispatched).toEqual([]);
      expect(spoken).not.toContain("Cancelled.");
    });
  }

  it("a lapsed confirmation does not eat it either", () => {
    d.state.pending = { command: COMMAND, reason: "exec", at: START - 10 * 60_000 };
    d.handleHeard("Friday stop everything");
    expect(halted()).toBe(true);
    expect(d.state.pending).toBeNull();
  });

  it("a read-back waiting for yes does not eat it", () => {
    d.state.pending = null;
    d.pendingHeard = { command: COMMAND, at: Date.now() };
    d.handleHeard("Friday stop everything");
    expect(halted()).toBe(true);
    expect(d.pendingHeard).toBeNull();
  });

  it("a staged settings change is dropped with it", () => {
    d.state.pending = null;
    readSettingsIntent("turn hands-free off");
    expect(pendingChange()).not.toBeNull();
    d.handleHeard("Friday stop everything");
    expect(halted()).toBe(true);
    expect(pendingChange()).toBeNull();
  });

  it("control: a plain no still only cancels the confirmation", () => {
    d.handleHeard("no");
    expect(halted()).toBe(false);
    expect(d.state.pending).toBeNull();
  });

  it("control: 'stop all the music' is not the kill switch", () => {
    d.state.pending = null;
    d.handleHeard("Friday stop all the music");
    expect(halted()).toBe(false);
  });
});
