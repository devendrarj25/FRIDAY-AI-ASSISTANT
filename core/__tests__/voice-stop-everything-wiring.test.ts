/**
 * "Stop everything" said aloud (the conduct words and the command lane's stop-all) throws the same kill switch as
 * the Stop everything button, and FRIDAY says what was really stopped. The kill switch silences the speech queue,
 * so that one line is played directly. Plain "stop" only quietens her. Driven with injected state: no microphone,
 * speech engine or network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { preferences } from "../../src/lib/friday/preferences";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { brain } from "../../src/lib/friday/brain-engine";
import { taskGraph } from "../../src/lib/friday/self/task-graph";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";

type Driver = {
  state: Record<string, unknown> & { mode: string; paused: boolean; muted: boolean };
  arbiter: SpeechArbiter;
  routeCommand: (command: string, confirm?: boolean) => void;
  runLaneCommand: (hit: { command: string; args?: Record<string, string> }) => boolean;
  playSpoken: (text: string, gen: number) => Promise<void>;
  cancelSpeech: () => void;
  stopRecognition: () => void;
  startRecognition: () => void;
  emit: () => void;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

let played: string[] = [];
let unregister: () => void = () => undefined;
let graphCount = 0;

beforeEach(async () => {
  await preferences.hydrate();
  preferences.setVoice({ hinglish: false, speechLang: "en-US", speakReplies: true });
  autonomy.reset();
  Object.assign(d.state, { mode: "auto", paused: false, muted: false });
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  played = [];
  graphCount = 3;
  unregister = autonomy.registerStopParticipant("graphs", () => graphCount);
  d.playSpoken = (text: string) => {
    played.push(text);
    return Promise.resolve();
  };
  d.cancelSpeech = () => undefined;
  d.stopRecognition = () => undefined;
  d.startRecognition = () => undefined;
  d.emit = () => undefined;
  vi.spyOn(brain, "stop").mockImplementation(() => undefined);
});

afterEach(() => {
  unregister();
  autonomy.resume();
  autonomy.reset();
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("spoken stop everything", () => {
  it("the conduct words throw the real kill switch and say what stopped", async () => {
    d.routeCommand("stop everything");
    await settle();
    expect(autonomy.getSnapshot().halted).toBe(true);
    expect(played.join(" ")).toMatch(/paused 3 background tasks/);
    expect(played.join(" ")).not.toMatch(/I will not continue that work/);
  });

  it("with nothing running the line says so", async () => {
    graphCount = 0;
    d.routeCommand("stop everything");
    await settle();
    expect(autonomy.getSnapshot().halted).toBe(true);
    expect(played.join(" ")).toMatch(/Nothing else was running/);
  });

  it("the command lane's stop-all throws it too", async () => {
    expect(d.runLaneCommand({ command: "stop-all" })).toBe(true);
    await settle();
    expect(autonomy.getSnapshot().halted).toBe(true);
    expect(played.join(" ")).toMatch(/paused 3 background tasks/);
  });

  it("the command lane's plain stop only quietens her", async () => {
    expect(d.runLaneCommand({ command: "stop" })).toBe(true);
    await settle();
    expect(autonomy.getSnapshot().halted).toBe(false);
    expect(played).toEqual([]);
  });

  it("a mute keeps the stop line off the speaker", async () => {
    d.state.muted = true;
    d.routeCommand("stop everything");
    await settle();
    expect(autonomy.getSnapshot().halted).toBe(true);
    expect(played).toEqual([]);
  });
});

describe("the kill switch pauses the task graph however it was thrown", () => {
  it("halting through the settings alone (no fan-out) still pauses running graphs", () => {
    const halt = vi.spyOn(taskGraph, "haltAll");
    autonomy.update({ halted: true });
    expect(halt).toHaveBeenCalled();
  });
});
