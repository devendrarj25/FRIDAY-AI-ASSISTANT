/**
 * Acoustic barge-in features: synthetic signals only, fixed seed, no clock, no timer, no device.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PITCH_WINDOWS,
  acousticFeatures,
  type AcousticFeatures,
  type WorkMeter,
} from "../../src/lib/friday/voice-engine/interrupt-acoustic";
import {
  classifyInterruption,
  type InterruptionInput,
} from "../../src/lib/friday/voice-engine/interruption-controller";

const SR = 16_000;
const FRAME = 320; // 20 ms

/** Cuts a signal into 20 ms frames (the last one may be shorter). */
function frames(signal: Float32Array): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < signal.length; i += FRAME) out.push(signal.slice(i, i + FRAME));
  return out;
}
const ms = (n: number): number => Math.round((n / 1000) * SR);
const silence = (n: number): Float32Array => new Float32Array(ms(n));
const join = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
function tone(hz: number, durMs: number, amp: number): Float32Array {
  const out = new Float32Array(ms(durMs));
  for (let i = 0; i < out.length; i += 1) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}
/** Linear fade-in over the whole length. */
function ramped(hz: number, durMs: number, amp: number): Float32Array {
  const t = tone(hz, durMs, amp);
  for (let i = 0; i < t.length; i += 1) t[i] = (t[i] ?? 0) * (i / t.length);
  return t;
}
/** White noise from a fixed-seed generator. */
function noise(durMs: number, amp: number, seed = 7): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(ms(durMs));
  for (let i = 0; i < out.length; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = amp * ((s / 0xffffffff) * 2 - 1);
  }
  return out;
}
/** A voiced-speech-like signal: harmonics of a fundamental that glides by `vibratoCents` at 5 Hz. */
function harmonic(durMs: number, f0: number, vibratoCents: number): Float32Array {
  const out = new Float32Array(ms(durMs));
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const f = f0 * 2 ** ((vibratoCents * Math.sin((2 * Math.PI * 5 * i) / SR)) / 1200);
    phase += (2 * Math.PI * f) / SR;
    let v = 0;
    for (let k = 1; k <= 8; k += 1) v += Math.sin(k * phase) / k;
    out[i] = 0.25 * v;
  }
  return out;
}
const finiteAll = (f: AcousticFeatures): boolean =>
  Object.values(f).every((v) => Number.isFinite(v));
const ZEROS: AcousticFeatures = {
  onsetSlopeDb: 0,
  voicedMs: 0,
  rmsDb: 0,
  zcr: 0,
  pitchVarCents: 0,
};

describe("acousticFeatures: no voice", () => {
  it("gives zeros for empty input, empty frames and bad rates", () => {
    expect(acousticFeatures([], SR)).toEqual(ZEROS);
    expect(acousticFeatures([new Float32Array(0), new Float32Array(0)], SR)).toEqual(ZEROS);
    expect(acousticFeatures(frames(tone(200, 100, 0.5)), 0)).toEqual(ZEROS);
    expect(acousticFeatures(frames(tone(200, 100, 0.5)), Number.NaN)).toEqual(ZEROS);
    expect(acousticFeatures(null as unknown as Float32Array[], SR)).toEqual(ZEROS);
  });
  it("gives zeros for digital silence and for a level below the voiced floor", () => {
    expect(acousticFeatures(frames(silence(400)), SR)).toEqual(ZEROS);
    expect(acousticFeatures(frames(noise(400, 0.0005)), SR)).toEqual(ZEROS);
  });
});

describe("acousticFeatures: tone, noise and speech-like signals", () => {
  it("reads a tone that starts abruptly after silence", () => {
    const f = acousticFeatures(frames(join(silence(100), tone(200, 200, 0.5))), SR);
    expect(f.voicedMs).toBeCloseTo(200, 0);
    expect(f.onsetSlopeDb).toBeGreaterThan(20);
    expect(f.rmsDb).toBeCloseTo(-9.03, 0);
    expect(f.zcr).toBeGreaterThan(0.015);
    expect(f.zcr).toBeLessThan(0.04);
    expect(f.pitchVarCents).toBeLessThan(10);
  });
  it("sees a slow fade-in as a gentler onset than an abrupt start", () => {
    const abrupt = acousticFeatures(frames(join(silence(100), tone(200, 300, 0.5))), SR);
    const slow = acousticFeatures(frames(join(silence(100), ramped(200, 300, 0.5))), SR);
    expect(slow.onsetSlopeDb).toBeLessThan(abrupt.onsetSlopeDb);
    expect(slow.onsetSlopeDb).toBeLessThan(20);
  });
  it("reads a noise burst as abrupt, noisy and not periodic", () => {
    const f = acousticFeatures(frames(join(silence(100), noise(200, 0.4))), SR);
    expect(f.onsetSlopeDb).toBeGreaterThan(20);
    expect(f.zcr).toBeGreaterThan(0.35);
    expect(f.pitchVarCents).toBe(0);
    expect(f.voicedMs).toBeCloseTo(200, 0);
  });
  it("tells a steady pitch from a moving one", () => {
    const steady = acousticFeatures(frames(harmonic(600, 130, 0)), SR);
    const moving = acousticFeatures(frames(harmonic(600, 130, 300)), SR);
    expect(steady.pitchVarCents).toBeLessThan(15);
    expect(moving.pitchVarCents).toBeGreaterThan(60);
    expect(moving.pitchVarCents).toBeGreaterThan(steady.pitchVarCents * 4);
    expect(steady.zcr).toBeLessThan(0.2);
  });
  it("does not depend on the frame size", () => {
    const sig = join(silence(60), harmonic(500, 140, 100));
    const a = acousticFeatures(frames(sig), SR);
    const b = acousticFeatures(
      Array.from({ length: Math.ceil(sig.length / 160) }, (_, i) =>
        sig.slice(i * 160, i * 160 + 160),
      ),
      SR,
    );
    expect(b.voicedMs).toBeCloseTo(a.voicedMs, -1);
    expect(b.pitchVarCents).toBeCloseTo(a.pitchVarCents, 1);
    expect(b.rmsDb).toBeCloseTo(a.rmsDb, 0);
  });
});

describe("acousticFeatures: hostile and tiny input", () => {
  it("holds clipped input inside full scale and stays finite", () => {
    const f = acousticFeatures(frames(tone(150, 300, 6)), SR);
    expect(finiteAll(f)).toBe(true);
    expect(f.rmsDb).toBeLessThanOrEqual(0);
    expect(f.rmsDb).toBeGreaterThan(-3.5);
    expect(f.pitchVarCents).toBeLessThan(15);
  });
  it("treats NaN and Infinity samples as zero, never as a result", () => {
    const sig = tone(200, 200, 0.5);
    sig[10] = Number.NaN;
    sig[20] = Number.POSITIVE_INFINITY;
    sig[30] = Number.NEGATIVE_INFINITY;
    const f = acousticFeatures(frames(sig), SR);
    expect(finiteAll(f)).toBe(true);
    expect(f.voicedMs).toBeGreaterThan(0);
  });
  it("handles inputs far shorter than one pitch window", () => {
    for (const n of [1, 2, 10, 100, 319]) {
      const f = acousticFeatures([tone(200, 100, 0.5).slice(0, n)], SR);
      expect(finiteAll(f)).toBe(true);
      expect(f.pitchVarCents).toBe(0);
    }
    expect(acousticFeatures([new Float32Array([0.5])], SR).voicedMs).toBeCloseTo(1000 / SR, 2);
  });
  it("skips a non-Float32Array entry instead of throwing", () => {
    const f = acousticFeatures([[0.5, 0.5] as unknown as Float32Array, tone(200, 100, 0.5)], SR);
    expect(f.voicedMs).toBeCloseTo(100, 0);
  });
});

describe("acousticFeatures: purity and cost", () => {
  it("is deterministic and leaves its input untouched", () => {
    const fr = frames(join(silence(40), harmonic(300, 120, 150)));
    const before = fr.map((x) => Array.from(x));
    const a = acousticFeatures(fr, SR);
    const b = acousticFeatures(fr, SR);
    expect(a).toEqual(b);
    expect(fr.map((x) => Array.from(x))).toEqual(before);
  });
  it("does bounded work: 20 times the audio costs far less than 20 times the work", () => {
    const one: WorkMeter = { ops: 0 };
    const long: WorkMeter = { ops: 0 };
    acousticFeatures(frames(harmonic(1000, 130, 100)), SR, one);
    const f = acousticFeatures(frames(harmonic(20_000, 130, 100)), SR, long);
    expect(finiteAll(f)).toBe(true);
    expect(long.ops).toBeGreaterThan(one.ops);
    expect(long.ops).toBeLessThan(one.ops * 3);
    // One autocorrelation window costs at most window x lags x 3 multiplications.
    const windowSamples = Math.round(0.04 * SR);
    const lags = Math.ceil(SR / 60) - Math.floor(SR / 400) + 2;
    expect(long.ops).toBeLessThanOrEqual(20 * SR + MAX_PITCH_WINDOWS * windowSamples * lags * 3);
  });
});

describe("classifyInterruption: acoustic stays in the trace", () => {
  const base: InterruptionInput = {
    words: ["ruko", "ek", "minute"],
    voiceMs: 800,
    vadP: 0.9,
    ttsPlaying: true,
    playedMs: 1500,
    echoClean: true,
    scene: "quiet",
    speaker: "owner",
    sinceTtsStartMs: 1500,
  };
  const feats = acousticFeatures(frames(join(silence(60), harmonic(400, 130, 100))), SR);
  const variants: Partial<InterruptionInput>[] = [
    {},
    { words: [], voiceMs: 100 },
    { words: ["haan"], voiceMs: 300 },
    { ttsPlaying: false },
    { vadP: 0.1 },
    { scene: "tv", speaker: "unknown", words: ["kuch", "bhi"] },
    { speaker: "other", words: ["hello", "there", "friend"] },
  ];

  it("copies the features into the trace without changing the decision", () => {
    for (const v of variants) {
      const plain = classifyInterruption({ ...base, ...v });
      const withAcoustic = classifyInterruption({ ...base, ...v, acoustic: feats });
      const { trace, ...rest } = withAcoustic;
      expect(rest).toEqual(plain);
      expect(trace).toEqual({ acoustic: feats });
    }
  });
  it("adds no trace key without acoustic, and copies rather than aliases", () => {
    expect(Object.keys(classifyInterruption(base)).sort()).toEqual([
      "confidence",
      "decision",
      "reason",
    ]);
    const out = classifyInterruption({ ...base, acoustic: feats });
    expect(out.trace?.acoustic).not.toBe(feats);
    expect(ZEROS).toEqual({ ...ZEROS });
  });
  it("ignores loud or abrupt features: they never take the floor on their own", () => {
    const loud: AcousticFeatures = {
      onsetSlopeDb: 90,
      voicedMs: 5000,
      rmsDb: 0,
      zcr: 0.5,
      pitchVarCents: 400,
    };
    const quiet: AcousticFeatures = { ...ZEROS };
    const input = { ...base, words: ["haan"], voiceMs: 300 };
    expect(classifyInterruption({ ...input, acoustic: loud }).decision).toBe(
      classifyInterruption({ ...input, acoustic: quiet }).decision,
    );
  });
});
