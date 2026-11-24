/**
 * The instant acknowledgement, wired into the real Auto mode controller (setting `voice.instantAck`, off by default).
 *
 * `voice-engine-ack.test.ts` pins the pure rules. This file drives the conductor: the gates at arm time, the timer, the
 * cancel paths (first clause, barge-in, Stop everything, pause, mute), one line per turn, the narrator budget, the
 * stamps, and the local-only rule. Nothing opens a microphone, a speaker or the network: the clip player and the local
 * renderer are recorders, the Brain is a stub that accepts the turn, and the clock is a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const played: Array<{ id: string }> = [];
const stopped = { clips: 0 };
vi.mock("../../src/lib/friday/voice-prewarm", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/friday/voice-prewarm")>();
  return {
    ...real,
    readyAckClipIds: () => ready.slice(),
    // The clip of a line is its id as samples: the player recorder reads the id back from the sample count.
    ackClipFor: (id: string) => ({
      text: id,
      lang: "en" as const,
      pcm: new Int16Array(ready.indexOf(id) + 1).fill(1),
      rate: 24_000,
    }),
  };
});
vi.mock("../../src/lib/friday/voice-engine/ack-player", () => ({
  playAckSamples: vi.fn(
    async (
      pcm: Int16Array,
      _rate: number,
      options: { onStart?: () => void; stillWanted?: () => boolean } = {},
    ): Promise<boolean> => {
      if (options.stillWanted && !options.stillWanted()) return false;
      played.push({ id: ready[pcm.length - 1] ?? "" });
      options.onStart?.();
      return true;
    },
  ),
  stopAckClip: () => void (stopped.clips += 1),
}));

const rendered: Array<{ text: string; allowCloud: unknown; cloudClip: unknown }> = [];
vi.mock("../../src/lib/friday/voice-library", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/friday/voice-library")>();
  return {
    ...real,
    speakText: vi.fn(
      async (
        text: string,
        tuning: { allowCloud?: boolean; cloudClip?: unknown },
        hooks: { onStart?: () => void } = {},
      ) => {
        rendered.push({ text, allowCloud: tuning.allowCloud, cloudClip: tuning.cloudClip });
        hooks.onStart?.();
        return "neural" as const;
      },
    ),
  };
});

import { assistantMode } from "../../src/lib/friday/assistant-mode";
import { brain } from "../../src/lib/friday/brain-engine";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { preferences, DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import { SpeechArbiter } from "../../src/lib/friday/voice-engine/speech-arbiter";
import { ackPrewarmLines, ackStamps } from "../../src/lib/friday/voice-engine/instant-ack";
import { StageClock, VOICE_STAGES } from "../../src/lib/friday/voice-engine/latency-monitor";
import { NARRATION_MAX_LINES } from "../../src/lib/friday/voice-session";
import { echoLive } from "../../src/lib/friday/voice-engine/echo-live";
import { readFileSync } from "node:fs";
import { playAckSamples } from "../../src/lib/friday/voice-engine/ack-player";

type Driver = {
  state: Record<string, unknown> & {
    mode: string;
    paused: boolean;
    muted: boolean;
    speaking: boolean;
    pending: unknown;
  };
  handleHeard: (text: string) => void;
  dispatch: (command: string) => boolean;
  holdForInterruption: () => void;
  cancelSpeech: () => void;
  isSelfEcho: (text: string) => boolean;
  acceptFinalUtterance: (utterance: { text: string; source: string }) => void;
  ackEcho: { text: string; until: number };
  echoUntil: number;
  setMuted: (muted: boolean) => void;
  setPaused: (paused: boolean) => void;
  followKillSwitch: () => void;
  armAck: (command: string) => void;
  clearHoldLines: () => void;
  playSpoken: (text: string, gen: number) => Promise<void>;
  emit: () => void;
  arbiter: SpeechArbiter;
  narrator: { remaining: () => number; begin: () => void };
  turnStages: StageClock;
  ackTimer: unknown;
  ackQueued: { decision: { named: boolean; line: string } } | null;
  ackSaid: number;
  ackGen: number;
  ackTurnKind: string;
  ackLastLineId: string;
  lastFinalText: string;
  callHold: boolean;
  voicedChars: number;
  approvalAsked: unknown;
  pendingHeard: unknown;
  followUpUntil: number;
  awakeUntil: number;
  interruptHold: unknown;
  speakPlan: (
    text: string,
    localOnly?: boolean,
  ) => { argTuning: { allowCloud?: boolean; cloudClip?: unknown } };
};
const d = assistantMode as unknown as Driver;
const win = globalThis as unknown as { window?: unknown };
win.window ??= globalThis;

const ready: string[] = ackPrewarmLines().map((line) => line.id);
const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const COMMAND = "what is the weather in Delhi";
let spoken: string[] = [];
let ownerSpeaking = false;

const armed = () => d.ackTimer !== null;
const setVoice = (patch: Record<string, unknown>) =>
  preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice, instantAck: true, ...patch } });

/** A turn on its way to the Brain, as the conductor leaves it: routed as a foreground turn, then dispatched. */
function turn(command = COMMAND, kind = "foreground-turn") {
  d.ackTurnKind = kind;
  d.dispatch(command);
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  played.length = 0;
  rendered.length = 0;
  stopped.clips = 0;
  spoken = [];
  ownerSpeaking = false;
  vi.mocked(playAckSamples).mockClear();
  vi.spyOn(voiceGate, "heardSpeechWithin").mockImplementation(() => ownerSpeaking);
  autonomy.reset();
  Object.assign(d.state, {
    mode: "auto",
    paused: false,
    muted: false,
    speaking: false,
    pending: null,
  });
  d.arbiter = new SpeechArbiter({ now: () => Date.now() });
  d.callHold = false;
  d.voicedChars = 0;
  d.approvalAsked = null;
  d.pendingHeard = null;
  d.interruptHold = null;
  d.emit = () => undefined;
  d.turnStages = new StageClock(() => performance.now());
  d.ackSaid = 0;
  d.ackLastLineId = "";
  d.ackTurnKind = "control";
  vi.spyOn(d, "playSpoken").mockImplementation(async (text: string) => void spoken.push(text));
  vi.spyOn(brain, "send").mockImplementation((() => ({
    accepted: true,
    reason: "accepted",
    message: null,
    runId: "run-ack",
  })) as never);
  setVoice({});
});

afterEach(() => {
  d.clearHoldLines();
  autonomy.resume();
  autonomy.reset();
  preferences.setToggle("doNotDisturb", false);
  preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the setting is off: nothing changes", () => {
  it("arms no timer, plays nothing, spends no narrator line and stamps no acknowledgement", async () => {
    preferences.update({ voice: { ...DEFAULT_PREFERENCES.voice } });
    expect(DEFAULT_PREFERENCES.voice.instantAck).toBe(false);
    turn();
    expect(armed()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(played).toEqual([]);
    expect(d.turnStages.at("ackAudible")).toBeNull();
    expect(d.narrator.remaining()).toBe(NARRATION_MAX_LINES);
    // The hold-line stamp the narrator always made is untouched.
    expect(d.turnStages.at("ackArmed")).not.toBeNull();
  });
});

describe("the timer and the sound", () => {
  it("arms at the confirmed endpoint, plays the pre-rendered clip at 600 ms and stamps it audible", async () => {
    turn();
    expect(armed()).toBe(true);
    expect(d.turnStages.at("ackArmed")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(599);
    expect(played).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(played).toHaveLength(1);
    expect(ready).toContain(played[0]?.id);
    expect(d.turnStages.at("ackAudible")).not.toBeNull();
    // It is not the first sound of the answer: that stamp stays for the answer's own first sample.
    expect(d.turnStages.at("playbackFirstSample")).toBeNull();
    expect(d.ackSaid).toBe(1);
    expect(d.narrator.remaining()).toBe(NARRATION_MAX_LINES - 1);
    expect(spoken).toEqual([]);
  });

  it("goes through the speech queue as a direct line, never as the reply itself", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(601);
    expect(d.arbiter.size()).toBe(0);
    expect(spoken).toEqual([]);
    expect(d.state.speaking).toBe(false);
  });

  it("an answer line queued first is not delayed: the acknowledgement is dropped, the answer plays", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(300);
    d.arbiter.enqueue({ text: "It is sunny in Delhi.", priority: "direct" });
    await vi.advanceTimersByTimeAsync(400);
    expect(played).toEqual([]);
  });

  it("the line rotates: the next turn never repeats the last line", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(601);
    const first = played[0]?.id;
    expect(first).toBeTruthy();
    d.clearHoldLines();
    turn("what is the time in Tokyo");
    await vi.advanceTimersByTimeAsync(601);
    expect(played).toHaveLength(2);
    expect(played[1]?.id).not.toBe(first);
  });
});

describe("the gates at arm time (each one on its own)", () => {
  const cases: Array<[string, () => void]> = [
    ["a call is on", () => void (d.callHold = true)],
    ["muted", () => void (d.state.muted = true)],
    ["paused", () => void (d.state.paused = true)],
    ["Stop everything is on", () => autonomy.stopEverything()],
    ["Do not disturb", () => preferences.setToggle("doNotDisturb", true)],
    ["whisper mode", () => setVoice({ whisperMode: true })],
    ["spoken replies are off", () => setVoice({ speakReplies: false })],
    ["not Auto mode", () => void (d.state.mode = "manual")],
    [
      "a confirmation is open",
      () => void (d.state.pending = { command: "x", reason: "x", at: Date.now() }),
    ],
    ["a read-back waits for a yes", () => void (d.pendingHeard = { command: "x", at: Date.now() })],
    ["the owner is speaking", () => void (ownerSpeaking = true)],
    ["no clip is ready", () => void (ready.length = 0)],
  ];
  const saved = [...ready];
  afterEach(() => {
    ready.length = 0;
    ready.push(...saved);
  });
  for (const [name, setup] of cases) {
    it(`says nothing when ${name}`, async () => {
      setup();
      turn();
      expect(armed(), name).toBe(false);
      await vi.advanceTimersByTimeAsync(3000);
      expect(played, name).toEqual([]);
      expect(d.narrator.remaining()).toBe(NARRATION_MAX_LINES);
    });
  }

  it("only a foreground turn or a new task is followed by one (not a control word, a confirmed turn, a status)", async () => {
    for (const kind of ["control", "confirm-turn", "status", "task-control", "approval-answer"]) {
      turn(COMMAND, kind);
      expect(armed(), kind).toBe(false);
    }
    turn(COMMAND, "new-task");
    expect(armed()).toBe(true);
  });

  it("the route kind is read once: the next turn without a route says nothing", () => {
    turn();
    expect(armed()).toBe(true);
    d.clearHoldLines();
    d.dispatch("and tomorrow");
    expect(armed()).toBe(false);
  });
});

describe("cancel paths: nothing plays after any of them", () => {
  it("the first clause of the answer is ready before the timer", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(300);
    d.voicedChars = 12;
    await vi.advanceTimersByTimeAsync(400);
    expect(played).toEqual([]);
  });

  it("the first clause stamp alone (nothing voiced yet) also cancels it", async () => {
    turn();
    d.turnStages.mark("firstClauseReady");
    await vi.advanceTimersByTimeAsync(700);
    expect(played).toEqual([]);
  });

  it("a barge-in cancels the timer and stops a clip that is sounding", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(300);
    const before = stopped.clips;
    d.holdForInterruption();
    expect(armed()).toBe(false);
    expect(stopped.clips).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(700);
    expect(played).toEqual([]);
  });

  it("the owner speaking again before the timer cancels it", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(300);
    ownerSpeaking = true;
    await vi.advanceTimersByTimeAsync(400);
    expect(played).toEqual([]);
  });

  it("Stop everything cancels it", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(300);
    autonomy.stopEverything();
    await vi.advanceTimersByTimeAsync(400);
    expect(played).toEqual([]);
  });

  it("pause and mute before the timer cancel it", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(300);
    d.state.paused = true;
    await vi.advanceTimersByTimeAsync(400);
    expect(played).toEqual([]);
    d.state.paused = false;
    turn();
    await vi.advanceTimersByTimeAsync(300);
    d.state.muted = true;
    await vi.advanceTimersByTimeAsync(400);
    expect(played).toEqual([]);
  });

  it("a newer turn replaces the old timer: only one clip, for the newer turn", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(200);
    const gen = d.ackGen;
    turn("what is the time in Tokyo");
    expect(d.ackGen).toBeGreaterThan(gen);
    await vi.advanceTimersByTimeAsync(1000);
    expect(played).toHaveLength(1);
  });

  it("cancelSpeech (the stop word) clears the timer", async () => {
    turn();
    d.cancelSpeech();
    expect(armed()).toBe(false);
  });
});

describe("one per turn, and the narrator budget", () => {
  it("a second decision in the same turn says nothing", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(601);
    expect(played).toHaveLength(1);
    d.armAck(COMMAND);
    expect(armed()).toBe(false);
  });

  it("the acknowledgement holds back the narrator's first hold line (the 8 s gap)", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(601);
    expect(played).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spoken).toEqual([]);
  });
});

describe("privacy and the cloud: the clip is local, a named line is rendered locally", () => {
  it("privacy mode drops the owner's name and plays the clip made in advance", async () => {
    setVoice({ privacyMode: true, addressName: "Asha" });
    turn();
    await vi.advanceTimersByTimeAsync(601);
    expect(played).toHaveLength(1);
    expect(rendered).toEqual([]);
  });

  it("a name renders locally: never a cloud clip, never allowCloud", async () => {
    setVoice({ addressName: "Asha" });
    turn();
    expect(armed()).toBe(true);
    await vi.advanceTimersByTimeAsync(601);
    expect(played).toEqual([]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.text).toContain("Asha");
    expect(rendered[0]?.allowCloud).toBe(false);
    expect(rendered[0]?.cloudClip).toBeUndefined();
    expect(d.turnStages.at("ackAudible")).not.toBeNull();
  });

  it("a local-only speak plan has no cloud clip and no cloud engine, whatever the cloud settings are", () => {
    const plan = d.speakPlan("One moment.", true);
    expect(plan.argTuning.allowCloud).toBe(false);
    expect(plan.argTuning.cloudClip).toBeUndefined();
  });
});

describe("echo and stamps", () => {
  it("a very short acknowledgement heard back whole is her own voice, whatever line the rotation picked", () => {
    d.ackEcho = { text: "Mm.", until: Date.now() + 2500 };
    expect(d.isSelfEcho("mm")).toBe(true);
    expect(d.isSelfEcho("open the calendar please")).toBe(false);
    d.ackEcho = { text: "", until: 0 };
  });

  it("the line that just sounded is her own voice for the echo filter, for a moment, and is not the reply", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(601);
    const line = ackPrewarmLines().find((entry) => entry.id === played[0]?.id)?.text ?? "";
    expect(line).not.toBe("");
    expect(d.isSelfEcho(line)).toBe(true);
    expect(d.isSelfEcho("open the calendar please")).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(d.isSelfEcho(line)).toBe(false);
  });

  it("both stamps exist in the stage list, and the conductor stamps them with those exact names", () => {
    expect(ackStamps).toEqual({ armed: "ackArmed", audible: "ackAudible" });
    for (const stage of Object.values(ackStamps)) expect(VOICE_STAGES).toContain(stage);
  });
});

describe("D: a late transcript of the acknowledgement's own words is dropped on its own clock", () => {
  beforeEach(() => {
    d.state.speaking = false;
    d.echoUntil = 0; // no reply is playing and the speaking window is long over
  });

  it("is dropped inside 2.5 s of the ack ending, with no reply speaking", async () => {
    turn();
    await vi.advanceTimersByTimeAsync(601);
    const line = ackPrewarmLines().find((entry) => entry.id === played[0]?.id)?.text ?? "";
    d.echoUntil = 0;
    const heard = vi.spyOn(d as unknown as { handleHeard: () => void }, "handleHeard");
    heard.mockImplementation(() => undefined);
    await vi.advanceTimersByTimeAsync(1500); // the recogniser finishes late
    d.acceptFinalUtterance({ text: line, source: "local" });
    expect(heard).not.toHaveBeenCalled();
    // the same words after the window are the owner's
    await vi.advanceTimersByTimeAsync(3000);
    d.lastFinalText = "";
    d.acceptFinalUtterance({ text: line, source: "local" });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("an ordinary sentence is not dropped by the ack rule", () => {
    d.ackEcho = { text: "One moment.", until: Date.now() + 2000 };
    const heard = vi.spyOn(d as unknown as { handleHeard: () => void }, "handleHeard");
    heard.mockImplementation(() => undefined);
    d.acceptFinalUtterance({ text: "Friday open the calendar for tomorrow", source: "local" });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("E: pause, mute and Stop everything forget the echo reference", () => {
  it("clears it with the reason, and the conductor says so in source", () => {
    const clear = vi.spyOn(echoLive, "clear").mockImplementation(() => undefined);
    d.setMuted(true);
    expect(clear).toHaveBeenCalledWith("muted");
    d.setMuted(false);
    clear.mockClear();
    d.state.paused = false;
    d.setPaused(true);
    expect(clear).toHaveBeenCalledWith("paused");
    d.setPaused(false);
    clear.mockClear();
    autonomy.stopEverything();
    expect(clear).toHaveBeenCalledWith("stop");
    autonomy.resume();
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    expect(mode).toContain(
      'import { clearEchoReference, echoDiagnostics } from "./voice-engine/echo-live"',
    );
    for (const reason of ["muted", "paused", "stop"])
      expect(mode).toContain(`clearEchoReference("${reason}")`);
  });
});
