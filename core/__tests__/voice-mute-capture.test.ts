/**
 * Mute stops the microphone (AGENTS.md: "Mute stops the mic"), and unmute brings it back.
 *
 * Until now Mute only silenced FRIDAY's own voice: the microphone kept listening and a late transcript could still
 * run a command. The owner decided Mute means the mic is closed. `setMuted` is the one writer: it closes
 * recognition and releases the Auto microphone the same way the tray pause does, and unmute reopens it through the
 * same deferred-open path Resume uses. The tray pause and Stop everything keep their meaning: unmuting never opens
 * the microphone under either of them, and resuming under Mute never opens it either. The controller is driven with
 * injected state; no microphone, speech engine or network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    micReady: boolean;
    handsFree: boolean;
    speaking: boolean;
    listening: boolean;
  };
  arbiter: SpeechArbiter;
  wantRunning: boolean;
  recognitionPending: boolean;
  autoMicDeferred: boolean;
  callHold: boolean;
  awakeUntil: number;
  followUpUntil: number;
  handleHeard: (text: string) => void;
  setMuted: (muted: boolean) => void;
  toggleMuted: () => void;
  setPaused: (paused: boolean) => void;
  cancelSpeech: () => void;
  stopRecognition: () => void;
  startRecognition: () => void;
  openAutoMic: () => void;
  reopenInput: (reason: "hotplug" | "resume") => Promise<void>;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
const realStart = d.startRecognition;
const realStop = d.stopRecognition;
const realOpen = d.openAutoMic;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let stops = 0;
let starts = 0;
let opens = 0;

beforeEach(() => {
  autonomy.reset();
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    micReady: true,
    handsFree: true,
    speaking: false,
    listening: true,
  });
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.wantRunning = true;
  d.recognitionPending = false;
  d.autoMicDeferred = false;
  d.callHold = false;
  stops = 0;
  starts = 0;
  opens = 0;
  d.cancelSpeech = () => undefined;
  d.stopRecognition = () => void (stops += 1);
  d.startRecognition = () => void (starts += 1);
  d.openAutoMic = () => void (opens += 1);
  d.emit = () => undefined;
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
});

afterEach(() => {
  autonomy.resume();
  autonomy.reset();
  d.stopRecognition = realStop;
  d.startRecognition = realStart;
  d.openAutoMic = realOpen;
  vi.restoreAllMocks();
});

describe("Mute closes the microphone in Auto", () => {
  it("stops recognition, releases the Auto microphone and marks it not ready", () => {
    const release = vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
    d.setMuted(true);
    expect(d.state.muted).toBe(true);
    expect(stops).toBe(1);
    expect(release).toHaveBeenCalledWith("auto-mode");
    expect(d.state.micReady).toBe(false);
    expect(d.autoMicDeferred).toBe(true);
    expect(String(d.state["status"])).toMatch(/muted/i);
  });

  it("the second mute call changes nothing (no second release)", () => {
    const release = vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
    d.setMuted(true);
    d.setMuted(true);
    expect(stops).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("Manual and Chat never owned the microphone, so muting there releases nothing", () => {
    const release = vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
    d.state.mode = "manual";
    d.setMuted(true);
    expect(d.state.muted).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(stops).toBe(0);
  });

  it("the real startRecognition refuses to open while muted, whoever asks (recovery, focus, resume)", () => {
    d.startRecognition = realStart;
    d.state.muted = true;
    d.wantRunning = true;
    d.startRecognition();
    expect(d.wantRunning).toBe(false);
    expect(d.recognitionPending).toBe(false);
  });

  it("a transcript that finishes after Mute is dropped and starts no turn", () => {
    const send = vi.spyOn(brain, "send").mockImplementation((() => ({ accepted: true })) as never);
    d.awakeUntil = Date.now() + 8000;
    d.followUpUntil = Date.now() + 8000;
    d.state.muted = true;
    d.handleHeard("friday open the calendar for tomorrow");
    expect(send).not.toHaveBeenCalled();
  });

  it("a hot-plug or a sleep resume does not reopen the microphone while muted", async () => {
    const restart = vi.spyOn(voiceGate, "restart").mockResolvedValue(true);
    d.state.muted = true;
    await d.reopenInput("hotplug");
    await d.reopenInput("resume");
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("Unmute brings the microphone back, but never under the pause or Stop everything", () => {
  it("reopens the Auto microphone and starts recognition", () => {
    vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
    d.setMuted(true);
    stops = 0;
    d.setMuted(false);
    expect(d.state.muted).toBe(false);
    expect(opens).toBe(1);
    expect(starts).toBe(1);
    expect(d.autoMicDeferred).toBe(false);
  });

  it("toggleMuted is the same two edges", () => {
    vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
    d.toggleMuted();
    expect(d.state.muted).toBe(true);
    d.toggleMuted();
    expect(d.state.muted).toBe(false);
    expect(opens).toBe(1);
  });

  it("while the tray pause is on, unmute leaves the microphone closed", () => {
    vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
    d.setMuted(true);
    d.state.paused = true;
    d.setMuted(false);
    expect(opens).toBe(0);
    expect(starts).toBe(0);
    expect(d.state.paused).toBe(true);
  });

  it("while Stop everything is on, unmute leaves the microphone closed", () => {
    vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
    d.setMuted(true);
    autonomy.stopEverything();
    opens = 0;
    starts = 0;
    d.setMuted(false);
    expect(opens).toBe(0);
    expect(starts).toBe(0);
  });

  it("Resume from the tray while muted does not open the microphone", () => {
    vi.spyOn(voiceGate, "release").mockImplementation(() => undefined);
    d.openAutoMic = realOpen;
    d.startRecognition = realStart;
    const acquire = vi.spyOn(voiceGate, "acquire").mockResolvedValue(false);
    d.setMuted(true);
    d.setPaused(true);
    d.setPaused(false);
    expect(acquire).not.toHaveBeenCalled();
    expect(d.wantRunning).toBe(false);
    expect(d.state.muted).toBe(true);
  });

  it("entering Auto while muted keeps the microphone closed until unmute", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g["addEventListener"] ??= () => undefined;
    g["removeEventListener"] ??= () => undefined;
    d.openAutoMic = realOpen;
    d.startRecognition = realStart;
    const acquire = vi.spyOn(voiceGate, "acquire").mockResolvedValue(false);
    d.state.mode = "manual";
    d.state.muted = true;
    assistantMode.setMode("auto");
    expect(acquire).not.toHaveBeenCalled();
    d.state.muted = false;
    d.openAutoMic();
    expect(acquire).toHaveBeenCalledWith("auto-mode", undefined);
    assistantMode.setMode("manual");
  });
});

describe("the tray pause and Stop everything keep their meaning", () => {
  it("pause still closes recognition and does not touch the output mute", () => {
    d.setPaused(true);
    expect(d.state.paused).toBe(true);
    expect(stops).toBeGreaterThan(0);
    expect(d.state.muted).toBe(false);
  });

  it("the settings Mute microphone row still drives the tray pause, and the strip Mute drives setMuted", () => {
    const settings = readFileSync("src/components/friday/settings/VoiceSettings.tsx", "utf8");
    expect(settings).toContain("assistantMode.setPaused(!voice.paused)");
    const auto = readFileSync("src/components/friday/AutoMode.tsx", "utf8");
    expect(auto.match(/assistantMode\.toggleMuted\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
