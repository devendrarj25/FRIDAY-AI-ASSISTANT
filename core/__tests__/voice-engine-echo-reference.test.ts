import { describe, expect, it, vi } from "vitest";
import { EchoCanceller } from "../../src/lib/friday/voice-engine/audio-aec";
import {
  floatToPcm16,
  pcm16ToFloat,
  StreamSincResampler,
} from "../../src/lib/friday/voice-engine/audio-format";
import {
  cancelMicFrame,
  contextLatencySeconds,
  ECHO_RATE,
  EchoReference,
  LIVE_MARGIN_MS,
  echoReferenceForMicFrame,
  micFrameStartTime,
} from "../../src/lib/friday/voice-engine/echo-reference";
import {
  PcmPlayback,
  type ContextLike,
} from "../../src/lib/friday/voice-engine/playback-scheduler";

/** Deterministic noise so every run, on every machine, sees the same signal. */
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

const decimate = (x: Float32Array, by: number): Float32Array =>
  Float32Array.from({ length: Math.floor(x.length / by) }, (_, i) => x[i * by]!);

const rms = (x: ArrayLike<number>, from = 0, to = x.length): number => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += Number(x[i]) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};
const db = (num: number, den: number): number =>
  20 * Math.log10(Math.max(num, 1e-12) / Math.max(den, 1e-12));

/** Offset (in samples) at which `a` best matches `b`, searched within +-`range`. */
function bestLag(a: ArrayLike<number>, b: ArrayLike<number>, range: number): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = -range; lag <= range; lag += 1) {
    let dot = 0;
    for (let i = range; i < a.length - range; i += 1) dot += Number(a[i + lag]) * Number(b[i]);
    if (dot > bestScore) {
      bestScore = dot;
      best = lag;
    }
  }
  return best;
}

const chunk16 = (x: Float32Array, from: number, len: number): Int16Array =>
  floatToPcm16(x.subarray(from, from + len));

describe("echo reference: placement on the audio clock", () => {
  it("puts a chunk where the speaker plays it: stamp plus output latency", () => {
    const ref = new EchoReference({ latencySeconds: 0.05 });
    const pcm = floatToPcm16(Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 7) * 0.5));
    ref.tap(1.0, pcm, ECHO_RATE);
    expect(Array.from(ref.alignedReference(1.05, 1600))).toEqual(Array.from(pcm));
    // Before the speaker emits it, and long after, the reference is silence.
    expect(rms(ref.alignedReference(1.0, 800))).toBe(0);
    expect(rms(ref.alignedReference(1.2, 800))).toBe(0);
    // A frame that straddles the start sees zeros then the chunk.
    const straddle = ref.alignedReference(1.05 - 100 / ECHO_RATE, 200);
    expect(rms(straddle, 0, 100)).toBe(0);
    expect(Array.from(straddle.subarray(100))).toEqual(Array.from(pcm.subarray(0, 100)));
  });

  it("reads the output latency at every chunk, so a latency that changes is followed", () => {
    let latency = 0.04;
    const ref = new EchoReference({ latencySeconds: () => latency });
    const a = floatToPcm16(Float32Array.from({ length: 800 }, () => 0.3));
    ref.tap(2.0, a);
    latency = 0.06;
    const b = floatToPcm16(Float32Array.from({ length: 800 }, () => -0.3));
    ref.tap(2.5, b);
    expect(ref.alignedReference(2.04, 10)[0]).toBe(a[0]);
    expect(ref.alignedReference(2.56, 10)[0]).toBe(b[0]);
    expect(rms(ref.alignedReference(2.54, 10))).toBe(0);
  });

  it("reads the reference later by the safety margin so the echo delay stays positive", () => {
    const ref = new EchoReference({ marginMs: 20 });
    const pcm = floatToPcm16(Float32Array.from({ length: 800 }, () => 0.4));
    ref.tap(1.0, pcm);
    expect(ref.alignedReference(0.97, 10)[0]).toBe(0);
    expect(ref.alignedReference(0.98, 10)[0]).toBe(pcm[0]);
  });

  it("gives zeros when there is nothing: no chunk, a bad time, a bad length", () => {
    const ref = new EchoReference();
    expect(Array.from(ref.alignedReference(1, 4))).toEqual([0, 0, 0, 0]);
    ref.tap(0.5, new Int16Array(1600).fill(3000));
    expect(ref.alignedReference(Number.NaN, 4)).toHaveLength(4);
    expect(rms(ref.alignedReference(Number.NaN, 4))).toBe(0);
    expect(ref.alignedReference(1, 0)).toHaveLength(0);
    expect(ref.alignedReference(1, -5)).toHaveLength(0);
    expect(ref.alignedReference(1, 2.5)).toHaveLength(0);
    expect(ref.alignedReference(-3, 4)).toHaveLength(4);
  });

  it("never throws: empty, non-finite or failing input is counted and ignored", () => {
    const ref = new EchoReference({
      latencySeconds: () => {
        throw new Error("no latency");
      },
    });
    ref.tap(Number.NaN, new Int16Array(10).fill(1));
    ref.tap(1, new Int16Array(0));
    ref.tap(1, new Int16Array(10).fill(1), 0);
    ref.tap(1, new Int16Array(10).fill(1), Number.POSITIVE_INFINITY);
    expect(ref.stats().ignored).toBe(4);
    ref.tap(1, new Int16Array(800).fill(2000)); // a failing latency reads as zero
    expect(ref.alignedReference(1, 4)[0]).toBe(2000);
  });

  it("resamples a 24 kHz answer to 16 kHz and keeps it aligned across odd chunk sizes", () => {
    const x48 = speech48(3, 11);
    const x24 = decimate(x48, 2);
    const x16 = decimate(x48, 3);
    const ref = new EchoReference();
    const context = { t: 1.0 };
    // The same chunking a realtime provider produces: odd sizes, scheduled back to back.
    const sizes = [1000, 777, 2400, 513, 1999, 3001];
    let at = 0;
    let k = 0;
    while (at < x24.length) {
      const len = Math.min(sizes[k % sizes.length]!, x24.length - at);
      ref.tap(context.t + at / 24_000, floatToPcm16(x24.subarray(at, at + len)), 24_000);
      at += len;
      k += 1;
    }
    const total = 2.5 * ECHO_RATE;
    const got = pcm16ToFloat(ref.alignedReference(1.0 + 0.2, total));
    const want = x16.subarray(Math.round(0.2 * ECHO_RATE), Math.round(0.2 * ECHO_RATE) + total);
    const err = Float32Array.from(got, (v, i) => v - want[i]!);
    const snr = db(rms(want, 200, total - 200), rms(err, 200, total - 200));
    expect(bestLag(got, want, 20)).toBe(0);
    expect(snr).toBeGreaterThan(25);
    expect(ref.stats().resyncs).toBe(0);
    expect(ref.stats().forcedResyncs).toBe(0);
  });
});

describe("echo reference: drift and resync", () => {
  /** One burst of speech then a pause, in 100 ms chunks whose stamps run `scale` times the true clock. */
  function drifting(scale: number, bursts: number) {
    const x48 = speech48(1.0, 5);
    const burst = decimate(x48, 3);
    const ref = new EchoReference();
    const placedAt: { stamp: number; chunk: Int16Array }[] = [];
    let k = 0;
    for (let b = 0; b < bursts; b += 1) {
      for (let c = 0; c < 12; c += 1) {
        // 10 chunks of speech, then 2 of silence (a 200 ms pause between sentences).
        const pcm =
          c < 10 ? chunk16(burst, (c * 1600) % (burst.length - 1600), 1600) : new Int16Array(1600);
        const stamp = 1.0 + k * 0.1 * scale;
        ref.tap(stamp, pcm);
        if (c < 10) placedAt.push({ stamp, chunk: pcm });
        k += 1;
      }
    }
    return { ref, placedAt };
  }

  it("follows a clock that runs 0.2 percent slow without a jump inside a word, then resyncs in the pause", () => {
    const { ref, placedAt } = drifting(1.002, 6);
    const stats = ref.stats();
    expect(stats.forcedResyncs).toBe(0); // never a jump in the middle of speech
    expect(stats.resyncs).toBeGreaterThanOrEqual(3); // the pauses pulled it back
    // After the last pause the reference sits on the stamp: the last speech chunk is exactly where it was said.
    const last = placedAt[placedAt.length - 1]!;
    const got = ref.alignedReference(last.stamp, 1600);
    const lag = bestLag(pcm16ToFloat(got), pcm16ToFloat(last.chunk), 80);
    expect(Math.abs(lag)).toBeLessThanOrEqual(32); // within the 2 ms seamless tolerance, at the end of a 1 s word
  });

  it("carries a small disagreement through speech and reports it", () => {
    const x16 = decimate(speech48(2, 3), 3);
    const ref = new EchoReference();
    ref.tap(1.0, chunk16(x16, 4000, 3200));
    ref.tap(1.2 + 0.02, chunk16(x16, 7200, 3200)); // stamp 20 ms late, both sides audible
    const s = ref.stats();
    expect(s.pendingDriftMs).toBeGreaterThan(15);
    expect(s.resyncs).toBe(0);
    // Seamless: the second chunk starts right where the first ended.
    const seam = ref.alignedReference(1.2 - 4 / ECHO_RATE, 8);
    const want = Array.from(chunk16(x16, 4000 + 3200 - 4, 4)).concat(
      Array.from(chunk16(x16, 7200, 4)),
    );
    expect(Array.from(seam)).toEqual(want);
  });

  it("follows a stamp at a silent boundary at once", () => {
    const ref = new EchoReference();
    ref.tap(1.0, new Int16Array(1600).fill(4000));
    ref.tap(1.1 + 0.03, new Int16Array(1600).fill(0)); // silent chunk, stamp 30 ms late
    ref.tap(1.2 + 0.03, new Int16Array(1600).fill(-4000));
    const s = ref.stats();
    expect(s.resyncs).toBeGreaterThanOrEqual(1);
    expect(s.forcedResyncs).toBe(0);
    expect(ref.alignedReference(1.23, 4)[0]).toBe(-4000);
    expect(ref.alignedReference(1.23 - 1 / ECHO_RATE, 1)[0]).toBe(0);
  });

  it("forces a jump when the disagreement is large even in the middle of speech", () => {
    const ref = new EchoReference();
    ref.tap(1.0, new Int16Array(1600).fill(4000));
    ref.tap(1.1 + 0.08, new Int16Array(1600).fill(-4000)); // 80 ms late: an underrun, not drift
    expect(ref.stats().forcedResyncs).toBe(1);
    expect(ref.alignedReference(1.18, 4)[0]).toBe(-4000);
    expect(ref.alignedReference(1.12, 4)[0]).toBe(0); // the gap is silence
  });

  it("truncate drops what was never heard after a flush", () => {
    const ref = new EchoReference();
    ref.tap(1.0, new Int16Array(16_000).fill(5000)); // one second scheduled
    ref.truncate(1.25); // cut after 250 ms
    expect(ref.alignedReference(1.2, 4)[0]).toBe(5000);
    expect(rms(ref.alignedReference(1.3, 100))).toBe(0);
    ref.tap(2.0, new Int16Array(1600).fill(-5000)); // the next answer is clean
    expect(ref.alignedReference(2.0, 4)[0]).toBe(-5000);
  });
});

describe("echo reference: bounded memory", () => {
  it("holds one fixed ring however long and however loud the playback runs", () => {
    const ref = new EchoReference({ maxSeconds: 4 });
    const before = ref.stats().capacitySamples;
    const pcm = new Int16Array(1600).fill(1200);
    for (let k = 0; k < 6000; k += 1) ref.tap(k * 0.1, pcm); // ten minutes
    expect(ref.stats().capacitySamples).toBe(before);
    expect(before).toBe(4 * ECHO_RATE);
    // A chunk longer than the ring keeps its newest part; the older part is gone, not buffered.
    const long = new Int16Array(30 * ECHO_RATE);
    for (let i = 0; i < long.length; i += 1) long[i] = i % 30_000;
    ref.tap(1000, long);
    expect(ref.stats().capacitySamples).toBe(before);
    expect(rms(ref.alignedReference(1000, 100))).toBe(0);
    const tailStart = 30 * ECHO_RATE - 4 * ECHO_RATE;
    expect(ref.alignedReference(1000 + 29, 1)[0]).toBe(long[29 * ECHO_RATE]);
    expect(ref.alignedReference(1000 + tailStart / ECHO_RATE, 1)[0]).toBe(long[tailStart]);
    expect(ref.alignedReference(1, 1_000_000)).toHaveLength(before); // a read is bounded too
  });

  it("returns zeros for a stretch older than the ring", () => {
    const ref = new EchoReference({ maxSeconds: 2 });
    ref.tap(1.0, new Int16Array(1600).fill(7000));
    for (let k = 1; k < 40; k += 1) ref.tap(1.0 + k * 0.1, new Int16Array(1600).fill(100));
    expect(rms(ref.alignedReference(1.0, 100))).toBe(0);
  });
});

describe("echo reference: live-capture hook", () => {
  it("places a microphone frame by when it was delivered, less its length and the input latency", () => {
    const t = { deliveredAt: 5.0, frameLen: 320, inputLatencySeconds: 0.01 };
    expect(micFrameStartTime(t)).toBeCloseTo(5.0 - 0.02 - 0.01, 9);
    expect(micFrameStartTime({ deliveredAt: 5, frameLen: 320 })).toBeCloseTo(4.98, 9);
    expect(contextLatencySeconds({ outputLatency: 0.04, baseLatency: 0.01 })).toBe(0.04);
    expect(contextLatencySeconds({ outputLatency: 0, baseLatency: 0.01 })).toBe(0.01);
    expect(contextLatencySeconds({})).toBe(0);
  });

  it("returns no reference when nothing plays, and the frame itself untouched", () => {
    const ref = new EchoReference();
    const timing = { deliveredAt: 3, frameLen: 320 };
    expect(echoReferenceForMicFrame(ref, timing)).toBeNull();
    const mic = Float32Array.from({ length: 320 }, (_, i) => Math.sin(i / 9) * 0.2);
    const echo = new EchoCanceller({ rate: ECHO_RATE });
    expect(cancelMicFrame(ref, echo, mic, { deliveredAt: 3 })).toBe(mic);
    expect(echo.nextNearIndex()).toBeNull(); // nothing was processed, nothing learned
    ref.tap(10, new Int16Array(1600).fill(4000));
    expect(
      echoReferenceForMicFrame(ref, { deliveredAt: 10 + 320 / ECHO_RATE, frameLen: 320 }),
    ).not.toBeNull();
  });

  it("is never a risk to the audio path: a failing canceller returns the microphone frame", () => {
    const ref = new EchoReference();
    ref.tap(1, new Int16Array(3200).fill(4000));
    const mic = new Float32Array(320).fill(0.1);
    const broken = {
      nextNearIndex: () => null,
      processWithReference: () => {
        throw new Error("boom");
      },
    };
    expect(cancelMicFrame(ref, broken, mic, { deliveredAt: 1 + 320 / ECHO_RATE })).toBe(mic);
  });

  it("a canceller that failed five frames in a row hands back every frame as it came in", () => {
    const ref = new EchoReference();
    ref.tap(1, new Int16Array(16_000).fill(4000));
    const echo = new EchoCanceller({ rate: ECHO_RATE });
    const spy = vi.spyOn(echo as unknown as { far: () => number }, "far").mockImplementation(() => {
      throw new Error("ring failed");
    });
    const mic = Float32Array.from({ length: 320 }, (_, i) => Math.sin(i / 9) * 0.2);
    for (let n = 0; n < 8; n += 1) {
      const out = cancelMicFrame(ref, echo, mic, { deliveredAt: 1 + ((n + 1) * 320) / ECHO_RATE });
      expect(Array.from(out)).toEqual(Array.from(mic));
    }
    expect(echo.isPassthrough()).toBe(true);
    expect(echo.stats().failures).toBe(5);
    spy.mockRestore();
  });

  it("without a reference the canceller behaves exactly as before", () => {
    const rand = rng(9);
    const near = Float32Array.from({ length: 6400 }, () => rand() * 0.4);
    const a = new EchoCanceller({ rate: ECHO_RATE });
    const b = new EchoCanceller({ rate: ECHO_RATE });
    for (let at = 0; at < near.length; at += 320) {
      const frame = near.subarray(at, at + 320);
      expect(Array.from(a.processWithReference(frame, null, at))).toEqual(
        Array.from(b.process(frame, at)),
      );
      expect(Array.from(a.processWithReference(frame, new Float32Array(0)))).toEqual(
        Array.from(b.process(frame)),
      );
    }
    expect(a.stats().processedSamples).toBe(b.stats().processedSamples);
  });
});

/** A fake audio context: the clock is a number the test moves. */
function fakeContext(clock: { now: number }): ContextLike {
  return {
    get currentTime() {
      return clock.now;
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
  };
}

function room(delayMs: number, gain: number, seed: number) {
  const delay = Math.round((delayMs / 1000) * ECHO_RATE);
  const rand = rng(seed);
  const h = new Float32Array(200);
  for (let k = 0; k < h.length; k += 1)
    h[k] = gain * Math.exp(-k / 30) * (k === 0 ? 1 : rand() * 1.6);
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

describe("echo reference: end to end on simulated rooms (not a real room)", () => {
  /**
   * The speaker plays an answer through the real scheduler (24 kHz chunks), the tap hears every chunk, the room
   * makes an echo, and the microphone frames are cleaned through the live hook. Returns the reduction of the
   * echo power over the settled second half, in dB.
   */
  function simulate(opts: {
    sourceRate: 16_000 | 24_000;
    delayMs: number;
    gain: number;
    seed: number;
  }): number {
    const seconds = 5;
    const x48 = speech48(seconds, opts.seed);
    const x16 = decimate(x48, 3);
    const src = opts.sourceRate === 16_000 ? x16 : decimate(x48, 2);
    const outputLatency = 0.03;
    const inputLatency = 0.012;
    const clock = { now: 1.0 };
    const reference = new EchoReference({
      latencySeconds: outputLatency,
      marginMs: LIVE_MARGIN_MS,
    });
    const playback = new PcmPlayback(fakeContext(clock), {
      rate: opts.sourceRate,
      maxQueuedMs: 60_000,
    });
    let firstWhen = -1;
    playback.onScheduled((when, pcm) => {
      if (firstWhen < 0) firstWhen = when;
      reference.tap(when, pcm, opts.sourceRate);
    });
    const chunk = Math.round(opts.sourceRate * 0.1);
    for (let at = 0; at < src.length; at += chunk)
      playback.enqueue(floatToPcm16(src.subarray(at, Math.min(src.length, at + chunk))));
    // What the speaker really emits: x16 starting at firstWhen + outputLatency, on the 16 kHz timeline.
    const emitIndex = Math.round((firstWhen + outputLatency) * ECHO_RATE);
    const total = emitIndex + x16.length + ECHO_RATE;
    const emitted = new Float32Array(total);
    emitted.set(x16, emitIndex);
    const echoOnly = room(opts.delayMs, opts.gain, 7)(emitted, total);
    const echo = new EchoCanceller({ rate: ECHO_RATE });
    const frameLen = 320;
    const firstFrame = Math.floor(emitIndex / frameLen) * frameLen;
    const cleanedEnergy: number[] = [];
    const rawEnergy: number[] = [];
    const settledFrom = firstFrame + Math.round(2.5 * ECHO_RATE);
    for (let at = firstFrame; at + frameLen <= emitIndex + x16.length; at += frameLen) {
      const mic = echoOnly.subarray(at, at + frameLen);
      const deliveredAt = (at + frameLen) / ECHO_RATE + inputLatency;
      const out = cancelMicFrame(reference, echo, mic, {
        deliveredAt,
        inputLatencySeconds: inputLatency,
      });
      if (at >= settledFrom) {
        rawEnergy.push(rms(mic) ** 2);
        cleanedEnergy.push(rms(out) ** 2);
      }
    }
    const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
    return 10 * Math.log10(sum(rawEnergy) / Math.max(sum(cleanedEnergy), 1e-12));
  }

  it.each([
    [
      "16 kHz answer, 40 ms path",
      { sourceRate: 16_000 as const, delayMs: 40, gain: 0.6, seed: 21 },
    ],
    [
      "24 kHz answer, 90 ms path",
      { sourceRate: 24_000 as const, delayMs: 90, gain: 0.6, seed: 22 },
    ],
    [
      "24 kHz answer, 160 ms path",
      { sourceRate: 24_000 as const, delayMs: 160, gain: 0.5, seed: 23 },
    ],
  ])("takes at least 22 dB out of the echo: %s", (_name, opts) => {
    const reduction = simulate(opts);
    expect(reduction).toBeGreaterThanOrEqual(22);
  });
});

describe("band-limited resampler used for the reference", () => {
  const tone = (hz: number, rate: number, n: number): Float32Array =>
    Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));

  it("keeps a 1 kHz tone at full level and on the same timeline, whatever the frame sizes", () => {
    const whole = new StreamSincResampler(24_000, 16_000).push(tone(1000, 24_000, 24_000));
    const parts = new StreamSincResampler(24_000, 16_000);
    const pieces: number[] = [];
    for (const size of [100, 777, 1, 4000, 19_122])
      pieces.push(...parts.push(tone(1000, 24_000, size)));
    expect(whole.length).toBeGreaterThan(15_950);
    const want = tone(1000, 16_000, whole.length);
    const err = Float32Array.from(whole, (v, i) => v - want[i]!);
    expect(
      db(rms(want, 100, whole.length - 100), rms(err, 100, whole.length - 100)),
    ).toBeGreaterThan(40);
    expect(pieces.length).toBeGreaterThan(15_000);
  });

  it("splits into the same samples as one push", () => {
    const x = speech48(1, 4);
    const x24 = decimate(x, 2);
    const whole = new StreamSincResampler(24_000, 16_000).push(x24);
    const split = new StreamSincResampler(24_000, 16_000);
    const out: number[] = [];
    for (let at = 0; at < x24.length; at += 333)
      out.push(...split.push(x24.subarray(at, at + 333)));
    expect(out.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 97) expect(out[i]).toBeCloseTo(whole[i]!, 6);
  });

  it("removes what would fold back below the new Nyquist", () => {
    const out = new StreamSincResampler(24_000, 16_000).push(tone(10_000, 24_000, 24_000));
    expect(db(0.35, rms(out, 200, out.length - 200))).toBeGreaterThan(40);
  });

  it("passes equal rates through and rejects a bad rate", () => {
    expect(Array.from(new StreamSincResampler(16_000, 16_000).push([0.25, -0.5]))).toEqual([
      0.25, -0.5,
    ]);
    expect(() => new StreamSincResampler(0, 16_000)).toThrow();
    expect(new StreamSincResampler(24_000, 16_000).push([]).length).toBe(0);
  });

  it("upsamples without a gap", () => {
    const out = new StreamSincResampler(16_000, 24_000).push(tone(500, 16_000, 16_000));
    expect(out.length).toBeGreaterThan(23_900);
    const want = tone(500, 24_000, out.length);
    const err = Float32Array.from(out, (v, i) => v - want[i]!);
    expect(db(rms(want, 100, out.length - 100), rms(err, 100, out.length - 100))).toBeGreaterThan(
      40,
    );
  });
});
