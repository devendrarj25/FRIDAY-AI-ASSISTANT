/**
 * The echo reference in live capture (setting voice.echoReference, default off): the playback tap fan-out, the
 * capture hook before the VAD level and the STT ring, fail-closed behaviour, memory clearing, and the one
 * measurement chunk. Simulated rooms only; a real room, speaker and clock are not measured.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureProcessorInstalled,
  cleanedLevel,
  markWorklet,
  noteCaptureFrame,
  resetCaptureRing,
  setCaptureLatency,
  setCaptureProcessor,
  preRollFrom,
} from "../../src/lib/friday/pcm-capture";
import {
  EchoLive,
  IDLE_CLEAR_S,
  OffsetFilter,
  SHADOW_CHUNK,
  STOP_HOLD_S,
  type EchoShadowSend,
} from "../../src/lib/friday/voice-engine/echo-live";
import { floatToPcm16 } from "../../src/lib/friday/voice-engine/audio-format";
import { PcmClipPlayer, type PcmContext } from "../../src/lib/friday/voice-engine/pcm-clip-player";
import {
  PcmPlayback,
  type ContextLike,
} from "../../src/lib/friday/voice-engine/playback-scheduler";

const read = (rel: string) => readFileSync(resolve(__dirname, "../..", rel), "utf8");

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

/** Speech-like band-limited signal at 48 kHz (nothing above about 3 kHz), with syllables and pauses. */
function speech48(seconds: number, seed: number): Float32Array {
  const rand = rng(seed);
  const n = Math.round(seconds * 48_000);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i += 1) raw[i] = rand();
  const smooth = (x: Float32Array): Float32Array => {
    const out = new Float32Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i += 1) {
      acc += x[i]! - (i >= 16 ? x[i - 16]! : 0);
      out[i] = acc / 16;
    }
    return out;
  };
  const x = smooth(smooth(raw));
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / 48_000;
    x[i] =
      x[i]! *
      Math.max(0, Math.sin(2 * Math.PI * 3.2 * t)) *
      (Math.sin(2 * Math.PI * 0.4 * t) > -0.6 ? 1 : 0);
    peak = Math.max(peak, Math.abs(x[i]!));
  }
  for (let i = 0; i < n; i += 1) x[i] = (x[i]! / peak) * 0.6;
  return x;
}

const decimate = (x: Float32Array, by: number): Float32Array => {
  const out = new Float32Array(Math.floor(x.length / by));
  for (let i = 0; i < out.length; i += 1) out[i] = x[i * by]!;
  return out;
};

/** A simulated room at 48 kHz: a bulk delay and a decaying random impulse response. */
function room48(delayMs: number, gain: number, seed: number) {
  const delay = Math.round((delayMs / 1000) * 48_000);
  const rand = rng(seed);
  const h = new Float32Array(480);
  for (let k = 0; k < h.length; k += 1)
    h[k] = gain * Math.exp(-k / 90) * (k === 0 ? 1 : rand() * 1.2);
  return (x: Float32Array, length: number): Float32Array => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let acc = 0;
      for (let k = 0; k < h.length; k += 1) {
        const j = i - delay - k;
        if (j >= 0 && j < x.length) acc += h[k]! * x[j]!;
      }
      out[i] = acc;
    }
    return out;
  };
}

const rmsOf = (x: ArrayLike<number>): number => {
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += (x[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, x.length));
};

/** A playback context whose clock is the test's mono clock minus a fixed offset, read in 10 ms steps like a stale one. */
function fakeContext(clock: { ms: number }, offset: number, rate = 24_000): PcmContext {
  return {
    sampleRate: rate,
    state: "running",
    outputLatency: 0.03,
    get currentTime() {
      return Math.floor((clock.ms / 1000 - offset) * 100) / 100;
    },
    destination: {},
    createBuffer: () => ({ copyToChannel: () => undefined }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      onended: null,
    }),
  } as unknown as PcmContext;
}

const noTimers = {
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
};

function newPlayer(clock: { ms: number }, offset = 3.7) {
  return new PcmClipPlayer(fakeContext(clock, offset), { timers: noTimers });
}

beforeEach(() => {
  resetCaptureRing();
  setCaptureProcessor(null);
  setCaptureLatency(0);
});
afterEach(() => {
  setCaptureProcessor(null);
  markWorklet(false);
  resetCaptureRing();
});

describe("tap fan-out on the playback scheduler", () => {
  const ctx = (): ContextLike => fakeContext({ ms: 0 }, 0);

  it("calls the single onScheduled listener and every added listener, each with the same chunk", () => {
    const playback = new PcmPlayback(ctx(), { rate: 24_000 });
    const seen: string[] = [];
    playback.onScheduled((when, pcm) => seen.push(`primary:${when}:${pcm.length}`));
    const off = playback.addScheduledListener((when, pcm) =>
      seen.push(`tap:${when}:${pcm.length}`),
    );
    expect(playback.enqueue(new Int16Array(240).fill(100))).toBe(true);
    expect(seen).toEqual(["primary:0:240", "tap:0:240"]);
    off();
    playback.enqueue(new Int16Array(240).fill(100));
    expect(seen.slice(2)).toEqual(["primary:0.01:240"]);
  });

  it("keeps realtime working: onScheduled(null) removes only the primary, a tap stays", () => {
    const playback = new PcmPlayback(ctx(), { rate: 24_000 });
    let primary = 0;
    let tap = 0;
    playback.onScheduled(() => (primary += 1));
    playback.addScheduledListener(() => (tap += 1));
    playback.enqueue(new Int16Array(120).fill(5));
    playback.onScheduled(null);
    playback.enqueue(new Int16Array(120).fill(5));
    expect({ primary, tap }).toEqual({ primary: 1, tap: 2 });
  });

  it("a throwing listener never stops the audio or the listeners after it", () => {
    const playback = new PcmPlayback(ctx(), { rate: 24_000 });
    let later = 0;
    playback.onScheduled(() => {
      throw new Error("boom");
    });
    playback.addScheduledListener(() => {
      throw new Error("boom too");
    });
    playback.addScheduledListener(() => (later += 1));
    expect(playback.enqueue(new Int16Array(240).fill(9))).toBe(true);
    expect(later).toBe(1);
    expect(playback.queuedMs()).toBeGreaterThan(9); // the chunk was scheduled and the queue moved on
  });

  it("dispose drops every listener", () => {
    const playback = new PcmPlayback(ctx(), { rate: 24_000 });
    let n = 0;
    playback.addScheduledListener(() => (n += 1));
    playback.dispose();
    playback.enqueue(new Int16Array(120).fill(5));
    expect(n).toBe(0);
  });

  it("PcmClipPlayer exposes the fan-out, its clock and the stop time", () => {
    const clock = { ms: 8_000 };
    const player = newPlayer(clock);
    const chunks: number[] = [];
    const stops: number[] = [];
    player.addScheduledListener((_when, pcm) => chunks.push(pcm.length));
    player.addStopListener((at) => stops.push(at));
    player.start(new Int16Array(2400).fill(1000), 24_000);
    expect(chunks).toEqual([2400]);
    expect(player.clock.sampleRate).toBe(24_000);
    player.stop();
    expect(stops).toEqual([player.clock.currentTime]);
    player.dispose();
    expect(stops).toHaveLength(2);
  });

  it("the realtime voice still uses onScheduled, and the echo tap uses the added listener", () => {
    expect(read("src/lib/friday/voice-engine/realtime-voice.ts")).toMatch(
      /deps\.playback\.onScheduled\(\(when, pcm\)/,
    );
    const live = read("src/lib/friday/voice-engine/echo-live.ts");
    expect(live).toMatch(
      /player\.addScheduledListener\(\(when, pcm\) => this\.onScheduled\(when, pcm\)\)/,
    );
    expect(live).not.toMatch(/\.onScheduled\(\(/);
  });
});

describe("the offset filter", () => {
  it("keeps the smallest candidate, rises only slowly, and follows a real jump", () => {
    const f = new OffsetFilter();
    expect(f.observe(10.02, 0)).toBeCloseTo(10.02, 6);
    expect(f.observe(10.0, 1)).toBeCloseTo(10.0, 6); // a smaller candidate wins at once
    expect(f.observe(10.03, 2)).toBeLessThan(10.001); // a late delivery barely moves it (150 ppm per second)
    expect(f.observe(9.0, 2.5, true)).toBeLessThan(10.001); // frozen: nothing moves while an answer plays
    expect(f.observe(9.0, 2.6, true)).toBeGreaterThan(9.99);
    expect(f.observe(11.5, 3)).toBeCloseTo(11.5, 6); // a suspended context: a real jump
    expect(f.observe(Number.NaN, 4)).toBeCloseTo(11.5, 6);
  });
});

/**
 * One simulated session at 48 kHz through the real hook: the speaker plays an answer through the real
 * `PcmClipPlayer` (24 kHz clauses), a room makes the echo, and the microphone delivers 128-sample frames to
 * `noteCaptureFrame` with a jittery delivery clock.
 */
const liveOf: { current: EchoLive | null } = { current: null };

function session(opts: {
  on: boolean;
  install: boolean;
  delayMs: number;
  gain: number;
  seed: number;
  shadow?: EchoShadowSend | null;
  nearEnd?: Float32Array | null;
  jitterMs?: number;
  clock?: { ms: number };
  probe?: (frame: { at: number; delivered: number; echo: Float32Array }) => void;
  biasMs?: number;
  suppressor?: boolean;
  onLive?: (live: EchoLive) => void;
}) {
  const seconds = 5;
  const outLat = 0.03;
  const inLat = 0.012;
  const x48 = speech48(seconds, opts.seed);
  const x24 = decimate(x48, 2);
  const clock = opts.clock ?? { ms: 0 };
  const player = newPlayer(clock);
  const live = new EchoLive({
    enabled: () => opts.on,
    nowMs: () => clock.ms,
    shadow: () => opts.shadow ?? null,
    suppressor: () => opts.suppressor === true,
  });
  opts.onLive?.(live);
  resetCaptureRing();
  setCaptureProcessor(null);
  setCaptureLatency(inLat);
  markWorklet(true);
  if (opts.install) live.attach(player);

  const T0 = 7.5; // the first microphone sample, in the air, on the common clock
  const S = 10.0; // the answer is scheduled now
  const emitIndex = Math.round((S + outLat - T0) * 48_000);
  const total = emitIndex + x48.length + 48_000;
  const emitted = new Float32Array(total);
  emitted.set(x48, emitIndex);
  const echo = room48(opts.delayMs, opts.gain, 7)(emitted, total);
  if (opts.nearEnd)
    for (let i = 0; i < total && i < opts.nearEnd.length; i += 1) echo[i]! += opts.nearEnd[i]!;

  const jitter = rng(99);
  let scheduled = false;
  let lastDelivered = 0;
  const frame = 128;
  for (let at = 0; at + frame <= total; at += frame) {
    const ideal = (T0 + (at + frame) / 48_000 + inLat) * 1000;
    const delivered = Math.max(
      lastDelivered,
      ideal + (opts.biasMs ?? 0) + (jitter() + 0.5) * (opts.jitterMs ?? 6),
    );
    lastDelivered = delivered;
    clock.ms = delivered;
    if (!scheduled && delivered >= S * 1000) {
      scheduled = true;
      for (let c = 0; c < x24.length; c += 12_000) {
        player.start(floatToPcm16(x24.subarray(c, Math.min(x24.length, c + 12_000))), 24_000);
      }
    }
    noteCaptureFrame(echo.subarray(at, at + frame), delivered, 48_000, 0);
    opts.probe?.({ at, delivered, echo });
  }
  return { live, player, clock, echoStart: (S + outLat + opts.delayMs / 1000) * 1000, seconds };
}

/** Power of the ring over the settled part of the answer, by the delivery stamps (the same for every run). */
function settledPower(echoStartMs: number, seconds: number): number {
  const from = echoStartMs + 2500;
  const to = echoStartMs + (seconds - 0.4) * 1000;
  const a = preRollFrom(from + 500);
  const b = preRollFrom(to + 500);
  return rmsOf(a.subarray(0, a.length - b.length)) ** 2;
}

describe("capture hook: setting off and fail closed", () => {
  it("setting off with the whole path installed leaves the ring byte-identical to no hook at all", () => {
    const plain = session({ on: false, install: false, delayMs: 60, gain: 0.6, seed: 31 });
    const before = preRollFrom(0);
    const off = session({ on: false, install: true, delayMs: 60, gain: 0.6, seed: 31 });
    const after = preRollFrom(0);
    expect(after.length).toBe(before.length);
    expect(Buffer.from(after.buffer).equals(Buffer.from(before.buffer))).toBe(true);
    expect(off.live.diagnostics()).toMatchObject({
      cancelledFrames: 0,
      passedFrames: 0,
      enabled: false,
    });
    expect(plain.live.diagnostics().attached).toBe(false);
  });

  it("setting on but nothing ever played: the frames pass through and no work is done", () => {
    resetCaptureRing();
    const clock = { ms: 0 };
    const live = new EchoLive({ enabled: () => true, nowMs: () => clock.ms });
    live.attach(newPlayer(clock));
    markWorklet(true);
    const quiet = speech48(1, 5);
    const run = (): Float32Array => {
      resetCaptureRing();
      markWorklet(true);
      for (let at = 0; at + 128 <= quiet.length; at += 128) {
        clock.ms = 1000 + (at / 48_000) * 1000;
        noteCaptureFrame(quiet.subarray(at, at + 128), clock.ms, 48_000);
      }
      return preRollFrom(0);
    };
    const withHook = run();
    live.detach();
    const without = run();
    expect(Buffer.from(withHook.buffer).equals(Buffer.from(without.buffer))).toBe(true);
    expect(live.diagnostics().cancelledFrames).toBe(0);
  });

  it("a processor that throws leaves every frame untouched and is removed after five failures", () => {
    markWorklet(true);
    const frames = speech48(0.5, 3);
    const feed = () => {
      resetCaptureRing();
      markWorklet(true);
      for (let at = 0; at + 128 <= frames.length; at += 128)
        noteCaptureFrame(frames.subarray(at, at + 128), 100 + at / 48, 48_000);
      return preRollFrom(0);
    };
    const base = feed();
    setCaptureProcessor({
      process: () => {
        throw new Error("canceller failed");
      },
      clear: () => undefined,
    });
    expect(captureProcessorInstalled()).toBe(true);
    const withThrow = feed();
    expect(Buffer.from(withThrow.buffer).equals(Buffer.from(base.buffer))).toBe(true);
    expect(captureProcessorInstalled()).toBe(false);
  });

  it("an error inside the live hook counts and passes the frame through", () => {
    const clock = { ms: 0 };
    const live = new EchoLive({
      enabled: () => true,
      nowMs: () => clock.ms,
      captureLatency: () => {
        throw new Error("no latency");
      },
    });
    live.attach(newPlayer(clock));
    markWorklet(true);
    const player = (live as unknown as { player: PcmClipPlayer }).player;
    player.start(new Int16Array(4800).fill(3000), 24_000);
    const frame = new Float32Array(128).fill(0.1);
    const out = [] as number[];
    for (let i = 0; i < 20; i += 1) {
      clock.ms = 5000 + i * 2.7;
      noteCaptureFrame(frame, clock.ms, 48_000);
      out.push(preRollFrom(0).length);
    }
    expect(live.diagnostics().errors).toBeGreaterThan(0);
    expect(live.diagnostics().cancelledFrames).toBe(0);
    expect(Math.abs(out.at(-1)! - (20 * 128) / 3)).toBeLessThanOrEqual(20);
  });

  it("five failed frames in a row switch the hook off for the session; attaching again brings it back", () => {
    const clock = { ms: 0 };
    let broken = true;
    const live = new EchoLive({
      enabled: () => true,
      nowMs: () => clock.ms,
      captureLatency: () => {
        if (broken) throw new Error("no latency");
        return 0.01;
      },
    });
    live.attach(newPlayer(clock));
    markWorklet(true);
    const player = (live as unknown as { player: PcmClipPlayer }).player;
    player.start(new Int16Array(24_000).fill(3000), 24_000);
    const frame = new Float32Array(128).fill(0.1);
    for (let i = 0; i < 20; i += 1) {
      clock.ms = 5000 + i * 2.7;
      noteCaptureFrame(frame, clock.ms, 48_000);
    }
    expect(live.diagnostics()).toMatchObject({ errors: 5, fellBack: true, cancelledFrames: 0 });
    broken = false;
    live.attach(newPlayer(clock));
    expect(live.diagnostics().fellBack).toBe(false);
  });

  it("the analyser fallback (no worklet) is never cancelled", () => {
    const clock = { ms: 0 };
    const live = new EchoLive({ enabled: () => true, nowMs: () => clock.ms });
    live.attach(newPlayer(clock));
    markWorklet(false);
    (live as unknown as { player: PcmClipPlayer }).player.start(
      new Int16Array(4800).fill(3000),
      24_000,
    );
    for (let i = 0; i < 10; i += 1) {
      clock.ms = 5000 + i * 21;
      noteCaptureFrame(new Float32Array(1024).fill(0.1), clock.ms, 48_000);
    }
    expect(live.diagnostics().cancelledFrames + live.diagnostics().passedFrames).toBe(0);
  });
});

describe("capture hook: setting on, synthetic playback (simulated rooms, not a real room)", () => {
  it.each([
    ["60 ms path", { delayMs: 60, gain: 0.6, seed: 31 }],
    ["140 ms path", { delayMs: 140, gain: 0.5, seed: 32 }],
  ])(
    "takes at least 25 dB of her voice out of the ring that feeds the recogniser: %s",
    (_n, room) => {
      const off = session({ on: false, install: true, ...room });
      const raw = settledPower(off.echoStart, off.seconds);
      const on = session({ on: true, install: true, ...room });
      const cleaned = settledPower(on.echoStart, on.seconds);
      const reduction = 10 * Math.log10(raw / Math.max(cleaned, 1e-12));
      expect(on.live.diagnostics().cancelledFrames).toBeGreaterThan(100);
      expect(reduction).toBeGreaterThanOrEqual(25);
    },
  );

  it("the level the VAD reads is the cleaned one while she speaks, and absent when the setting is off", () => {
    const levels = (on: boolean) => {
      const cleaned: number[] = [];
      const raw: number[] = [];
      let nulls = 0;
      const run = session({
        on,
        install: true,
        delayMs: 60,
        gain: 0.6,
        seed: 31,
        probe: ({ at, delivered, echo }) => {
          // 2.5 s after her echo begins, the filter has settled
          if (delivered < (10.0 + 0.03 + 0.06 + 2.5) * 1000 || delivered > 14.4 * 1000) return;
          const level = cleanedLevel(delivered);
          if (level === null) nulls += 1;
          else cleaned.push(level);
          raw.push(rmsOf(echo.subarray(Math.max(0, at - 1024), at + 128)));
        },
      });
      return { cleaned, raw, nulls, run };
    };
    const on = levels(true);
    const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
    expect(on.nulls).toBe(0);
    expect(on.cleaned.length).toBeGreaterThan(300);
    expect(mean(on.cleaned)).toBeLessThan(mean(on.raw) * 0.2);
    const off = levels(false);
    expect(off.cleaned).toHaveLength(0);
    expect(off.nulls).toBeGreaterThan(300);
  });

  it("frames still in warm-up pass the microphone through and count as passed, never as cancelled", () => {
    // her echo begins at 10.0 + 0.03 + 0.06 s; the canceller needs time to find the delay and trust its filter
    const early: Array<{ cancelled: number; passed: number }> = [];
    const run = session({
      on: true,
      install: true,
      delayMs: 60,
      gain: 0.6,
      seed: 31,
      probe: ({ delivered }) => {
        if (delivered > (10.09 + 0.2) * 1000 && delivered < (10.09 + 0.23) * 1000) {
          const d = liveOf.current?.diagnostics();
          if (d) early.push({ cancelled: d.cancelledFrames, passed: d.passedFrames });
        }
      },
      onLive: (live) => {
        liveOf.current = live;
      },
    });
    expect(early.length).toBeGreaterThan(0);
    for (const e of early) expect(e.cancelled).toBe(0);
    expect(early.at(-1)!.passed).toBeGreaterThan(0);
    // and once the filter is trusted the frames are cancelled again
    expect(run.live.diagnostics().cancelledFrames).toBeGreaterThan(100);
  });

  it("the residual suppressor is off by default and, when asked for, takes more of her voice out", () => {
    const room = { delayMs: 60, gain: 0.6, seed: 31 };
    const base = session({ on: true, install: true, ...room });
    expect(base.live.diagnostics().canceller?.suppressionDb).toBe(0);
    const plain = settledPower(base.echoStart, base.seconds);
    const lowered = session({ on: true, install: true, suppressor: true, ...room });
    // at least 6 dB (a factor of four in power) below the plain canceller over the settled second half
    expect(settledPower(lowered.echoStart, lowered.seconds)).toBeLessThan(plain / 4);
  });

  it("keeps the owner's own voice when it talks over her (double talk is not removed)", () => {
    // The owner talks from 2.8 s after her echo begins, for 2 s, while she is still speaking (the room delay is 60 ms).
    const voice = speech48(2, 77);
    const near = new Float32Array(48_000 * 12);
    const at0 = Math.round((10.0 + 0.03 + 0.06 - 7.5 + 2.8) * 48_000);
    for (let i = 0; i < voice.length; i += 1) near[at0 + i] = voice[i]! * 0.5;
    const window = (): Float32Array => {
      const from = (7.5 + 0.012 + (at0 + 24_000) / 48_000) * 1000;
      const a = preRollFrom(from);
      const b = preRollFrom(from + 1000);
      return a.subarray(0, a.length - b.length);
    };
    const room = { delayMs: 60, gain: 0.4, seed: 41 };
    session({ on: true, install: true, delayMs: 60, gain: 0, seed: 41, nearEnd: near });
    const ownerAlone = rmsOf(window());
    session({ on: false, install: true, ...room, nearEnd: near });
    const mixedRaw = rmsOf(window());
    const on = session({ on: true, install: true, ...room, nearEnd: near });
    const mixedClean = rmsOf(window());
    expect(on.live.diagnostics().cancelledFrames).toBeGreaterThan(100);
    expect(ownerAlone).toBeGreaterThan(0.02);
    // what is left is the owner's voice, not silence and not more than was there
    expect(mixedClean).toBeGreaterThan(ownerAlone * 0.6);
    expect(mixedClean).toBeLessThan(mixedRaw);
  });
});

describe("memory is cleared and never leaves the page", () => {
  const playedFor = (
    clock: { ms: number },
    live: EchoLive,
    player: PcmClipPlayer,
    frames: number,
  ) => {
    player.start(new Int16Array(24_000).fill(4000), 24_000);
    for (let i = 0; i < frames; i += 1) {
      clock.ms += 2.667;
      noteCaptureFrame(new Float32Array(128).fill(0.01), clock.ms, 48_000);
    }
    return live;
  };
  const rig = (enabled = () => true) => {
    const clock = { ms: 20_000 };
    const player = newPlayer(clock);
    const live = new EchoLive({ enabled, nowMs: () => clock.ms });
    live.attach(player);
    markWorklet(true);
    return { clock, player, live };
  };
  const chunks = (live: EchoLive) => live.diagnostics().reference?.chunks ?? -1;

  it("a stop cuts the tail at once and drops the reference after the room's tail", () => {
    const { clock, player, live } = rig();
    playedFor(clock, live, player, 10);
    expect(chunks(live)).toBe(1);
    player.stop();
    expect(chunks(live)).toBe(1); // the room still returns what was just played
    clock.ms += (STOP_HOLD_S + 0.2) * 1000;
    noteCaptureFrame(new Float32Array(128).fill(0.01), clock.ms, 48_000);
    expect(chunks(live)).toBe(0);
    expect(live.diagnostics().lastClear).toBe("stopped");
  });

  it("a stop with no capture running clears at once", () => {
    const { clock, player, live } = rig();
    markWorklet(false);
    playedFor(clock, live, player, 0);
    expect(chunks(live)).toBe(1);
    player.stop();
    expect(chunks(live)).toBe(0);
  });

  it("a new answer right after a stop keeps its reference", () => {
    const { clock, player, live } = rig();
    playedFor(clock, live, player, 5);
    player.stop();
    clock.ms += 300;
    playedFor(clock, live, player, 5);
    clock.ms += (STOP_HOLD_S + 0.2) * 1000;
    player.start(new Int16Array(24_000).fill(4000), 24_000);
    noteCaptureFrame(new Float32Array(128).fill(0.01), clock.ms, 48_000);
    expect(chunks(live)).toBeGreaterThan(0);
  });

  it("leaving Auto (the microphone closes) clears the reference, the canceller and the microphone state", () => {
    const { clock, player, live } = rig();
    playedFor(clock, live, player, 30);
    expect(chunks(live)).toBe(1);
    markWorklet(false);
    expect(chunks(live)).toBe(0);
    expect(live.diagnostics().lastClear).toBe("microphone closed");
    expect(live.diagnostics().canceller?.processedSamples).toBe(0);
  });

  it("turning the setting off clears it on the next chunk or frame", () => {
    let on = true;
    const { clock, player, live } = rig(() => on);
    playedFor(clock, live, player, 5);
    on = false;
    noteCaptureFrame(new Float32Array(128).fill(0.01), clock.ms + 3, 48_000);
    expect(chunks(live)).toBe(0);
    expect(live.diagnostics().lastClear).toBe("setting off");
  });

  it("five seconds without playback drops it", () => {
    const { clock, player, live } = rig();
    playedFor(clock, live, player, 5);
    clock.ms += (IDLE_CLEAR_S + 2.5) * 1000;
    noteCaptureFrame(new Float32Array(128).fill(0.01), clock.ms, 48_000);
    expect(chunks(live)).toBe(0);
    expect(live.diagnostics().lastClear).toBe("idle");
  });

  it("detach and dispose forget everything and give the capture back", () => {
    const { clock, player, live } = rig();
    playedFor(clock, live, player, 5);
    live.detach();
    expect(captureProcessorInstalled()).toBe(false);
    expect(live.diagnostics()).toMatchObject({ attached: false, reference: null, canceller: null });
    player.dispose();
  });

  it("source pins: nothing is persisted or sent anywhere but the one measurement chunk", () => {
    const live = read("src/lib/friday/voice-engine/echo-live.ts");
    expect(live).not.toMatch(
      /localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|writeFile/,
    );
    expect(live).not.toMatch(/ipcRenderer|window\.friday\.(?!echoShadow)/);
    // the only outgoing call, and the only fields it carries
    expect(live.match(/send\(\{/g)).toHaveLength(1);
    expect(live).toMatch(
      /mic: pcm16ToBase64\(floatToPcm16\(shadow\.buf\)\),\s*ref: pcm16ToBase64\(ref\),\s*seq: shadow\.seq,/,
    );
    const lib = read("src/lib/friday/voice-library.ts");
    expect(lib).toMatch(/echoLive\.attach\(created\)/);
    expect(lib).toMatch(/echoLive\.detach\(\)/);
    const capture = read("src/lib/friday/pcm-capture.ts");
    expect(capture).toMatch(/if \(!on && processor\) \{[\s\S]*processor\.clear\(\)/);
    const gate = read("src/lib/friday/voice-audio.ts");
    expect(gate).toMatch(/const cleaned = cleanedLevel\(performance\.now\(\)\)/);
    expect(gate).toMatch(/setCaptureLatency\(/);
  });
});

describe("measurement: one 160 ms chunk, at most once per 160 ms, local only", () => {
  const withShadow = (
    on: boolean,
    reply: Awaited<ReturnType<EchoShadowSend>> | null = {
      ok: true,
      ready: true,
      reductionDb: 23.5,
      delayMs: 62,
    },
  ) => {
    const calls: Array<{ mic: string; ref?: string; reset?: boolean; seq?: number; at: number }> =
      [];
    const clockRef = { ms: 0 };
    const shadow: EchoShadowSend = (payload) => {
      calls.push({ ...payload, at: clockRef.ms });
      return reply ?? { ok: false, reason: "no answer" };
    };
    const out = session({
      on,
      install: true,
      delayMs: 60,
      gain: 0.6,
      seed: 31,
      shadow,
      clock: clockRef,
    });
    return { calls, out };
  };

  it("sends nothing when the setting is off", () => {
    const { calls, out } = withShadow(false);
    expect(calls).toHaveLength(0);
    expect(out.live.diagnostics().shadowSent).toBe(0);
  });

  it("sends chunks of exactly 160 ms with their reference, never more often than every 160 ms", async () => {
    const { calls, out } = withShadow(true);
    await Promise.resolve();
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(Object.keys(call).sort()).toEqual(
        call.reset ? ["at", "mic", "ref", "reset", "seq"] : ["at", "mic", "ref", "seq"],
      );
      const bytes = (b64: string) => Buffer.from(b64, "base64").length;
      expect(bytes(call.mic)).toBe(SHADOW_CHUNK * 2);
      expect(bytes(call.ref!)).toBe(SHADOW_CHUNK * 2);
    }
    expect(calls[0]!.reset).toBe(true);
    expect(calls.slice(1).some((c) => c.reset)).toBe(false);
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i]!.seq).toBeGreaterThan(calls[i - 1]!.seq!);
      expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(160);
    }
    expect(out.live.diagnostics()).toMatchObject({
      reductionDb: 23.5,
      delayMs: 62,
      shadowReady: true,
    });
  });

  it("while she is silent no chunk is sent", () => {
    const calls: unknown[] = [];
    const clock = { ms: 1000 };
    const live = new EchoLive({
      enabled: () => true,
      nowMs: () => clock.ms,
      shadow: () => (p) => (calls.push(p), { ok: true }),
    });
    live.attach(newPlayer(clock));
    markWorklet(true);
    for (let i = 0; i < 400; i += 1) {
      clock.ms += 2.667;
      noteCaptureFrame(new Float32Array(128).fill(0.02), clock.ms, 48_000);
    }
    expect(calls).toHaveLength(0);
  });

  it("a refusal or a thrown error is a note, never a failure of the audio", async () => {
    const refused = withShadow(true, { ok: false, reason: "pyaec-missing", ready: false });
    await Promise.resolve();
    expect(refused.out.live.diagnostics()).toMatchObject({
      reductionDb: null,
      shadowReason: "pyaec-missing",
    });
    const clock = { ms: 0 };
    const live = new EchoLive({
      enabled: () => true,
      nowMs: () => clock.ms,
      shadow: () => () => {
        throw new Error("ipc closed");
      },
    });
    live.attach(newPlayer(clock));
    markWorklet(true);
    (live as unknown as { player: PcmClipPlayer }).player.start(
      new Int16Array(48_000).fill(4000),
      24_000,
    );
    expect(() => {
      for (let i = 0; i < 1500; i += 1) {
        clock.ms += 2.667;
        noteCaptureFrame(new Float32Array(128).fill(0.02), clock.ms, 48_000);
      }
    }).not.toThrow();
  });
});
