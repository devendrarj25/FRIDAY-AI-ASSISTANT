/**
 * Round 7: she notices when her own pipeline is stuck and mends it, knows what she is hearing and speaking
 * with, answers questions about her voice, repairs it when asked, and says once when she is ready.
 * No microphone, speaker or network is used.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";
import {
  baselineRespond,
  isOwnVoiceQuestion,
  isOwnVoiceRepair,
} from "../../src/lib/friday/brain/baseline-responder";
import { resetAntiRepeat } from "../../src/lib/friday/brain/anti-repeat";
import {
  describeVoiceHealth,
  registerVoiceRepair,
  repairVoice,
  type VoiceHealth,
} from "../../src/lib/friday/voice-health";
import {
  STUCK_AFTER_MS,
  superviseVoice,
  type SupervisorInput,
} from "../../src/lib/friday/voice-supervisor";
import type { VoiceState } from "../../src/lib/friday/voice-state";

const base: SupervisorInput = {
  mode: "auto",
  paused: false,
  state: "LISTENING",
  ageMs: 0,
  brainActive: false,
  speechQueued: false,
  speaking: false,
  downloading: false,
};
const at = (state: VoiceState, ageMs: number, extra: Partial<SupervisorInput> = {}) =>
  superviseVoice({ ...base, state, ageMs, ...extra });

describe("the supervisor calls only a really stuck state stuck", () => {
  it("leaves listening and a fresh state alone, however long listening lasts", () => {
    expect(at("LISTENING", 3_600_000)).toEqual({ act: false });
    expect(at("TRANSCRIBING", 5_000)).toEqual({ act: false });
    expect(at("WAITING_CONFIRMATION", 3_600_000)).toEqual({ act: false });
  });

  it("does nothing outside Auto or while paused", () => {
    expect(
      superviseVoice({ ...base, mode: "manual", state: "TRANSCRIBING", ageMs: 999_999 }),
    ).toEqual({ act: false });
    expect(
      superviseVoice({ ...base, paused: true, state: "TRANSCRIBING", ageMs: 999_999 }),
    ).toEqual({ act: false });
  });

  it("restarts the speech engine when transcribing never ends, but not during a first download", () => {
    const stuck = at("TRANSCRIBING", (STUCK_AFTER_MS.TRANSCRIBING ?? 0) + 1);
    expect(stuck).toMatchObject({ act: true, remedy: "restart-speech", fault: "stt-engine-crash" });
    expect(at("TRANSCRIBING", 999_999, { downloading: true })).toEqual({ act: false });
  });

  it("reopens the microphone when it never opened or speech detection never ends", () => {
    expect(at("STARTING", 60_000)).toMatchObject({
      act: true,
      remedy: "reopen-mic",
      fault: "mic-no-device",
    });
    expect(at("SPEECH_DETECTED", 100_000)).toMatchObject({
      act: true,
      remedy: "reopen-mic",
      fault: "mic-no-frames",
    });
  });

  it("lets go of thinking only when no turn is running, and of speaking only when nothing plays", () => {
    expect(at("THINKING", 600_000, { brainActive: true })).toEqual({ act: false });
    expect(at("THINKING", 600_000, { speechQueued: true })).toEqual({ act: false });
    expect(at("THINKING", 40_000)).toMatchObject({ act: true, remedy: "release" });
    expect(at("SPEAKING", 600_000, { speaking: true })).toEqual({ act: false });
    expect(at("SPEAKING", 60_000)).toMatchObject({
      act: true,
      remedy: "release",
      fault: "tts-engine-fail",
    });
  });

  it("runs a full check when it has sat in error", () => {
    expect(at("ERROR", 130_000)).toMatchObject({ act: true, remedy: "self-check" });
  });
});

describe("she knows what she hears and speaks with, and can say it", () => {
  const health: VoiceHealth = {
    mode: "auto",
    listening: true,
    paused: false,
    micReady: true,
    micDetail: "",
    sttReady: true,
    sttModel: "small",
    sttError: "",
    heard: 12,
    dropped: {},
    droppedTotal: 1,
    ttsEngine: "supertonic",
    ttsError: "",
    turnLine: "no turn yet",
    stoppedAt: null,
    wakeEngine: "transcript",
    voiceState: "LISTENING",
    download: "Downloading speech model medium 41%",
    interventions: 2,
    lastIntervention: "TRANSCRIBING: transcribing for 80 s with no answer",
    lastCheck: { at: 1, ok: false, faults: ["tts-engine-fail"] },
  };

  it("reports the model, the wake engine, a download, her stalls and her last check", () => {
    const text = describeVoiceHealth(health);
    expect(text).toContain("Hearing with small; wake transcript; state LISTENING.");
    expect(text).toContain("Fetching now: Downloading speech model medium 41%.");
    expect(text).toContain("pulled myself out of a stuck state 2 times");
    expect(text).toContain("found: tts-engine-fail");
  });

  it("says nothing it does not know", () => {
    const text = describeVoiceHealth({
      ...health,
      download: "",
      interventions: 0,
      lastCheck: null,
    });
    expect(text).not.toContain("Fetching now");
    expect(text).not.toContain("stuck state");
    expect(text).not.toContain("last check");
  });

  it("recognises questions about her ears and voice, and not talk about music", () => {
    for (const q of [
      "can you hear me",
      "tum meri awaaz sun sakti ho",
      "which speech model are you using",
      "kaun sa model use kar rahi ho sunne ke liye",
      "are you listening",
    ])
      expect(isOwnVoiceQuestion(q), q).toBe(true);
    for (const q of [
      "do you listen to music",
      "I like her voice",
      "what model do you use for chat",
      "explain how speech recognition works",
    ])
      expect(isOwnVoiceQuestion(q), q).toBe(false);
  });

  it("recognises a request to mend her voice", () => {
    for (const q of ["fix your voice", "tumhari awaaz theek karo", "reset your microphone"])
      expect(isOwnVoiceRepair(q), q).toBe(true);
    for (const q of [
      "fix your code",
      "can you hear me",
      "voice check karo friday",
      "fix the bug in the voice module source",
    ])
      expect(isOwnVoiceRepair(q), q).toBe(false);
  });

  it("runs the repair when asked by voice and says what it found", async () => {
    expect(await repairVoice()).toMatch(/installed app/);
    const off = registerVoiceRepair(async () => "I checked everything. All of it is working.");
    const answer = baselineRespond("fix your voice");
    expect(answer.handled).toBe(true);
    expect(answer.resolve).toBeTypeOf("function");
    expect(await answer.resolve?.()).toBe("I checked everything. All of it is working.");
    off();
  });
});

type Driver = {
  state: {
    mode: string;
    paused: boolean;
    muted: boolean;
    voiceState: VoiceState;
    listening: boolean;
    speaking: boolean;
    download: unknown;
    stt: { ready: boolean };
  };
  stateSince: number;
  lastSupervisorTick: number;
  supervisedAt: Map<string, number>;
  interventions: number;
  reportedStuck: boolean;
  announcedReady: boolean;
  applyVoiceHeal: (fault: string, manual?: boolean, execute?: boolean) => unknown;
  speak: (text: string) => void;
  emit: () => void;
  superviseTick: () => void;
  announceReady: () => void;
  interventionCount: () => number;
  lastInterventionText: () => string;
  captions?: unknown;
};
const drive = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

describe("the real controller pulls itself out of a stuck state", () => {
  let healed: string[] = [];
  let spoken: string[] = [];
  beforeEach(() => {
    healed = [];
    spoken = [];
    resetAntiRepeat();
    drive.state.mode = "auto";
    drive.state.paused = false;
    drive.state.muted = false;
    drive.state.download = null;
    drive.state.stt.ready = true;
    drive.interventions = 0;
    drive.reportedStuck = false;
    drive.announcedReady = false;
    drive.supervisedAt = new Map();
    drive.lastSupervisorTick = 0;
    drive.applyVoiceHeal = (fault: string) => void healed.push(fault);
    drive.speak = (text: string) => void spoken.push(text);
    drive.emit = () => undefined;
  });
  afterEach(() => {
    drive.state.voiceState = "OFF";
    drive.state.mode = "manual";
  });

  it("restarts the speech engine and listens again after a transcription that never ended", () => {
    drive.state.voiceState = "TRANSCRIBING";
    drive.stateSince = Date.now() - 100_000;
    drive.superviseTick();
    expect(healed).toEqual(["stt-engine-crash"]);
    expect(drive.state.voiceState).toBe("LISTENING");
    expect(drive.state.listening).toBe(true);
    expect(drive.interventionCount()).toBe(1);
    expect(drive.lastInterventionText()).toMatch(/TRANSCRIBING: transcribing for 100 s/);
  });

  it("does not touch a state that is merely long when something is really running", () => {
    drive.state.voiceState = "TRANSCRIBING";
    drive.stateSince = Date.now() - 100_000;
    drive.state.download = {
      stage: "download",
      label: "x",
      percent: 10,
      model: "m",
      detail: "",
      updateAvailable: false,
    };
    drive.superviseTick();
    expect(healed).toEqual([]);
    expect(drive.state.voiceState).toBe("TRANSCRIBING");
  });

  it("does not act twice for the same state within the cooldown", () => {
    drive.state.voiceState = "STARTING";
    drive.stateSince = Date.now() - 100_000;
    drive.superviseTick();
    drive.state.voiceState = "STARTING";
    drive.stateSince = Date.now() - 100_000;
    drive.lastSupervisorTick = 0;
    drive.superviseTick();
    expect(healed).toEqual(["mic-no-device"]);
  });

  it("says once, after a run of stalls, that it keeps getting stuck", () => {
    const states: VoiceState[] = ["STARTING", "TRANSCRIBING", "SPEECH_DETECTED", "STARTING"];
    for (const state of states) {
      drive.state.voiceState = state;
      drive.stateSince = Date.now() - 200_000;
      drive.lastSupervisorTick = 0;
      drive.supervisedAt = new Map();
      drive.superviseTick();
    }
    expect(drive.interventionCount()).toBe(4);
    expect(drive.reportedStuck).toBe(true);
  });

  it("says she is ready once per session, only when the engine is ready and she is not muted", () => {
    drive.state.stt.ready = false;
    drive.announceReady();
    expect(spoken).toEqual([]);
    drive.state.stt.ready = true;
    drive.state.muted = true;
    drive.announceReady();
    expect(spoken).toEqual([]);
    drive.state.muted = false;
    drive.announceReady();
    drive.announceReady();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatch(/listening|Ready|taiyaar|Taiyaar|sun rahi|ready|सुन|तैयार/i);
  });
});
