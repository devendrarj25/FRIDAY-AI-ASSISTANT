/**
 * Auto listening starts from the PCM ring when MediaRecorder is missing.
 * The segment cap still closes, and the turn score travels as bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markWorklet, noteCaptureFrame, resetCaptureRing } from "../../src/lib/friday/pcm-capture";
import { voiceGate } from "../../src/lib/friday/voice-audio";
import { DesktopDictation, resetDictationLease } from "../../src/lib/friday/voice-stt";

type Snap = {
  level: number;
  noiseFloor: number;
  speech: boolean;
  sinceSpeech: number | null;
  running: boolean;
  speakingGuard: boolean;
};

describe("pcm dictation", () => {
  let listener: ((snap: Snap) => void) | null = null;
  let snapshot: Snap;
  let scored: { audioBytes?: Uint8Array; audioBase64?: string; mime?: string } | null = null;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetDictationLease();
    resetCaptureRing();
    markWorklet(true);
    scored = null;
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
        scoreTurn: async (payload: {
          audioBytes?: Uint8Array;
          audioBase64?: string;
          mime?: string;
        }) => {
          scored = payload;
          return { ok: true, ready: true, probability: 0.9 };
        },
        transcribe: async () => ({ ok: true, text: "ok" }),
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

  function listen(maxUtteranceMs: number) {
    let starts = 0;
    const dictation = new DesktopDictation({
      maxUtteranceMs,
      silenceMs: 200,
      onFinal: () => {},
      onSpeechStart: () => {
        starts += 1;
      },
    });
    return { dictation, starts: () => starts };
  }

  it("starts when MediaRecorder is undefined and the PCM ring is capturing", async () => {
    const { dictation } = listen(1000);
    expect(await dictation.start()).toBe(true);
    expect(dictation.active).toBe(true);
    dictation.stop();
  });

  it("does not leave a segment open past the cap", async () => {
    const { dictation, starts } = listen(1000);
    expect(await dictation.start()).toBe(true);
    snapshot.speech = true;
    listener?.(snapshot);
    expect(starts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1300);
    snapshot.speech = true;
    listener?.(snapshot);
    expect(starts()).toBe(2);
    dictation.stop();
  });

  it("sends the turn score as binary audio", async () => {
    const { dictation } = listen(20_000);
    expect(await dictation.start()).toBe(true);
    snapshot.speech = true;
    listener?.(snapshot);
    const samples = new Float32Array(4000);
    samples.fill(0.2);
    noteCaptureFrame(samples, performance.now(), 16000, Date.now());
    snapshot.speech = false;
    snapshot.sinceSpeech = 800;
    await vi.advanceTimersByTimeAsync(100);
    expect(scored?.audioBytes).toBeInstanceOf(Uint8Array);
    expect((scored?.audioBytes?.byteLength || 0) > 44).toBe(true);
    expect(scored && "audioBase64" in scored).toBe(false);
    expect(scored?.mime).toBe("audio/wav");
    dictation.stop();
  });
});
