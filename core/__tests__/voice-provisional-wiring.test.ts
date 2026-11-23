/**
 * The early read inside the real capture loop (fake clock, fake worker): it starts at the model-confirmed end of the
 * pause, is cancelled when speech resumes, and is adopted as the final answer only when the audio is the same.
 */
import { readFileSync } from "node:fs";
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
type Call = Record<string, unknown>;

describe("early read in the capture loop", () => {
  let listener: ((snap: Snap) => void) | null = null;
  let snapshot: Snap;
  let quietFrom = 0;
  let score: number | null = 0.55;
  const calls: Call[] = [];
  const cancels: Call[] = [];
  const waits: Array<(value: Record<string, unknown>) => void> = [];
  const finals: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetDictationLease();
    resetCaptureRing();
    markWorklet(true);
    calls.length = 0;
    cancels.length = 0;
    waits.length = 0;
    finals.length = 0;
    score = 0.55;
    quietFrom = 0;
    snapshot = {
      level: 0.2,
      noiseFloor: 0,
      speech: false,
      sinceSpeech: null,
      running: true,
      speakingGuard: false,
    };
    Object.defineProperty(snapshot, "sinceSpeech", {
      configurable: true,
      get: () => (snapshot.speech ? 0 : Date.now() - quietFrom),
    });
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
        scoreTurn: async () => ({ ok: true, ready: true, probability: score }),
        cancelTranscribe: async (payload: Call) => {
          cancels.push(payload);
          return { ok: true, cancelled: true };
        },
        transcribe: (payload: Call) => {
          calls.push(payload);
          return new Promise((resolve) => waits.push(resolve));
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

  function speak(ms: number) {
    const samples = new Float32Array(Math.round((ms * 16) / 1)).map(
      (_, i) => Math.sin(i * 0.05) * 0.3,
    );
    noteCaptureFrame(samples, performance.now(), 16000, Date.now());
  }

  async function begin() {
    const dictation = new DesktopDictation({
      maxUtteranceMs: 20_000,
      silenceMs: 900,
      onFinal: (text: string) => {
        finals.push(text);
      },
    });
    expect(await dictation.start()).toBe(true);
    snapshot.speech = true;
    listener?.(snapshot);
    speak(1500);
    snapshot.speech = false;
    quietFrom = Date.now();
    return dictation;
  }

  it("reads early once the model leans to the end, and adopts that read when the pause closes unchanged", async () => {
    const dictation = await begin();
    await vi.advanceTimersByTimeAsync(400); // asked at 240 ms of quiet, answered, early read started
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provisional: true, mime: "audio/wav" });
    expect(String(calls[0]?.["utteranceId"])).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    expect(cancels).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600); // the closing pause (900 ms) is up
    waits[0]?.({ ok: true, text: "open chrome", final: false, audio: { durationMs: 1500 } });
    await vi.advanceTimersByTimeAsync(50);
    expect(finals).toEqual(["open chrome"]);
    expect(calls).toHaveLength(1); // no second decode
    dictation.stop();
  });

  it("cancels the early read when speech resumes, and the final decode is a normal one", async () => {
    const dictation = await begin();
    await vi.advanceTimersByTimeAsync(400);
    const first = calls[0];
    expect(first).toMatchObject({ provisional: true });
    snapshot.speech = true; // the owner goes on
    listener?.(snapshot);
    await vi.advanceTimersByTimeAsync(100);
    expect(cancels).toEqual([{ utteranceId: first?.["utteranceId"] }]);
    speak(900);
    snapshot.speech = false;
    quietFrom = Date.now();
    score = 0.2; // a low score: wait for the capped pause, no early read for this one
    await vi.advanceTimersByTimeAsync(2500);
    waits[0]?.({ ok: true, text: "stale words", final: false }); // the cancelled read answers late
    await vi.advanceTimersByTimeAsync(50);
    const finalCall = calls.find((call) => call["provisional"] !== true);
    expect(finalCall).toBeDefined();
    waits[calls.indexOf(finalCall as Call)]?.({ ok: true, text: "open chrome and the mail" });
    await vi.advanceTimersByTimeAsync(50);
    expect(finals).toEqual(["open chrome and the mail"]);
    dictation.stop();
  });

  it("makes no early read when the model thinks the turn goes on, or when clips are kept for diagnostics", async () => {
    score = 0.3;
    const lowScore = await begin();
    await vi.advanceTimersByTimeAsync(700);
    expect(calls.filter((call) => call["provisional"] === true)).toHaveLength(0);
    lowScore.stop();
  });

  it("makes no early read after a slow decode: a cancel would cost more than the read saves", async () => {
    score = 0.3;
    const dictation = await begin();
    await vi.advanceTimersByTimeAsync(2600);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.["provisional"]).toBeUndefined();
    waits[0]?.({ ok: true, text: "first", elapsedMs: 2500 });
    await vi.advanceTimersByTimeAsync(50);
    expect(finals).toEqual(["first"]);
    score = 0.55;
    snapshot.speech = true;
    listener?.(snapshot);
    speak(1500);
    snapshot.speech = false;
    quietFrom = Date.now();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.filter((call) => call["provisional"] === true)).toHaveLength(0);
    dictation.stop();
  });

  it("falls back to a normal decode when the early read failed", async () => {
    const dictation = await begin();
    await vi.advanceTimersByTimeAsync(400);
    waits[0]?.({ ok: false, reason: "busy" });
    await vi.advanceTimersByTimeAsync(600);
    const finalCall = calls.findIndex((call) => call["provisional"] !== true);
    expect(finalCall).toBeGreaterThan(0);
    waits[finalCall]?.({ ok: true, text: "what time is it" });
    await vi.advanceTimersByTimeAsync(50);
    expect(finals).toEqual(["what time is it"]);
    dictation.stop();
  });

  it("stopping listening cancels an early read that is running", async () => {
    const dictation = await begin();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    dictation.stop();
    expect(cancels).toHaveLength(1);
  });
});

describe("the early read is wired through the desktop bridge", () => {
  const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

  it("has one cancel channel from the page to the speech module, in the quick class", () => {
    expect(read("electron/main.cjs")).toMatch(
      /ipcMain\.handle\("voice:cancel-transcribe", \(_e, payload\) => stt\.cancelTranscribe\(payload \|\| \{\}\)\)/,
    );
    expect(read("electron/preload.cjs")).toMatch(
      /cancelTranscribe: \(payload\) => ipcRenderer\.invoke\("voice:cancel-transcribe", payload \|\| \{\}\)/,
    );
    expect(read("electron/ipc-budget-table.cjs")).toMatch(/"voice:cancel-transcribe": "quick"/);
    expect(read("src/lib/friday/desktop.ts")).toMatch(/cancelTranscribe\?: \(payload: \{/);
  });

  it("the capture loop cancels on resumed speech, seals at the close, and adopts before decoding again", () => {
    const stt = read("src/lib/friday/voice-stt.ts");
    expect(stt).toMatch(
      /this\.turnScore = null;\s*\/\/[^\n]*\n\s*this\.provisional\.invalidate\(\);/,
    );
    expect(stt).toMatch(/this\.provisional\s*\.seal\(\{/);
    expect(stt).toMatch(/const adopted = provisional \? await provisional\.take\(\) : null;/);
    expect(stt).toMatch(/for \(const row of this\.queue\) row\.provisional\?\.cancel\(\);/);
  });
});
