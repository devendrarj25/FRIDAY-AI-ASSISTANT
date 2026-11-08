import { describe, expect, it } from "vitest";
import { EchoCanceller } from "../../src/lib/friday/voice-engine/audio-aec";

const RATE = 16_000;

/** Deterministic noise so the test is the same on every machine. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

/** Speech-like far end: noise with a syllable-rate loudness envelope and pauses. */
function farEnd(seconds: number, seed = 1): Float32Array {
  const rand = rng(seed);
  const n = seconds * RATE;
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const env =
      Math.max(0, Math.sin(2 * Math.PI * 3.2 * t)) *
      (Math.sin(2 * Math.PI * 0.4 * t) > -0.6 ? 1 : 0);
    lp = lp * 0.55 + rand() * 0.9; // a little colour, like a voice
    out[i] = lp * env * 0.9;
  }
  return out;
}

/** A room: a delay and a decaying, mixed-sign response. */
function room(delayMs: number, gain = 0.6) {
  const delay = Math.round((delayMs / 1000) * RATE);
  const h = new Float32Array(200);
  const rand = rng(7);
  for (let k = 0; k < h.length; k += 1)
    h[k] = gain * Math.exp(-k / 30) * (k === 0 ? 1 : rand() * 1.6);
  return (far: Float32Array): Float32Array => {
    const out = new Float32Array(far.length);
    for (let i = 0; i < far.length; i += 1) {
      let acc = 0;
      for (let k = 0; k < h.length; k += 1) {
        const j = i - delay - k;
        if (j >= 0) acc += h[k]! * far[j]!;
      }
      out[i] = acc;
    }
    return out;
  };
}

function run(echo: EchoCanceller, far: Float32Array, near: Float32Array, frame = 320) {
  echo.pushReference(0, far);
  const out = new Float32Array(near.length);
  for (let at = 0; at < near.length; at += frame)
    out.set(echo.process(near.subarray(at, at + frame), at), at);
  return out;
}

const power = (a: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i += 1) s += a[i]! * a[i]!;
  return s / Math.max(1, to - from);
};
const db = (ratio: number) => 10 * Math.log10(ratio);

describe("echo canceller (simulated rooms only)", () => {
  it("finds a 90 ms bulk delay and removes most of the echo", () => {
    const far = farEnd(8);
    const near = room(90)(far);
    const echo = new EchoCanceller({ rate: RATE });
    const out = run(echo, far, near);
    const last = { from: 6 * RATE, to: 8 * RATE };
    const erle = db(power(near, last.from, last.to) / power(out, last.from, last.to));
    expect(erle).toBeGreaterThan(15);
    expect(Math.abs(echo.stats().delayMs - 90)).toBeLessThan(40);
    expect(echo.stats().erleDb).not.toBeNull();
  });

  it("copes with a long delay of 250 ms", () => {
    const far = farEnd(9, 3);
    const near = room(250, 0.5)(far);
    const out = run(new EchoCanceller({ rate: RATE }), far, near);
    expect(db(power(near, 7 * RATE, 9 * RATE) / power(out, 7 * RATE, 9 * RATE))).toBeGreaterThan(
      12,
    );
  });

  it("keeps the owner's voice while she is talking over the echo (double talk)", () => {
    const far = farEnd(10, 5);
    const echoOnly = room(70)(far);
    const talk = new Float32Array(far.length);
    for (let i = 6 * RATE; i < 9 * RATE; i += 1)
      talk[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    const near = Float32Array.from(echoOnly, (v, i) => v + talk[i]!);
    const echo = new EchoCanceller({ rate: RATE });
    const out = run(echo, far, near);
    // while she talks, her tone must survive at close to full strength
    const kept = power(out, 6.5 * RATE, 8.5 * RATE) / power(talk, 6.5 * RATE, 8.5 * RATE);
    expect(kept).toBeGreaterThan(0.6);
    expect(kept).toBeLessThan(1.8);
    expect(echo.stats().doubleTalkFrames).toBeGreaterThan(0);
    // before she talked, the echo was already low
    expect(db(power(near, 4 * RATE, 6 * RATE) / power(out, 4 * RATE, 6 * RATE))).toBeGreaterThan(
      12,
    );
  });

  it("passes a microphone with no playback through unchanged", () => {
    const near = Float32Array.from(
      { length: 2 * RATE },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / RATE),
    );
    const out = run(new EchoCanceller({ rate: RATE }), new Float32Array(0), near);
    expect(power(out, 0, near.length)).toBeCloseTo(power(near, 0, near.length), 6);
  });

  it("does not learn the owner's voice as echo when nothing is playing", () => {
    const echo = new EchoCanceller({ rate: RATE });
    const near = Float32Array.from(
      { length: 3 * RATE },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 200 * i) / RATE),
    );
    const out = run(echo, new Float32Array(0), near);
    expect(power(out, 2 * RATE, 3 * RATE) / power(near, 2 * RATE, 3 * RATE)).toBeGreaterThan(0.95);
    expect(echo.stats().erleDb).toBeNull();
  });

  it("never makes the signal louder than it came in, and can be reset", () => {
    const far = farEnd(4, 9);
    const near = room(40)(far);
    const echo = new EchoCanceller({ rate: RATE });
    const out = run(echo, far, near);
    expect(power(out, 0, out.length)).toBeLessThan(power(near, 0, near.length) * 1.01);
    echo.reset();
    expect(echo.stats()).toMatchObject({ delayMs: 0, erleDb: null, processedSamples: 0 });
  });

  it("is fast enough for real time", () => {
    const far = farEnd(2, 2);
    const near = room(60)(far);
    const echo = new EchoCanceller({ rate: RATE });
    const t0 = performance.now();
    run(echo, far, near);
    const ms = performance.now() - t0;
    // two seconds of audio must take well under two seconds on any machine that runs the suite
    expect(ms).toBeLessThan(1500);
  });
});
