/**
 * The closing pause of a turn: the end-of-turn model is asked early, a confirmed end closes sooner, a slow or
 * missing answer never holds the turn to the cap, and an unfinished sentence keeps its longer wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markWorklet, noteCaptureFrame, resetCaptureRing } from "../../src/lib/friday/pcm-capture";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import {
  CONFIRMED_END_MS,
  TURN_CONFIRM_PROBABILITY,
  TURN_SCORE_ASK_MS,
  endpointSilenceMs,
} from "../../src/lib/friday/voice-session";
import {
  DesktopDictation,
  resetDictationLease,
  turnHoldAfterScore,
  turnHoldPlan,
  type TurnHold,
} from "../../src/lib/friday/voice-stt";

const plan = (over: Partial<Parameters<typeof turnHoldPlan>[0]>) =>
  turnHoldPlan({
    hold: "idle",
    speech: false,
    quietMs: 0,
    silenceMs: 700,
    capMs: 1480,
    canScore: true,
    ...over,
  });

describe("turnHoldAfterScore", () => {
  it("reads the probability: low extends, sure confirms, middling or missing changes nothing", () => {
    expect(turnHoldAfterScore(0.2)).toBe("extend");
    expect(turnHoldAfterScore(0.49)).toBe("extend");
    expect(turnHoldAfterScore(0.5)).toBe("done");
    expect(turnHoldAfterScore(TURN_CONFIRM_PROBABILITY - 0.01)).toBe("done");
    expect(turnHoldAfterScore(TURN_CONFIRM_PROBABILITY)).toBe("confirmed");
    expect(turnHoldAfterScore(0.99)).toBe("confirmed");
    for (const bad of [null, undefined, "0.9", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(turnHoldAfterScore(bad)).toBe("done");
    }
  });
});

describe("turnHoldPlan", () => {
  it("asks the model once, early, and only while quiet", () => {
    expect(plan({ quietMs: TURN_SCORE_ASK_MS - 1 }).ask).toBe(false);
    expect(plan({ quietMs: TURN_SCORE_ASK_MS }).ask).toBe(true);
    expect(plan({ quietMs: 300, hold: "scoring" }).ask).toBe(false);
    expect(plan({ quietMs: 300, hold: "done" }).ask).toBe(false);
    expect(plan({ quietMs: 300, speech: true }).ask).toBe(false);
    expect(plan({ quietMs: 300, canScore: false }).ask).toBe(false);
  });

  it("closes a model-confirmed end at the short pause, not the long one", () => {
    expect(plan({ hold: "confirmed", quietMs: CONFIRMED_END_MS - 1 }).close).toBe(false);
    expect(plan({ hold: "confirmed", quietMs: CONFIRMED_END_MS }).close).toBe(true);
    expect(
      plan({ hold: "confirmed", quietMs: CONFIRMED_END_MS, silenceMs: 420, capMs: 1200 }).close,
    ).toBe(true);
    // Already shorter than the confirmed pause (a realtime open turn): nothing is lengthened.
    expect(plan({ hold: "confirmed", quietMs: 196, silenceMs: 196, capMs: 976 }).close).toBe(true);
  });

  it("keeps the longer wait when the text itself asked for it", () => {
    expect(plan({ hold: "confirmed", quietMs: 400, silenceMs: 1200, capMs: 1200 }).close).toBe(
      false,
    );
    expect(plan({ hold: "confirmed", quietMs: 1200, silenceMs: 1200, capMs: 1200 }).close).toBe(
      true,
    );
  });

  it("waits to the cap on a low score, and never past the plain pause for a score that has not come", () => {
    expect(plan({ hold: "extend", quietMs: 1000 }).close).toBe(false);
    expect(plan({ hold: "extend", quietMs: 1480 }).close).toBe(true);
    expect(plan({ hold: "scoring", quietMs: 699 }).close).toBe(false);
    expect(plan({ hold: "scoring", quietMs: 700 }).close).toBe(true);
    expect(plan({ hold: "idle", quietMs: 700, canScore: false }).close).toBe(true);
  });

  it("never closes on speech, except at the hard cap", () => {
    expect(plan({ speech: true, quietMs: 5000, hold: "confirmed" }).close).toBe(false);
    expect(plan({ speech: true, tooLong: true }).close).toBe(true);
  });

  it("is never slower than the plain pause for any state", () => {
    const holds: TurnHold[] = ["idle", "scoring", "confirmed", "done"];
    for (const hold of holds) {
      for (const silenceMs of [196, 280, 420, 700]) {
        const open = plan({ hold, quietMs: silenceMs, silenceMs, capMs: silenceMs + 780 });
        expect(open.close).toBe(true);
      }
    }
  });

  it("keeps the defaults it relies on", () => {
    expect(endpointSilenceMs(true, "open chrome.")).toBe(420);
    expect(endpointSilenceMs(false, "open chrome.")).toBe(700);
    expect(CONFIRMED_END_MS).toBeLessThan(endpointSilenceMs(true, "open chrome."));
    expect(TURN_SCORE_ASK_MS).toBeLessThanOrEqual(CONFIRMED_END_MS);
  });
});

type Snap = {
  level: number;
  noiseFloor: number;
  speech: boolean;
  sinceSpeech: number | null;
  running: boolean;
  speakingGuard: boolean;
};

describe("the closing pause in a real dictation", () => {
  let listener: ((snap: Snap) => void) | null = null;
  let snapshot: Snap;
  let scoreCalls = 0;
  let answer: () => Promise<{
    ok: boolean;
    ready: boolean;
    probability: number | null;
    reason?: string;
  }>;
  let transcribed = 0;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetDictationLease();
    resetCaptureRing();
    markWorklet(true);
    scoreCalls = 0;
    transcribed = 0;
    answer = async () => ({ ok: true, ready: true, probability: 0.9 });
    snapshot = {
      level: 0.2,
      noiseFloor: 0,
      speech: false,
      sinceSpeech: null,
      running: true,
      speakingGuard: false,
    };
    listener = null;
    const track = { readyState: "live", muted: false, addEventListener() {} };
    const stream = { getAudioTracks: () => [track] };
    vi.stubGlobal("MediaRecorder", undefined);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => stream } });
    vi.stubGlobal("window", {
      friday: {
        sttStatus: async () => ({
          available: true,
          ready: true,
          engine: "faster-whisper",
          inference: "verified",
        }),
        scoreTurn: async () => {
          scoreCalls += 1;
          return answer();
        },
        transcribe: async () => {
          transcribed += 1;
          return { ok: true, text: "ok" };
        },
      },
      setInterval: (fn: TimerHandler, ms?: number) => setInterval(fn, ms),
      clearInterval: (id: number) => clearInterval(id),
      addEventListener() {},
      removeEventListener() {},
    });
    vi.spyOn(voiceGate, "acquire").mockResolvedValue(true);
    vi.spyOn(voiceGate, "micStream").mockReturnValue(stream as unknown as MediaStream);
    vi.spyOn(voiceGate, "release").mockImplementation(() => {});
    vi.spyOn(voiceGate, "lastCaptureFailure").mockReturnValue(null);
    vi.spyOn(voiceGate, "subscribe").mockImplementation((fn) => {
      listener = fn as (snap: Snap) => void;
      return () => {
        listener = null;
      };
    });
    vi.spyOn(voiceGate, "getSnapshot").mockImplementation(() => snapshot);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCaptureRing();
    resetDictationLease();
  });

  /** Speak for a moment, then go quiet; returns the dictation. `quiet(ms)` advances the pause. */
  async function turn(silenceMs: number) {
    const dictation = new DesktopDictation({
      maxUtteranceMs: 20_000,
      silenceMs: () => silenceMs,
      onFinal: () => {},
    });
    expect(await dictation.start()).toBe(true);
    snapshot.speech = true;
    snapshot.sinceSpeech = 0;
    listener?.(snapshot);
    await vi.advanceTimersByTimeAsync(400);
    const samples = new Float32Array(4000);
    samples.fill(0.2);
    noteCaptureFrame(samples, performance.now(), 16000, Date.now());
    await vi.advanceTimersByTimeAsync(100);
    snapshot.speech = false;
    return dictation;
  }

  async function quiet(from: number, to: number) {
    for (let at = from; at <= to; at += 20) {
      snapshot.sinceSpeech = at;
      await vi.advanceTimersByTimeAsync(20);
    }
    // The clip is read as a Blob, which resolves outside the fake clock.
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  it("closes at the short pause when the model confirms the end", async () => {
    const dictation = await turn(700);
    await quiet(0, 300);
    expect(scoreCalls).toBe(1);
    expect(transcribed).toBe(0);
    await quiet(320, 440);
    expect(transcribed).toBe(1);
    dictation.stop();
  });

  it("closes at the plain pause, not the cap, when the model is too slow to answer", async () => {
    answer = () => new Promise(() => {});
    const dictation = await turn(700);
    await quiet(0, 640);
    expect(transcribed).toBe(0);
    await quiet(660, 800);
    expect(transcribed).toBe(1);
    expect(scoreCalls).toBe(1);
    dictation.stop();
  });

  it("waits longer on a low score, then closes at the cap", async () => {
    answer = async () => ({ ok: true, ready: true, probability: 0.2 });
    const dictation = await turn(700);
    await quiet(0, 1400);
    expect(transcribed).toBe(0);
    await quiet(1420, 1560);
    expect(transcribed).toBe(1);
    dictation.stop();
  });

  it("does not shorten a pause when speech resumed after a confirmation", async () => {
    const dictation = await turn(700);
    await quiet(0, 300);
    snapshot.speech = true;
    snapshot.sinceSpeech = 0;
    await vi.advanceTimersByTimeAsync(100);
    snapshot.speech = false;
    await quiet(0, 300);
    expect(scoreCalls).toBe(2);
    await quiet(320, 440);
    expect(transcribed).toBe(1);
    dictation.stop();
  });

  it("falls back to the plain pause when the model file is absent, and stops asking", async () => {
    answer = async () => ({
      ok: true,
      ready: false,
      probability: null,
      reason: "smart-turn file absent",
    });
    const first = await turn(700);
    await quiet(0, 760);
    expect(transcribed).toBe(1);
    first.stop();
    resetDictationLease();
    const second = await turn(700);
    await quiet(0, 760);
    expect(scoreCalls).toBe(1);
    second.stop();
  });
});
