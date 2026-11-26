import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  markWorklet,
  noteCaptureFrame,
  PcmRing,
  preRollFrom,
  resetCaptureRing,
  setCaptureProcessor,
} from "../../src/lib/friday/pcm-capture";
import { polyphaseResample, rms } from "../../src/lib/friday/speech-dsp";
import {
  AGC_MAX_GAIN_DB,
  boxcarDecimate,
  CAPTURE_BATCH_MS,
  configureFrontEnd,
  FRONT_END_DEFAULTS,
  FrontEndDsp,
  frontEndStats,
  KaiserResampler,
  processFrontEnd,
  resampleFir,
} from "../../src/lib/friday/voice-engine/front-end-dsp";

const root = resolve(import.meta.dirname, "../..");
const source = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");

const dbOf = (linear: number) => 20 * Math.log10(Math.max(linear, 1e-9));

function tone(rate: number, hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1)
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Fixed-seed uniform noise in [-1, 1). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function frames(samples: Float32Array, size: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < samples.length; i += size) out.push(samples.slice(i, i + size));
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Speech-like: 300 ms voiced (three harmonics) then 100 ms of -75 dBFS noise, repeating. */
function speechLike(rate: number, seconds: number, onDbfs: number, seed = 7) {
  const rand = prng(seed);
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  const on = new Uint8Array(n);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const voiced = t % 0.4 < 0.3;
    if (voiced) {
      const v =
        Math.sin(2 * Math.PI * 150 * t) +
        0.5 * Math.sin(2 * Math.PI * 450 * t) +
        0.3 * Math.sin(2 * Math.PI * 1200 * t);
      out[i] = v;
      on[i] = 1;
      sum += v * v;
      count += 1;
    }
  }
  const scale = 10 ** (onDbfs / 20) / Math.sqrt(sum / count);
  for (let i = 0; i < n; i += 1) {
    out[i] = on[i] ? (out[i] ?? 0) * scale : rand() * 10 ** (-75 / 20) * 1.7;
  }
  return { samples: out, on };
}

afterEach(() => {
  configureFrontEnd({ ...FRONT_END_DEFAULTS });
  setCaptureProcessor(null);
  resetCaptureRing();
});

describe("high-pass", () => {
  const through = (hz: number, rate = 48_000) => {
    const fe = new FrontEndDsp({ hpf: true });
    const input = tone(rate, hz, 2);
    const out = concat(frames(input, 960).map((f) => Float32Array.from(fe.pre(f, rate, 0))));
    const tail = (a: Float32Array) => a.subarray(Math.floor(a.length / 2));
    return dbOf(rms(tail(out))) - dbOf(rms(tail(input)));
  };

  it("takes 30 Hz down by at least 18 dB", () => {
    expect(through(30)).toBeLessThanOrEqual(-18);
  });

  it("leaves 300 Hz within 0.5 dB, and 1 kHz untouched", () => {
    expect(Math.abs(through(300))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(through(1000))).toBeLessThanOrEqual(0.1);
  });

  it("holds the same numbers at 44.1 kHz and 16 kHz", () => {
    expect(through(30, 44_100)).toBeLessThanOrEqual(-18);
    expect(through(30, 16_000)).toBeLessThanOrEqual(-18);
    expect(Math.abs(through(300, 44_100))).toBeLessThanOrEqual(0.5);
  });

  it("removes a DC offset and gives the same result however the stream is cut", () => {
    const fe = new FrontEndDsp({ hpf: true });
    const dc = new Float32Array(48_000).fill(0.3);
    const out = concat(frames(dc, 128).map((f) => Float32Array.from(fe.pre(f, 48_000, 0))));
    expect(Math.abs(out[out.length - 1] ?? 1)).toBeLessThan(1e-3);
    const sig = tone(48_000, 200, 0.5);
    const a = new FrontEndDsp();
    const b = new FrontEndDsp();
    const whole = Float32Array.from(a.pre(sig, 48_000, 0));
    const cut = concat(frames(sig, 77).map((f) => Float32Array.from(b.pre(f, 48_000, 0))));
    expect(Array.from(cut)).toEqual(Array.from(whole));
  });

  it("returns the input object itself when the high-pass is off", () => {
    const fe = new FrontEndDsp({ hpf: false });
    const frame = tone(48_000, 200, 0.01);
    expect(fe.pre(frame, 48_000, 0)).toBe(frame);
  });
});

describe("clip meter", () => {
  it("counts clipped samples and runs of three exactly, across frame edges", () => {
    const fe = new FrontEndDsp({ hpf: false });
    const sig = new Float32Array(4800).fill(0.1);
    // 1 sample, a run of 2 (not a run), runs of 3, 5 and 40 samples: 51 clipped samples, 3 runs.
    sig[100] = 1;
    sig[200] = -1;
    sig[201] = -1;
    for (const [start, len] of [
      [300, 3],
      [1000, 5],
      [2390, 40],
    ] as const) {
      for (let i = 0; i < len; i += 1) sig[start + i] = i % 2 ? 0.9995 : -1;
    }
    for (const size of [4800, 480, 130, 1]) {
      const meter = new FrontEndDsp({ hpf: false });
      let at = 0;
      for (const f of frames(sig, size)) meter.pre(f, 48_000, (at += 1) * 0.001);
      const stats = meter.stats();
      expect(stats.clipCount).toBe(1 + 2 + 3 + 5 + 40);
      expect(stats.clipRuns).toBe(3);
    }
    void fe;
  });

  it("flags a clipped second at 0.1 % or five runs, and lets it go a second later", () => {
    const fe = new FrontEndDsp({ hpf: false });
    const quiet = tone(48_000, 200, 0.02, 0.3);
    fe.pre(quiet, 48_000, 0);
    expect(fe.stats().clipped).toBe(false);
    expect(fe.stats().clipRate).toBe(0);
    const hot = quiet.slice();
    hot.fill(1, 0, 3);
    hot.fill(1, 100, 103);
    hot.fill(1, 200, 203);
    hot.fill(1, 300, 303);
    hot.fill(1, 400, 403);
    fe.pre(hot, 48_000, 20);
    expect(fe.stats().clipRuns).toBe(5);
    expect(fe.stats().clipped).toBe(true);
    expect(fe.stats().clipRate).toBeCloseTo(15 / (quiet.length * 2), 6);
    fe.pre(quiet, 48_000, 1500);
    expect(fe.stats().clipped).toBe(false);
    expect(fe.stats().clipCount).toBe(15);
    const sparse = quiet.slice();
    sparse[0] = 1;
    sparse[10] = -1;
    const second = new FrontEndDsp({ hpf: false });
    second.pre(new Float32Array(960).fill(0.2), 48_000, 0);
    second.pre(sparse, 48_000, 20);
    expect(second.stats().clipRate).toBeGreaterThanOrEqual(0.001);
    expect(second.stats().clipped).toBe(true);
  });

  it("reports peak and RMS in dBFS and reads nothing when the meter is off", () => {
    const fe = new FrontEndDsp({ hpf: false });
    fe.pre(tone(48_000, 500, 0.5, 0.5), 48_000, 0);
    const s = fe.stats();
    expect(s.peakDbfs).toBeCloseTo(-6.02, 1);
    expect(s.rmsDbfs).toBeCloseTo(-9.03, 1);
    const off = new FrontEndDsp({ hpf: false, clipWarn: false });
    off.pre(new Float32Array(100).fill(1), 48_000, 0);
    expect(off.stats().clipCount).toBe(0);
  });
});

describe("FIR decimator", () => {
  const aliasDb = (rate: number, hz: number, decimate: (x: Float32Array) => Float32Array) => {
    const input = tone(rate, hz, 1);
    const out = decimate(input);
    return dbOf(rms(out.subarray(400, out.length - 400))) - dbOf(rms(input));
  };
  const fir = (rate: number) => (x: Float32Array) => {
    const r = new KaiserResampler(rate, 16_000);
    return concat(frames(x, 128).map((f) => r.push(f)));
  };

  it("rejects a 12 kHz tone at 48 kHz by at least 50 dB, where the box filter does not", () => {
    const firDb = aliasDb(48_000, 12_000, fir(48_000));
    const boxDb = aliasDb(48_000, 12_000, (x) => boxcarDecimate(x, 48_000));
    expect(firDb).toBeLessThanOrEqual(-50);
    expect(boxDb).toBeGreaterThan(-50);
  });

  it("rejects 10, 12 and 20 kHz at 48 kHz, and 12 kHz at 44.1 kHz", () => {
    for (const hz of [10_000, 12_000, 20_000]) {
      expect(aliasDb(48_000, hz, fir(48_000))).toBeLessThanOrEqual(-50);
    }
    expect(aliasDb(44_100, 12_000, fir(44_100))).toBeLessThanOrEqual(-50);
  });

  it("passes speech frequencies: 300 Hz to 6 kHz within 0.5 dB, DC gain 1", () => {
    for (const hz of [300, 1000, 3000, 6000]) {
      expect(Math.abs(aliasDb(48_000, hz, fir(48_000)))).toBeLessThanOrEqual(0.5);
    }
    const r = new KaiserResampler(48_000, 16_000);
    const out = r.push(new Float32Array(4800).fill(0.25));
    expect(out[out.length - 1]).toBeCloseTo(0.25, 5);
  });

  it("gives the same samples whatever the frame size, with the right count and timeline", () => {
    const sig = tone(48_000, 700, 0.6);
    const whole = new KaiserResampler(48_000, 16_000).push(sig);
    expect(whole.length).toBeGreaterThanOrEqual(Math.floor(sig.length / 3) - 40);
    for (const size of [128, 960, 7]) {
      const r = new KaiserResampler(48_000, 16_000);
      const cut = concat(frames(sig, size).map((f) => r.push(f)));
      expect(cut.length).toBe(whole.length);
      for (let i = 0; i < whole.length; i += 1) {
        expect(Math.abs((cut[i] ?? 0) - (whole[i] ?? 0))).toBeLessThan(1e-6);
      }
    }
    // Output n sits at input position 3n: the 700 Hz sine keeps its phase.
    for (const n of [100, 500, 1000]) {
      expect(whole[n] ?? 9).toBeCloseTo(0.5 * Math.sin((2 * Math.PI * 700 * 3 * n) / 48_000), 2);
    }
  });

  it("uses a bounded filter of about 95 taps at 48 kHz", () => {
    const r = new KaiserResampler(48_000, 16_000);
    expect(r.taps).toBeGreaterThanOrEqual(88);
    expect(r.taps).toBeLessThanOrEqual(110);
  });
});

describe("polyphaseResample (speech-dsp)", () => {
  it("no longer folds a 12 kHz tone back into speech, and keeps the length rule", () => {
    const input = tone(48_000, 12_000, 0.5);
    const out = polyphaseResample(input, 48_000, 16_000);
    expect(out.length).toBe(8000);
    expect(dbOf(rms(out.subarray(200, out.length - 200))) - dbOf(rms(input))).toBeLessThanOrEqual(
      -50,
    );
  });

  it("upsamples 8 kHz to 16 kHz keeping a 440 Hz tone and the doubled length", () => {
    const out = polyphaseResample(tone(8000, 440, 0.2), 8000, 16_000);
    expect(out.length).toBe(3200);
    expect(dbOf(rms(out.subarray(100, 3100)))).toBeCloseTo(dbOf(0.5 / Math.SQRT2), 0);
    expect(resampleFir(new Float32Array(0), 8000, 16_000).length).toBe(0);
    expect(polyphaseResample(tone(16_000, 440, 0.1), 16_000, 16_000).length).toBe(1600);
  });
});

describe("own AGC and limiter", () => {
  const run = (onDbfs: number, seconds = 3) => {
    const fe = new FrontEndDsp({ hpf: false, agc: "own" });
    const { samples, on } = speechLike(16_000, seconds, onDbfs);
    const out = concat(frames(samples, 320).map((f) => fe.post(f, 16_000)));
    return { fe, out, on, samples };
  };
  const levelOn = (out: Float32Array, on: Uint8Array, from: number, to: number) => {
    const picked: number[] = [];
    for (
      let i = Math.floor(from * 16_000);
      i < Math.min(out.length, Math.floor(to * 16_000));
      i += 1
    ) {
      if (on[i]) picked.push(out[i] ?? 0);
    }
    return dbOf(rms(Float32Array.from(picked)));
  };

  it("brings quiet speech to -20 dBFS within 3 s, with gain at most +12 dB and peak under -1 dBFS", () => {
    const { fe, out, on } = run(-32);
    expect(Math.abs(levelOn(out, on, 2.4, 3) - -20)).toBeLessThanOrEqual(2);
    expect(fe.stats().agcGainDb).toBeLessThanOrEqual(AGC_MAX_GAIN_DB);
    expect(fe.stats().agcGainDb).toBeGreaterThan(10);
    expect(dbOf(Math.max(...out.map(Math.abs)))).toBeLessThanOrEqual(-1);
  });

  it("never lifts a -40 dBFS voice by more than +12 dB", () => {
    const { fe, out, on } = run(-40);
    expect(fe.stats().agcGainDb).toBeLessThanOrEqual(AGC_MAX_GAIN_DB + 1e-9);
    expect(levelOn(out, on, 2.4, 3)).toBeLessThanOrEqual(-40 + AGC_MAX_GAIN_DB + 0.5);
    expect(levelOn(out, on, 2.4, 3)).toBeGreaterThan(-30);
  });

  it("brings loud speech down toward -20 dBFS and the limiter holds peaks under -3 dBFS", () => {
    const { out, on, fe } = run(-6);
    expect(Math.abs(levelOn(out, on, 1.6, 3) - -20)).toBeLessThanOrEqual(3);
    expect(dbOf(Math.max(...out.map(Math.abs)))).toBeLessThanOrEqual(-2.9);
    expect(fe.stats().agcGainDb).toBeLessThan(0);
  });

  it("does not move the gain on noise or silence", () => {
    const fe = new FrontEndDsp({ hpf: false, agc: "own" });
    const rand = prng(3);
    for (let i = 0; i < 150; i += 1) {
      const noise = new Float32Array(320);
      for (let k = 0; k < 320; k += 1) noise[k] = rand() * 10 ** (-62 / 20) * 1.7;
      fe.post(noise, 16_000);
    }
    expect(fe.stats().agcGainDb).toBe(0);
  });

  it("changes nothing in browser or off mode (decimation only)", () => {
    for (const agc of ["browser", "off"] as const) {
      const fe = new FrontEndDsp({ hpf: false, agc });
      const sig = tone(16_000, 300, 0.2, 0.01);
      const out = fe.post(sig, 16_000);
      expect(Array.from(out)).toEqual(Array.from(sig));
      expect(fe.stats().agcGainDb).toBe(0);
    }
  });
});

describe("one chain and its rollback", () => {
  it("runs raw -> high-pass -> canceller -> AGC and hands the canceller the high-passed frame", () => {
    const fe = new FrontEndDsp({ agc: "own" });
    let seen: ArrayLike<number> | null = null;
    const frame = new Float32Array(960).fill(0.2);
    const out = fe.process(frame, 48_000, 0, (hp) => {
      seen = hp;
      return new Float32Array(320).fill(0.05);
    });
    expect(seen).not.toBe(frame);
    expect(Math.abs((seen as unknown as ArrayLike<number>)[959] ?? 1)).toBeLessThan(0.2);
    expect(out.length).toBe(320);
  });

  it("with hpf off, agc off and the boxcar it equals the old box filter exactly", () => {
    const fe = new FrontEndDsp({ hpf: false, agc: "off", decimator: "boxcar" });
    const sig = tone(48_000, 500, 0.05);
    const out = fe.process(sig, 48_000, 0);
    expect(Array.from(out)).toEqual(Array.from(boxcarDecimate(sig, 48_000)));
    const ring = new PcmRing();
    ring.push(sig, 5, 48_000);
    expect(Array.from(ring.takeSince(0))).toEqual(Array.from(out));
  });

  it("falls back to today's path after five faults in a row and never throws", () => {
    const fe = new FrontEndDsp({ agc: "own" });
    const bomb = { length: 960 } as ArrayLike<number>;
    Object.defineProperty(bomb, 0, {
      get() {
        throw new Error("bad frame");
      },
    });
    for (let i = 0; i < 5; i += 1) expect(() => fe.pre(bomb, 48_000, 0)).not.toThrow();
    const stats = fe.stats();
    expect(stats.faults).toBe(5);
    expect(stats.hpf).toBe(false);
    expect(stats.agc).toBe("off");
    expect(stats.decimator).toBe("boxcar");
  });

  it("ignores a bad configuration value and keeps the old one", () => {
    const fe = new FrontEndDsp();
    fe.configure({ agc: "loud" as never, decimator: "nope" as never, hpf: "yes" as never });
    expect(fe.config()).toEqual(FRONT_END_DEFAULTS);
  });
});

describe("pcm-capture hook", () => {
  const feed = (sig: Float32Array, rate: number, size = 960) => {
    let at = 0;
    for (const f of frames(sig, size)) noteCaptureFrame(f, (at += 20), rate);
  };

  it("sends worklet frames through the high-pass and the FIR decimator into the 16 kHz ring", () => {
    resetCaptureRing();
    markWorklet(true);
    feed(new Float32Array(48_000).fill(0.4), 48_000);
    const ring = preRollFrom(1000, 5000);
    expect(ring.length).toBeGreaterThanOrEqual(15_900);
    expect(ring.length).toBeLessThanOrEqual(16_000);
    expect(Math.abs(ring[ring.length - 1] ?? 1)).toBeLessThan(1e-3);
    expect(frontEndStats().decimator).toBe("fir");
    expect(frontEndStats().peakDbfs).toBeCloseTo(dbOf(0.4), 1);
  });

  it("keeps the old box filter and raw level when the analyser feeds frames (no worklet)", () => {
    resetCaptureRing();
    markWorklet(false);
    feed(new Float32Array(9600).fill(0.4), 48_000);
    const ring = preRollFrom(1000, 5000);
    expect(ring.length).toBe(3200);
    expect(ring[3199]).toBeCloseTo(0.4, 6);
    expect(frontEndStats().clipCount).toBe(0);
  });

  it("rolls back with one call: no high-pass, no own AGC, the box filter", () => {
    configureFrontEnd({ hpf: false, agc: "off", decimator: "boxcar" });
    resetCaptureRing();
    markWorklet(true);
    feed(new Float32Array(9600).fill(0.4), 48_000);
    const ring = preRollFrom(1000, 5000);
    expect(ring.length).toBe(3200);
    expect(ring[3199]).toBeCloseTo(0.4, 6);
    expect(frontEndStats()).toMatchObject({ hpf: false, agc: "off", decimator: "boxcar" });
  });

  it("hands a canceller the high-passed native frame and keeps its 16 kHz output in the ring", () => {
    resetCaptureRing();
    markWorklet(true);
    const got: number[] = [];
    setCaptureProcessor({
      process: (samples) => {
        got.push(samples.length);
        return new Float32Array(320).fill(0.123);
      },
      clear: () => {},
    });
    feed(new Float32Array(960 * 3).fill(0.5), 48_000);
    expect(got).toEqual([960, 960, 960]);
    const ring = preRollFrom(1000, 5000);
    expect(ring.length).toBe(960);
    expect(ring[100]).toBeCloseTo(0.123, 5);
  });

  it("carries on without the canceller when it throws: same ring as no canceller at all", () => {
    const run = (withBomb: boolean) => {
      resetCaptureRing();
      markWorklet(true);
      setCaptureProcessor(
        withBomb
          ? {
              process: () => {
                throw new Error("canceller down");
              },
              clear: () => {},
            }
          : null,
      );
      feed(tone(48_000, 400, 0.2), 48_000);
      return preRollFrom(1000, 5000);
    };
    const plain = run(false);
    const bombed = run(true);
    expect(plain.length).toBeGreaterThan(3000);
    expect(Array.from(bombed)).toEqual(Array.from(plain));
  });

  it("clears the filters when the microphone closes", () => {
    resetCaptureRing();
    markWorklet(true);
    feed(new Float32Array(4800).fill(1), 48_000);
    expect(frontEndStats().clipCount).toBe(4800);
    markWorklet(false);
    expect(frontEndStats().clipCount).toBe(0);
  });

  it("runs the front end through processFrontEnd and one 20 ms batch per worklet message", () => {
    const out = processFrontEnd(new Float32Array(960).fill(0.1), 48_000, 0);
    expect(out.length).toBeGreaterThan(300);
    expect(CAPTURE_BATCH_MS).toBe(20);
    const audio = source("src/lib/friday/voice-audio.ts");
    expect(audio).toMatch(/import \{ CAPTURE_BATCH_MS \} from "\.\/voice-engine\/front-end-dsp"/);
    expect(audio).toMatch(/sampleRate\*\$\{CAPTURE_BATCH_MS\}\/1000/);
    expect(audio).not.toMatch(/this\.port\.postMessage\(ch\)/);
    const capture = source("src/lib/friday/pcm-capture.ts");
    expect(capture).toMatch(/processFrontEnd\(samples, fromRate, atMono, aec\)/);
  });
});
