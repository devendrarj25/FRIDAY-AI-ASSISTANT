import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The capture worklet is trusted only after it has posted a frame. A node made with no output, a liveness timer
 * that falls back to the analyser path (and says so), and a mic watch that treats "worklet on, no frames" as a
 * fault, all on a fake audio graph with a fake clock.
 */
const g = globalThis as unknown as Record<string, unknown>;
g["window"] ??= globalThis;
g["requestAnimationFrame"] = () => 1;
g["cancelAnimationFrame"] = () => undefined;

const made: Array<{ options: Record<string, unknown> | undefined; node: FakeNode }> = [];
class FakeNode {
  port: { onmessage: ((event: { data: Float32Array }) => void) | null; close(): void } = {
    onmessage: null,
    close() {},
  };
  constructor(_ctx: unknown, _name: string, options?: Record<string, unknown>) {
    made.push({ options, node: this });
  }
  disconnect() {}
}
g["AudioWorkletNode"] = FakeNode;

const track = {
  readyState: "live",
  label: "mic",
  muted: false,
  stop() {
    this.readyState = "ended";
  },
  addEventListener() {},
  getSettings: () => ({ sampleRate: 48000 }),
};
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }),
    addEventListener() {},
    removeEventListener() {},
    enumerateDevices: async () => [],
  },
});
class Ctx {
  state = "running";
  sampleRate = 48000;
  baseLatency = 0;
  audioWorklet = { addModule: async () => undefined };
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return {
      fftSize: 1024,
      smoothingTimeConstant: 0,
      connect() {},
      disconnect() {},
      getFloatTimeDomainData() {},
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
g["AudioContext"] = Ctx;
(g["window"] as Record<string, unknown>)["AudioContext"] = Ctx;

import { VoiceGate } from "../../src/lib/friday/voice-audio";
import {
  admitUtterance,
  encodeWav,
  captureCounters,
  micWatch,
  noteCaptureFrame,
  preRollFrom,
  resetCaptureRing,
  utteranceSamples,
  workletCapturing,
} from "../../src/lib/friday/pcm-capture";

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  made.length = 0;
  resetCaptureRing();
});

describe("capture worklet liveness", () => {
  it("is made with no output and is not trusted before its first frame", async () => {
    vi.useFakeTimers();
    const gate = new VoiceGate();
    expect(await gate.start(null)).toBe(true);
    await settle();
    expect(made).toHaveLength(1);
    expect(made[0]?.options).toMatchObject({ numberOfInputs: 1, numberOfOutputs: 0 });
    expect(workletCapturing()).toBe(false);
    made[0]?.node.port.onmessage?.({ data: new Float32Array(960).fill(0.01) });
    expect(workletCapturing()).toBe(true);
    // a live worklet is never marked silent
    await vi.advanceTimersByTimeAsync(3000);
    expect(workletCapturing()).toBe(true);
    expect(gate.recentErrors().join(" ")).not.toMatch(/capture worklet silent/);
    gate.stop(true);
  });

  it("a worklet that never posts is dropped after about a second and the analyser path stays in charge", async () => {
    vi.useFakeTimers();
    const gate = new VoiceGate();
    await gate.start(null);
    await settle();
    expect(workletCapturing()).toBe(false);
    await vi.advanceTimersByTimeAsync(1200);
    expect(workletCapturing()).toBe(false);
    expect(gate.recentErrors().join(" ")).toMatch(/capture worklet silent/);
    gate.stop(true);
  });

  it("a worklet that posts late still takes over", async () => {
    vi.useFakeTimers();
    const gate = new VoiceGate();
    await gate.start(null);
    await settle();
    await vi.advanceTimersByTimeAsync(1200);
    made[0]?.node.port.onmessage?.({ data: new Float32Array(960).fill(0.01) });
    expect(workletCapturing()).toBe(true);
    gate.stop(true);
  });
});

describe("closing the microphone empties the capture ring", () => {
  it("releasing the last holder (a pause) leaves no audio behind", async () => {
    const gate = new VoiceGate();
    expect(await gate.acquire("auto-mode")).toBe(true);
    await settle();
    const second = new Float32Array(48_000).fill(0.2);
    noteCaptureFrame(second, 1000, 48_000, 1);
    expect(preRollFrom(0, 5000).length).toBeGreaterThan(0);
    expect(captureCounters().samples).toBeGreaterThan(0);
    gate.release("auto-mode");
    expect(gate.liveTracks()).toBe(0);
    expect(preRollFrom(0, 5000).length).toBe(0);
    expect(captureCounters()).toMatchObject({ frames: 0, samples: 0 });
  });

  it("a reopen (restart) keeps the holders", async () => {
    const gate = new VoiceGate();
    await gate.acquire("auto-mode");
    await settle();
    expect(await gate.restart(null)).toBe(true);
    gate.release("auto-mode");
    expect(gate.liveTracks()).toBe(0);
  });
});

describe("micWatch with the worklet", () => {
  const base = {
    live: true,
    lastFrameMono: 0,
    nowMono: 10_000,
    lastWall: 0,
    nowWall: 0,
    speechForMs: 0,
    capturedSamples: 0,
    segmentWallMs: 0,
    maxUtteranceMs: 60_000,
  };

  it("worklet on and no frame for more than two seconds is no-frames", () => {
    const out = micWatch({ ...base, workletOn: true, workletLiveForMs: 2500 });
    expect(out.restart).toBe(true);
    expect(out.kind).toBe("no-frames");
  });

  it("a young worklet, or none, is left alone", () => {
    expect(micWatch({ ...base, workletOn: true, workletLiveForMs: 800 }).restart).toBe(false);
    expect(micWatch({ ...base }).restart).toBe(false);
  });
});

describe("the utterance queue is fed samples, not bytes", () => {
  it("a 16-bit WAV of 0.4 s (6400 samples) counts as 6400 samples, a short clip", () => {
    const wav = new Blob([encodeWav(new Float32Array(6400)).buffer as ArrayBuffer], {
      type: "audio/wav",
    });
    expect(wav.size).toBeGreaterThan(12_000);
    expect(utteranceSamples(wav)).toBe(6400);
    // the oldest short clip goes first when the queue is over its cap
    const q = [
      { item: "short", samples: utteranceSamples(wav) },
      { item: "long", samples: 32_000 },
      { item: "long2", samples: 32_000 },
    ];
    const out = admitUtterance(q, "new", 32_000, 3);
    expect(out.queue.map((row) => row.item)).toEqual(["long", "long2", "new"]);
  });

  it("a clip with no WAV header is taken as 16-bit samples", () => {
    expect(utteranceSamples(new Blob([new Uint8Array(4000)], { type: "audio/webm" }))).toBe(2000);
  });
});
