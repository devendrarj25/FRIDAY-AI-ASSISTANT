/**
 * Stop everything must stop what Auto mode is doing: the microphone, the voice, the queue and anything waiting.
 *
 * Found by reading `assistant-mode.ts`: it never read the kill switch (`autonomy.halted`). The switch stopped the
 * approval queue and the Brain's tools, and one button also called `brain.stop()`, but Auto kept listening, a reply
 * that was being said went on being said, requests queued behind a running turn were sent when it ended, and a
 * transcript that finished a moment after the switch was thrown still started a turn. Only the panic button
 * happened to leave Auto (it calls `setMode("manual")` itself). The controller is driven with injected state:
 * no microphone, no speech engine, no model and no network are used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import { voiceGate } from "../../src/lib/friday/voice-audio";

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    handsFree: boolean;
    speaking: boolean;
    pending: { command: string; reason: string; at: number } | null;
  };
  queuedCommands: string[];
  speechQueue: string[];
  handleHeard: (text: string) => void;
  dispatch: (command: string) => void;
  speak: (text: string) => void;
  setPaused: (paused: boolean) => void;
  cancelSpeech: () => void;
  stopRecognition: () => void;
  startRecognition: () => void;
  emit: () => void;
  drainSpeech: () => Promise<void>;
  awakeUntil: number;
  followUpUntil: number;
};
const d = assistantMode as unknown as Driver;
const realStartRecognition = d.startRecognition;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let cancelled = 0;
let stopped = 0;
let started = 0;
let sent: string[] = [];

beforeEach(() => {
  autonomy.reset();
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    handsFree: false,
    speaking: false,
    pending: null,
  });
  d.queuedCommands = [];
  d.speechQueue = [];
  d.awakeUntil = Date.now() + 8000;
  d.followUpUntil = Date.now() + 8000;
  cancelled = 0;
  stopped = 0;
  started = 0;
  sent = [];
  d.cancelSpeech = () => void (cancelled += 1);
  d.stopRecognition = () => void (stopped += 1);
  d.startRecognition = () => void (started += 1);
  d.emit = () => undefined;
  vi.spyOn(brain, "send").mockImplementation(((text: string) => {
    sent.push(text);
    return { accepted: true };
  }) as never);
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
});

afterEach(() => {
  autonomy.resume();
  autonomy.reset();
  vi.restoreAllMocks();
});

describe("throwing the kill switch while Auto is running", () => {
  it("stops listening and speaking, and clears what was waiting", () => {
    d.state.speaking = true;
    d.queuedCommands = ["open the calendar"];
    d.state.pending = { command: "delete my downloads", reason: "exec", at: Date.now() };

    autonomy.stopEverything();

    expect(d.state.paused).toBe(true);
    expect(stopped).toBeGreaterThan(0);
    expect(cancelled).toBeGreaterThan(0);
    expect(d.queuedCommands).toEqual([]);
    expect(d.state.pending).toBeNull();
    expect(String(d.state["status"])).toMatch(/stop/i);
  });

  it("does not turn on hands-free, change the mode or touch the output mute", () => {
    autonomy.stopEverything();
    expect(d.state.handsFree).toBe(false);
    expect(d.state.mode).toBe("auto");
    expect(d.state.muted).toBe(false);
  });

  it("does nothing to the microphone when Auto is not the mode (Manual and Chat never owned it)", () => {
    d.state.mode = "manual";
    autonomy.stopEverything();
    expect(stopped).toBe(0);
    expect(started).toBe(0);
    expect(d.state.paused).toBe(false);
  });

  it("a transcript that finishes after the switch was thrown does not start a turn", () => {
    autonomy.stopEverything();
    d.dispatch("what is the weather");
    expect(sent).toEqual([]);
  });

  it("a reply is not spoken while the switch is on", () => {
    autonomy.stopEverything();
    d.speak("Here is your answer.");
    expect(d.speechQueue).toEqual([]);
  });

  it("the owner cannot reopen the microphone while the switch is on", () => {
    autonomy.stopEverything();
    d.setPaused(false);
    expect(d.state.paused).toBe(true);
    expect(started).toBe(0);
  });
});

describe("resuming", () => {
  it("reopens the microphone only if the kill switch is what closed it", () => {
    autonomy.stopEverything();
    expect(d.state.paused).toBe(true);
    autonomy.resume();
    expect(d.state.paused).toBe(false);
    expect(started).toBeGreaterThan(0);
  });

  it("leaves it closed when the owner had paused it already", () => {
    d.state.paused = true;
    autonomy.stopEverything();
    autonomy.resume();
    expect(d.state.paused).toBe(true);
    expect(started).toBe(0);
  });

  it("starts turns and speech again", () => {
    autonomy.stopEverything();
    autonomy.resume();
    d.dispatch("what is the weather");
    expect(sent).toEqual(["what is the weather"]);
  });

  it("a second throw, after a resume, closes it again", () => {
    autonomy.stopEverything();
    autonomy.resume();
    autonomy.stopEverything();
    expect(d.state.paused).toBe(true);
  });
});

describe("the switch was already on when Auto starts (it persists across a restart)", () => {
  it("entering Auto through setMode does not open the microphone, and Resume opens it", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g["addEventListener"] ??= () => undefined;
    g["removeEventListener"] ??= () => undefined;
    const acquire = vi.spyOn(voiceGate, "acquire").mockResolvedValue(false);
    d.state.mode = "manual";
    d.state.paused = false;
    // The real startRecognition runs here, not the stub from beforeEach.
    d.startRecognition = realStartRecognition;
    d.stopRecognition = () => void (stopped += 1);
    autonomy.stopEverything();

    assistantMode.setMode("auto");

    expect(d.state.mode).toBe("auto");
    expect(d.state.paused).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
    expect(String(d.state["status"])).toMatch(/stop everything/i);

    // Resume reopens it: the switch, not the owner, had closed it.
    d.startRecognition = () => void (started += 1);
    autonomy.resume();
    expect(d.state.paused).toBe(false);
    expect(started).toBeGreaterThan(0);
    assistantMode.setMode("manual");
  });

  it("the same holds for the owner's own pause: Auto entered while paused keeps the microphone closed until Resume", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g["addEventListener"] ??= () => undefined;
    g["removeEventListener"] ??= () => undefined;
    const acquire = vi.spyOn(voiceGate, "acquire").mockResolvedValue(false);
    d.state.mode = "manual";
    d.state.paused = true;
    d.startRecognition = realStartRecognition;
    d.stopRecognition = () => void (stopped += 1);

    assistantMode.setMode("auto");
    expect(acquire).not.toHaveBeenCalled();
    expect(d.state.paused).toBe(true);

    d.startRecognition = () => void (started += 1);
    d.setPaused(false);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(d.state.paused).toBe(false);
    assistantMode.setMode("manual");
  });

  it("an ordinary Auto start, with nothing stopped and nothing paused, still opens the microphone at once", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g["addEventListener"] ??= () => undefined;
    g["removeEventListener"] ??= () => undefined;
    const acquire = vi.spyOn(voiceGate, "acquire").mockResolvedValue(false);
    d.state.mode = "manual";
    d.state.paused = false;
    d.startRecognition = () => void (started += 1);
    assistantMode.setMode("auto");
    expect(acquire).toHaveBeenCalledTimes(1);
    assistantMode.setMode("manual");
  });
});
