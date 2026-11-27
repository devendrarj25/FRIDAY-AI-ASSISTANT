/**
 * One end-of-turn owner. With a live streaming ear the kernel verdict is the only authority and the renderer never
 * asks for a score; with no verdict the turn closes at the longest wait. With the stream off the renderer scores, and
 * a score that did not come (busy, null) never closes an unfinished sentence at the first silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eotHoldFrames } from "../../src/lib/friday/voice-engine/endpoint-calibration";
import { markWorklet, noteCaptureFrame, resetCaptureRing } from "../../src/lib/friday/pcm-capture";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import {
  DesktopDictation,
  resetDictationLease,
  turnHoldAfterScore,
  turnHoldPlan,
} from "../../src/lib/friday/voice-stt";

const DANGLING = "mujhe ye karna hai aur";

describe("turnHoldAfterScore with the transcript tail", () => {
  it("is the same as before without a tail", () => {
    expect(turnHoldAfterScore(null)).toBe("done");
    expect(turnHoldAfterScore(0.2)).toBe("extend");
    expect(turnHoldAfterScore(0.95)).toBe("confirmed");
  });

  it("holds a null or busy score on a dangling tail, and finishes a complete one", () => {
    expect(eotHoldFrames(DANGLING, "open", "hinglish")).toBeGreaterThan(0);
    expect(turnHoldAfterScore(null, { text: DANGLING, expect: "open", lang: "hinglish" })).toBe(
      "extend",
    );
    expect(turnHoldAfterScore(undefined, { text: "open chrome and", lang: "en" })).toBe("extend");
    expect(turnHoldAfterScore(null, { text: "open chrome.", lang: "en" })).toBe("done");
    expect(turnHoldAfterScore(null, { text: "", lang: "en" })).toBe("done");
  });

  it("never overrides a real score", () => {
    expect(turnHoldAfterScore(0.95, { text: DANGLING })).toBe("confirmed");
    expect(turnHoldAfterScore(0.55, { text: DANGLING })).toBe("done");
  });
});

describe("turnHoldPlan when the stream owns the turn", () => {
  const base = {
    hold: "idle" as const,
    speech: false,
    silenceMs: 700,
    capMs: 1480,
    canScore: true,
    streamOwns: true,
    maxWaitMs: 2400,
  };

  it("never asks for a score and ignores the plain silence", () => {
    expect(turnHoldPlan({ ...base, quietMs: 300 }).ask).toBe(false);
    expect(turnHoldPlan({ ...base, quietMs: 700 })).toEqual({ ask: false, close: false });
    expect(turnHoldPlan({ ...base, quietMs: 2399 }).close).toBe(false);
  });

  it("closes at the longest wait when no verdict came", () => {
    expect(turnHoldPlan({ ...base, quietMs: 2400 }).close).toBe(true);
    expect(turnHoldPlan({ ...base, quietMs: 4000, maxWaitMs: 4000 }).close).toBe(true);
    expect(turnHoldPlan({ ...base, quietMs: 3999, maxWaitMs: 4000 }).close).toBe(false);
  });

  it("never closes on speech, except at the hard cap", () => {
    expect(turnHoldPlan({ ...base, quietMs: 9000, speech: true }).close).toBe(false);
    expect(turnHoldPlan({ ...base, quietMs: 0, speech: true, tooLong: true }).close).toBe(true);
  });

  it("keeps the old rule when the stream does not own the turn", () => {
    const off = { ...base, streamOwns: false };
    expect(turnHoldPlan({ ...off, quietMs: 300 }).ask).toBe(true);
    expect(turnHoldPlan({ ...off, hold: "done", quietMs: 700 }).close).toBe(true);
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
  let transcribed = 0;
  let finals = 0;
  let scoreReply: { ok: boolean; ready: boolean; probability: number | null; reason?: string };
  let streamEvents: Array<Record<string, unknown>>;
  let streamOpen = 0;

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
    finals = 0;
    streamOpen = 0;
    streamEvents = [];
    scoreReply = { ok: true, ready: false, probability: null, reason: "busy" };
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
          return scoreReply;
        },
        openSttStream: async () => {
          streamOpen += 1;
          return { ok: true, streamId: "s1", chunkMs: 160 };
        },
        feedSttStream: async () => ({ ok: true, events: streamEvents.splice(0) }),
        closeSttStream: async () => ({ ok: true, text: "heard" }),
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

  async function turn(options: Partial<ConstructorParameters<typeof DesktopDictation>[0]>) {
    const dictation = new DesktopDictation({
      maxUtteranceMs: 30_000,
      silenceMs: () => 700,
      onFinal: () => {
        finals += 1;
      },
      ...options,
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
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  it("a busy score on a dangling tail holds past the first silence, then closes by the cap", async () => {
    const dictation = await turn({ turnTail: () => DANGLING, turnLang: () => "hinglish" });
    await quiet(0, 800);
    expect(scoreCalls).toBe(1);
    expect(transcribed).toBe(0);
    await quiet(820, 1700);
    expect(transcribed).toBe(1);
    dictation.stop();
  });

  it("a busy score on a finished sentence still closes at the plain silence", async () => {
    const dictation = await turn({ turnTail: () => "open chrome.", turnLang: () => "en" });
    await quiet(0, 800);
    expect(transcribed).toBe(1);
    dictation.stop();
  });

  it("with a live stream the renderer never scores, and no verdict closes at the longest wait", async () => {
    const dictation = await turn({ streamPlan: () => ({ streamEngine: "auto", locale: "hi" }) });
    expect(streamOpen).toBe(1);
    await quiet(0, 2300);
    expect(scoreCalls).toBe(0);
    expect(finals).toBe(0);
    await quiet(2320, 2500);
    expect(scoreCalls).toBe(0);
    expect(finals).toBe(1);
    dictation.stop();
  });

  it("dictation waits to 4 s for a verdict that never comes", async () => {
    const dictation = await turn({
      streamPlan: () => ({ streamEngine: "auto", locale: "hi" }),
      turnExpect: () => "dictation",
    });
    await quiet(0, 2600);
    expect(finals).toBe(0);
    await quiet(2620, 4100);
    expect(finals).toBe(1);
    dictation.stop();
  });

  it("the kernel EndOfTurn verdict closes the turn, with no score asked", async () => {
    const dictation = await turn({ streamPlan: () => ({ streamEngine: "auto", locale: "hi" }) });
    await quiet(0, 400);
    streamEvents.push({ type: "endpoint", event: "EndOfTurn", reason: "model" });
    noteCaptureFrame(new Float32Array(4000).fill(0.2), performance.now(), 16000, Date.now());
    await quiet(420, 1200);
    expect(scoreCalls).toBe(0);
    expect(finals).toBe(1);
    dictation.stop();
  });

  it("a crash-loop reply reaches the voice status with its lines and retry time", async () => {
    const lines = { en: "Listening paused.", hi: "सुनना रुका है।", hinglish: "Listening paused hai." };
    (window as unknown as { friday: { transcribe: unknown } }).friday.transcribe = async () => {
      transcribed += 1;
      return {
        ok: false,
        reason: "crash-loop",
        error: lines.en,
        lines,
        retry: true,
        retryAfterMs: 30_000,
      };
    };
    const paused: Array<{ lines: typeof lines; retryAfterMs: number }> = [];
    const dictation = await turn({
      turnTail: () => "open chrome.",
      onListeningPaused: (pause) => paused.push(pause),
    });
    expect(dictation.listeningPause).toBeNull();
    await quiet(0, 800);
    expect(transcribed).toBe(1);
    expect(paused).toEqual([{ lines, retryAfterMs: 30_000 }]);
    expect(dictation.listeningPause).toEqual({ lines, retryAfterMs: 30_000 });
    dictation.stop();
  });
});
