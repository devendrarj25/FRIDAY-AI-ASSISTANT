/**
 * A long utterance is not cut at 20 s: the segment stays open until the end of the turn, its audio moves out of the
 * 30 s capture ring at a pause (or just before the ring would lose it), and the whole clip reaches the decoder.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markWorklet, noteCaptureFrame, resetCaptureRing } from "../../src/lib/friday/pcm-capture";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import {
  DesktopDictation,
  joinSamples,
  LONGFORM_EARLY_READ_MAX_MS,
  LONGFORM_MAX_UTTERANCE_MS,
  LONGFORM_SPILL_AT_MS,
  LONGFORM_SPILL_FORCE_MS,
  resetDictationLease,
  spillDue,
} from "../../src/lib/friday/voice-stt";

type Snap = {
  level: number;
  noiseFloor: number;
  speech: boolean;
  sinceSpeech: number | null;
  running: boolean;
  speakingGuard: boolean;
};

describe("long-form segment rules", () => {
  it("keeps a segment open for minutes, not 20 s", () => {
    expect(LONGFORM_MAX_UTTERANCE_MS).toBeGreaterThanOrEqual(120_000);
    const source = readFileSync("src/lib/friday/voice-stt.ts", "utf8");
    expect(source).not.toMatch(/maxUtteranceMs \?\? 20_000/);
    expect(source.match(/maxUtteranceMs \?\? LONGFORM_MAX_UTTERANCE_MS/g)?.length).toBe(5);
  });

  it("moves audio out of the ring at a pause, or by force before the ring would drop it", () => {
    expect(spillDue({ heldMs: 5_000, quietMs: 900, speech: false })).toBe(false);
    expect(spillDue({ heldMs: LONGFORM_SPILL_AT_MS, quietMs: 100, speech: false })).toBe(false);
    expect(spillDue({ heldMs: LONGFORM_SPILL_AT_MS, quietMs: 300, speech: true })).toBe(false);
    expect(spillDue({ heldMs: LONGFORM_SPILL_AT_MS, quietMs: 300, speech: false })).toBe(true);
    expect(spillDue({ heldMs: LONGFORM_SPILL_AT_MS, quietMs: null, speech: false })).toBe(false);
    expect(spillDue({ heldMs: LONGFORM_SPILL_FORCE_MS, quietMs: 0, speech: true })).toBe(true);
    expect(LONGFORM_SPILL_FORCE_MS).toBeLessThan(30_000); // the capture ring keeps about 30 s
    expect(LONGFORM_EARLY_READ_MAX_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("joins the parts of a segment in order", () => {
    const joined = joinSamples([Float32Array.of(1, 2), new Float32Array(0), Float32Array.of(3)]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
    expect(joinSamples([]).length).toBe(0);
  });
});

describe("a long utterance reaches the decoder whole", () => {
  let listener: ((snap: Snap) => void) | null = null;
  let snapshot: Snap;
  let sent: Uint8Array[] = [];
  let finals: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetDictationLease();
    resetCaptureRing();
    markWorklet(true);
    sent = [];
    finals = [];
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
        // "Still thinking": a short pause is not the end of the turn (the pause below must not close the segment).
        scoreTurn: async () => ({ ok: true, ready: true, probability: 0.2 }),
        transcribe: async (payload: { audioBytes?: Uint8Array; provisional?: boolean }) => {
          if (!payload.provisional && payload.audioBytes) sent.push(payload.audioBytes);
          return { ok: true, text: "one long thought" };
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

  /** One second of a 440 Hz tone whose peak says which second it is (second n peaks at (n + 1) / 100). */
  function tone(second: number): Float32Array {
    const frame = new Float32Array(16000);
    for (let i = 0; i < frame.length; i += 1) {
      frame[i] = ((second + 1) / 100) * Math.sin((2 * Math.PI * 440 * i) / 16000);
    }
    return frame;
  }

  async function speakSeconds(seconds: number, from: number, pauseAt: number | null) {
    for (let second = from; second < from + seconds; second += 1) {
      const paused = pauseAt !== null && second >= pauseAt && second < pauseAt + 1;
      snapshot.speech = !paused;
      snapshot.sinceSpeech = paused ? 300 : 0;
      listener?.(snapshot);
      noteCaptureFrame(tone(second), performance.now(), 16000, Date.now());
      await vi.advanceTimersByTimeAsync(1000);
    }
  }

  async function dictate(seconds: number, pauseAt: number | null) {
    const dictation = new DesktopDictation({
      silenceMs: 650,
      onFinal: (text) => {
        finals.push(text);
      },
    });
    expect(await dictation.start()).toBe(true);
    await speakSeconds(seconds, 0, pauseAt);
    snapshot.speech = false;
    snapshot.sinceSpeech = 2000;
    listener?.(snapshot);
    await vi.advanceTimersByTimeAsync(3000);
    dictation.stop();
  }

  /** The peak of each second of the clip. */
  function seconds(wav: Uint8Array): number[] {
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const count = (wav.byteLength - 44) / 2;
    const peaks: number[] = [];
    for (let second = 0; second * 16000 < count; second += 1) {
      let peak = 0;
      const end = Math.min(count, (second + 1) * 16000);
      for (let i = second * 16000; i < end; i += 1) {
        peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)) / 32767);
      }
      peaks.push(peak);
    }
    return peaks;
  }

  it("sends 70 s of continuous speech as one clip, with nothing lost from the start", async () => {
    await dictate(70, null);
    expect(sent).toHaveLength(1);
    const levels = seconds(sent[0] as Uint8Array);
    expect(levels.length).toBeGreaterThanOrEqual(69);
    expect(levels[0]).toBeCloseTo(0.01, 2); // the first second survived the 30 s ring
    expect(levels[40]).toBeCloseTo(0.41, 2); // the middle is in its place
    expect(levels[levels.length - 1]).toBeGreaterThan(0.68);
    expect(finals).toEqual(["one long thought"]);
  });

  it("moves the audio out of the ring at a pause and still sends the whole clip", async () => {
    await dictate(50, 18);
    expect(sent).toHaveLength(1);
    const levels = seconds(sent[0] as Uint8Array);
    expect(levels.length).toBeGreaterThanOrEqual(49);
    expect(levels[0]).toBeCloseTo(0.01, 2);
    expect(levels[30]).toBeCloseTo(0.31, 2);
  });
});
