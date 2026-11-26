import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The microphone gate opens the device once at a time. Overlapping start, restart and reopen calls (a track that
 * ended, a devicechange, a resume sent twice) used to each call getUserMedia, and the last result overwrote the
 * first stream, which stayed live and held the device. These tests count live tracks on a fake getUserMedia.
 */
const g = globalThis as unknown as Record<string, unknown>;
g["window"] ??= globalThis;
g["requestAnimationFrame"] = () => 1;
g["cancelAnimationFrame"] = () => undefined;

type Tr = {
  stopped: boolean;
  readyState: string;
  rate: number;
  stop(): void;
  addEventListener(name: string, fn: () => void): void;
  getSettings(): object;
  label: string;
};
const tracks: Tr[] = [];
const ended: Array<() => void> = [];
let nextRate = 48000;
const mkTrack = (): Tr => {
  const t: Tr = {
    stopped: false,
    readyState: "live",
    rate: nextRate,
    label: "mic",
    stop() {
      this.stopped = true;
      this.readyState = "ended";
    },
    addEventListener(name, fn) {
      if (name === "ended") ended.push(fn);
    },
    getSettings() {
      return { sampleRate: this.rate };
    },
  };
  tracks.push(t);
  return t;
};
let resolvers: Array<() => void> = [];
let manual = true;
/** Calls made while this is set fail when they settle (a device that errors late). */
let failNext = false;
const gum = vi.fn(
  () =>
    new Promise((res, rej) => {
      const fail = failNext;
      failNext = false;
      // A failed open hands out no stream, so it owns no track.
      const t = fail ? null : mkTrack();
      const done = () =>
        t
          ? res({ getAudioTracks: () => [t], getTracks: () => [t] })
          : rej(Object.assign(new Error("late"), { name: "AbortError" }));
      if (manual) resolvers.push(done);
      else done();
    }),
);
const mediaListeners: Array<() => void> = [];
Object.defineProperty(globalThis.navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: gum,
    addEventListener: (_: string, fn: () => void) => mediaListeners.push(fn),
    removeEventListener() {},
    enumerateDevices: async () => [],
  },
});
class Ctx {
  state = "running";
  sampleRate = 48000;
  baseLatency = 0;
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

const flush = () => new Promise((r) => setTimeout(r, 5));
const live = () => tracks.filter((t) => !t.stopped).length;
const settle = async () => {
  await flush();
  const run = resolvers;
  resolvers = [];
  run.forEach((r) => r());
};
const reset = () => {
  tracks.length = 0;
  ended.length = 0;
  mediaListeners.length = 0;
  resolvers = [];
  manual = true;
  failNext = false;
  nextRate = 48000;
  gum.mockClear();
};

afterEach(() => {
  vi.useRealTimers();
  reset();
});

describe("VoiceGate single flight", () => {
  it("two overlapping restarts open the device once and leave one live track", async () => {
    reset();
    const gate = new VoiceGate();
    const a = gate.restart(null);
    const b = gate.restart(null);
    await settle();
    await Promise.all([a, b]);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(live()).toBe(1);
    gate.stop(true);
    expect(live()).toBe(0);
  });

  it("start and restart racing share one open", async () => {
    reset();
    const gate = new VoiceGate();
    const a = gate.start(null);
    const b = gate.restart(null);
    await settle();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(live()).toBe(1);
    gate.stop(true);
  });

  it("a restart for a different device waits for the open, then replaces it: still one live track", async () => {
    reset();
    const gate = new VoiceGate();
    const a = gate.start(null);
    const b = gate.restart("usb-mic");
    await settle();
    await a;
    await settle();
    await b;
    expect(gum).toHaveBeenCalledTimes(2);
    expect(live()).toBe(1);
    gate.stop(true);
    expect(live()).toBe(0);
  });

  it("stop while the device is still opening lets the late stream go", async () => {
    reset();
    const gate = new VoiceGate();
    const a = gate.start(null);
    await flush();
    gate.stop(true);
    await settle();
    expect(await a).toBe(false);
    expect(live()).toBe(0);
  });

  it("stop then start while the first open is slow: the reopen is true and exactly one stream is live", async () => {
    reset();
    const gate = new VoiceGate();
    const first = gate.start(null);
    await flush();
    gate.stop(true);
    const second = gate.start(null);
    await settle();
    await flush();
    await settle();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(live()).toBe(1);
    expect(gate.liveTracks()).toBe(1);
    expect(gate.lastCaptureFailure()).toBeNull();
    gate.stop(true);
    expect(live()).toBe(0);
  });

  it("mute then unmute through acquire and release keeps the reopen true with one live stream", async () => {
    reset();
    const gate = new VoiceGate();
    const first = gate.acquire("auto", null);
    await flush();
    gate.release("auto");
    const second = gate.acquire("auto", null);
    await settle();
    await flush();
    await settle();
    await first;
    expect(await second).toBe(true);
    expect(live()).toBe(1);
    expect(gate.lastCaptureFailure()).toBeNull();
    gate.release("auto");
    expect(live()).toBe(0);
  });

  it("two starts in a row share one open", async () => {
    reset();
    const gate = new VoiceGate();
    const a = gate.start(null);
    const b = gate.start(null);
    await settle();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(live()).toBe(1);
    gate.stop(true);
  });

  it("teardown during an open leaves zero live tracks and no later reopen", async () => {
    reset();
    const gate = new VoiceGate();
    const a = gate.start(null);
    await flush();
    gate.stop(true);
    await settle();
    expect(await a).toBe(false);
    await flush();
    expect(live()).toBe(0);
    expect(gate.liveTracks()).toBe(0);
  });

  it("a stale open that fails late does not wipe the holders of the reopen", async () => {
    reset();
    const gate = new VoiceGate();
    failNext = true;
    const first = gate.acquire("auto", null);
    await flush();
    gate.release("auto");
    const second = gate.acquire("auto", null);
    await settle();
    await flush();
    await settle();
    await first;
    expect(await second).toBe(true);
    expect(gate.liveTracks()).toBe(1);
    expect(live()).toBe(1);
    gate.release("auto");
    expect(live()).toBe(0);
  });

  it("an ended track plus a devicechange plus a second resume reopen once", async () => {
    reset();
    manual = false;
    const gate = new VoiceGate();
    expect(await gate.acquire("auto", null)).toBe(true);
    expect(gum).toHaveBeenCalledTimes(1);
    tracks[0]!.stop();
    ended[0]!();
    mediaListeners.forEach((fn) => fn());
    void gate.restart(null);
    void gate.restart(null);
    await flush();
    await flush();
    expect(live()).toBe(1);
    expect(gate.liveTracks()).toBe(1);
    gate.release("auto");
    expect(live()).toBe(0);
  });

  it("liveTracks is 0 when closed", () => {
    reset();
    expect(new VoiceGate().liveTracks()).toBe(0);
  });
});

describe("VoiceGate sample-rate change", () => {
  it("rebuilds the graph once after a debounce when the track rate moves", async () => {
    reset();
    manual = false;
    const gate = new VoiceGate();
    await gate.acquire("auto", null);
    expect(gum).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    tracks[0]!.rate = 16000;
    const watch = gate as unknown as { watchRates(force: boolean): void };
    watch.watchRates(true);
    watch.watchRates(true);
    expect(gum).toHaveBeenCalledTimes(1);
    nextRate = 16000;
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await flush();
    expect(gum).toHaveBeenCalledTimes(2);
    expect(live()).toBe(1);
    gate.release("auto");
  });

  it("does nothing when the rate stays the same", async () => {
    reset();
    manual = false;
    const gate = new VoiceGate();
    await gate.acquire("auto", null);
    vi.useFakeTimers();
    (gate as unknown as { watchRates(force: boolean): void }).watchRates(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(gum).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    gate.release("auto");
  });
});
