/**
 * FRIDAY · capture front end: the maths between the microphone and the 16 kHz ring.
 *
 * Order, per frame of the one microphone capture (pcm-capture.ts `noteCaptureFrame`):
 *   clip meter (raw) -> high-pass (native rate) -> echo canceller (optional, owned by the caller)
 *   -> Kaiser FIR decimator to 16 kHz -> slow speech-gated AGC with a limiter (only when `agc: "own"`).
 * Every stage is a pure function of the samples it is given, with no timers and no device access. A stage that
 * throws is skipped and counted; five faults in a row switch the whole front end to today's path (no high-pass,
 * no own AGC, boxcar decimator), so nothing here can stop the audio.
 * Rollback switch: `configureFrontEnd({ hpf: false, agc: "off", decimator: "boxcar" })`.
 */

export const FRONT_END_RATE = 16_000;
/** The audio worklet hands over this much audio at a time (was one 128-sample quantum, about 375 messages a second). */
export const CAPTURE_BATCH_MS = 20;

export type AgcMode = "browser" | "own" | "off";
export type DecimatorKind = "fir" | "boxcar";

export type FrontEndConfig = {
  /** 2nd-order Butterworth high-pass: hum, DC and handling thumps. */
  hpf: boolean;
  /** "own" is the slow speech-gated AGC after the canceller; "browser" and "off" leave the level alone. */
  agc: AgcMode;
  /** Count clipped samples (abs >= 0.999) and flag a clipped second. */
  clipWarn: boolean;
  decimator: DecimatorKind;
};

export const FRONT_END_DEFAULTS: Readonly<FrontEndConfig> = Object.freeze({
  hpf: true,
  agc: "browser",
  clipWarn: true,
  decimator: "fir",
});

/** Corner of the high-pass. A 2nd-order section at 80 Hz is only 17.1 dB down at 30 Hz; 85 Hz is 18.2 dB. */
export const HPF_HZ = 85;
const HPF_Q = Math.SQRT1_2;
/** A sample this close to full scale counts as clipped (32767 of 32768 and above). */
const CLIP_LEVEL = 0.999;
const CLIP_RUN = 3;
/** One second of meter records. */
const WINDOW_MS = 1000;
const CLIP_FRACTION_FLAG = 0.001;
const CLIP_RUNS_FLAG = 5;
export const AGC_TARGET_DBFS = -20;
export const AGC_MAX_GAIN_DB = 12;
const AGC_MIN_GAIN_DB = -12;
const AGC_ATTACK_MS = 10;
const AGC_RELEASE_MS = 500;
/** Blocks quieter than this are never speech, whatever the noise floor says. */
const AGC_GATE_DBFS = -52;
const AGC_GATE_OVER_FLOOR_DB = 8;
const AGC_FLOOR_START_DBFS = -60;
const AGC_FLOOR_RISE_DB_PER_S = 0.5;
export const LIMITER_DBFS = -3;
const LIMITER_RELEASE_MS = 50;
const MAX_FAULTS = 5;
const FLOOR_DB = -120;

const db = (linear: number): number =>
  linear > 1e-6 ? Math.max(FLOOR_DB, 20 * Math.log10(linear)) : FLOOR_DB;

// ---------------------------------------------------------------------------------------------------------------
// Kaiser-windowed sinc resampler (streaming) and the box filter it replaces
// ---------------------------------------------------------------------------------------------------------------

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const quarter = (x * x) / 4;
  for (let k = 1; k < 60; k += 1) {
    term *= quarter / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

type Kernel = { R: number; P: number; step: number; table: Float32Array };
const kernels = new Map<string, Kernel>();

/**
 * Linear-phase low-pass sampled on `P` fractional positions. The cutoff sits at half the lower rate, the pass band
 * ends at 7/8 of it and the stop band starts at 9/8 of it, so a 48 kHz to 16 kHz path passes 7 kHz and rejects
 * everything above 9 kHz by `attenuationDb`. Every phase sums to 1, so the gain at DC is exactly 1.
 */
function buildKernel(fromRate: number, toRate: number, attenuationDb: number): Kernel {
  const key = `${fromRate}:${toRate}:${attenuationDb}`;
  const cached = kernels.get(key);
  if (cached) return cached;
  const lower = Math.min(fromRate, toRate);
  const cutoff = (0.5 * lower) / fromRate;
  const transition = (0.125 * lower) / fromRate;
  const R = Math.min(
    256,
    Math.max(8, Math.ceil((attenuationDb - 7.95) / (2.285 * 2 * Math.PI * transition) / 2)),
  );
  const L = Math.round(toRate) / gcd(Math.round(fromRate), Math.round(toRate));
  const P = Math.max(1, Math.min(L, 640));
  const beta = 0.1102 * (attenuationDb - 8.7);
  const norm = besselI0(beta);
  const table = new Float32Array(P * 2 * R);
  for (let p = 0; p < P; p += 1) {
    const d = p / P;
    let sum = 0;
    const row = new Float64Array(2 * R);
    for (let k = 0; k < 2 * R; k += 1) {
      const x = k - R + 1 - d;
      const ratio = x / R;
      const window =
        Math.abs(ratio) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - ratio * ratio)) / norm;
      const arg = Math.PI * 2 * cutoff * x;
      const sinc = Math.abs(arg) < 1e-12 ? 1 : Math.sin(arg) / arg;
      row[k] = 2 * cutoff * sinc * window;
      sum += row[k] ?? 0;
    }
    for (let k = 0; k < 2 * R; k += 1) table[p * 2 * R + k] = (row[k] ?? 0) / sum;
  }
  const kernel: Kernel = { R, P, step: fromRate / toRate, table };
  if (kernels.size >= 8) kernels.clear();
  kernels.set(key, kernel);
  return kernel;
}

/**
 * Streaming resampler. Output n sits exactly at input position n * from / to (linear phase, zero-padded before
 * the first sample), so a stream keeps its timeline; it needs `lookAhead` input samples beyond a sample before it
 * can produce it (1 ms at 48 kHz).
 */
export class KaiserResampler {
  readonly taps: number;
  readonly lookAhead: number;
  private readonly kernel: Kernel;
  private hist: Float32Array;
  private pos: number;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
    attenuationDb = 65,
  ) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error("sample rates must be positive");
    this.kernel = buildKernel(fromRate, toRate, attenuationDb);
    this.taps = 2 * this.kernel.R;
    this.lookAhead = this.kernel.R;
    this.hist = new Float32Array(this.kernel.R);
    this.pos = this.kernel.R;
  }

  push(input: ArrayLike<number>): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    const { R, P, step, table } = this.kernel;
    const buf = new Float32Array(this.hist.length + input.length);
    buf.set(this.hist, 0);
    for (let i = 0; i < input.length; i += 1) buf[this.hist.length + i] = Number(input[i]) || 0;
    const last = buf.length - 1;
    const out = new Float32Array(Math.ceil(input.length / step) + 2);
    let count = 0;
    let pos = this.pos;
    for (;;) {
      let i0 = Math.floor(pos);
      let phase = Math.round((pos - i0) * P);
      if (phase >= P) {
        phase = 0;
        i0 += 1;
      }
      if (i0 + R > last || count >= out.length) break;
      const base = i0 - R + 1;
      const row = phase * 2 * R;
      let acc = 0;
      for (let k = 0; k < 2 * R; k += 1) acc += (buf[base + k] ?? 0) * (table[row + k] ?? 0);
      out[count] = acc;
      count += 1;
      pos += step;
    }
    const keepFrom = Math.max(0, Math.floor(pos) - R + 1);
    this.hist = buf.slice(keepFrom);
    this.pos = pos - keepFrom;
    return out.slice(0, count);
  }

  reset(): void {
    this.hist = new Float32Array(this.kernel.R);
    this.pos = this.kernel.R;
  }
}

/** One-shot, delay-compensated resample with the same filter; the output has round(n * to / from) samples. */
export function resampleFir(
  samples: ArrayLike<number>,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0) || samples.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return Float32Array.from(samples, (v) => Number(v) || 0);
  const resampler = new KaiserResampler(fromRate, toRate);
  const want = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const padded = new Float32Array(samples.length + 2 * resampler.lookAhead + 2);
  for (let i = 0; i < samples.length; i += 1) padded[i] = Number(samples[i]) || 0;
  const out = new Float32Array(want);
  out.set(resampler.push(padded).subarray(0, want));
  return out;
}

/** Average each group of input samples (the box filter pcm-capture used before). Kept as the rollback decimator. */
export function boxcarDecimate(
  samples: ArrayLike<number>,
  fromRate: number,
  toRate = FRONT_END_RATE,
): Float32Array {
  const step = fromRate > toRate ? fromRate / toRate : 1;
  const out = new Float32Array(Math.ceil(samples.length / step));
  let n = 0;
  for (let pos = 0; pos < samples.length; pos += step) {
    const start = Math.floor(pos);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor(pos + step)));
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i] ?? 0;
    out[n] = sum / (end - start);
    n += 1;
  }
  return out.subarray(0, n);
}

// ---------------------------------------------------------------------------------------------------------------
// High-pass
// ---------------------------------------------------------------------------------------------------------------

class HighPass {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;
  private rate = 0;

  private design(rate: number): void {
    const w0 = (2 * Math.PI * HPF_HZ) / rate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * HPF_Q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.rate = rate;
    this.z1 = 0;
    this.z2 = 0;
  }

  process(samples: ArrayLike<number>, rate: number): Float32Array {
    if (rate !== this.rate) this.design(rate);
    const out = new Float32Array(samples.length);
    let { z1, z2 } = this;
    for (let i = 0; i < samples.length; i += 1) {
      const x = Number(samples[i]) || 0;
      const y = this.b0 * x + z1;
      z1 = this.b1 * x - this.a1 * y + z2;
      z2 = this.b2 * x - this.a2 * y;
      out[i] = y;
    }
    this.z1 = z1;
    this.z2 = z2;
    return out;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
    this.rate = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Clip meter
// ---------------------------------------------------------------------------------------------------------------

type MeterRecord = {
  at: number;
  n: number;
  clip: number;
  runs: number;
  sumSq: number;
  peak: number;
};

class ClipMeter {
  private records: MeterRecord[] = [];
  private run = 0;
  total = 0;
  runs = 0;

  push(samples: ArrayLike<number>, atMono: number): void {
    let clip = 0;
    let runs = 0;
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const v = Number(samples[i]) || 0;
      const a = Math.abs(v);
      sumSq += v * v;
      if (a > peak) peak = a;
      if (a >= CLIP_LEVEL) {
        clip += 1;
        this.run += 1;
        if (this.run === CLIP_RUN) runs += 1;
      } else {
        this.run = 0;
      }
    }
    this.total += clip;
    this.runs += runs;
    this.records.push({ at: atMono, n: samples.length, clip, runs, sumSq, peak });
    while (this.records.length > 1 && atMono - (this.records[0]?.at ?? atMono) >= WINDOW_MS) {
      this.records.shift();
    }
  }

  window(): { n: number; clip: number; runs: number; sumSq: number; peak: number } {
    const sum = { n: 0, clip: 0, runs: 0, sumSq: 0, peak: 0 };
    for (const r of this.records) {
      sum.n += r.n;
      sum.clip += r.clip;
      sum.runs += r.runs;
      sum.sumSq += r.sumSq;
      if (r.peak > sum.peak) sum.peak = r.peak;
    }
    return sum;
  }

  reset(): void {
    this.records = [];
    this.run = 0;
    this.total = 0;
    this.runs = 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// AGC and limiter
// ---------------------------------------------------------------------------------------------------------------

/**
 * Slow level control for the copy the recogniser reads. The gain follows the block level toward -20 dBFS (+12 dB
 * at most, -12 dB at least) only while the block is speech: louder than a gate and 8 dB over a slow noise floor.
 * Between phrases the gain holds, so a pause is not pumped up. A peak limiter follows, instant attack.
 */
class SlowAgc {
  gainDb = 0;
  private applied = 1;
  private floorDb = AGC_FLOOR_START_DBFS;
  private limit = 1;

  process(samples: Float32Array, rate: number): Float32Array {
    const n = samples.length;
    if (n === 0) return samples;
    const seconds = n / rate;
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) sumSq += (samples[i] ?? 0) * (samples[i] ?? 0);
    const levelDb = db(Math.sqrt(sumSq / n));
    if (levelDb < this.floorDb) this.floorDb = levelDb;
    else this.floorDb = Math.min(-35, this.floorDb + AGC_FLOOR_RISE_DB_PER_S * seconds);
    const speech = levelDb > Math.max(AGC_GATE_DBFS, this.floorDb + AGC_GATE_OVER_FLOOR_DB);
    if (speech) {
      const wanted = Math.max(
        AGC_MIN_GAIN_DB,
        Math.min(AGC_MAX_GAIN_DB, AGC_TARGET_DBFS - levelDb),
      );
      const tau = wanted < this.gainDb ? AGC_ATTACK_MS : AGC_RELEASE_MS;
      this.gainDb += (wanted - this.gainDb) * (1 - Math.exp((-seconds * 1000) / tau));
    }
    const next = 10 ** (this.gainDb / 20);
    const ceiling = 10 ** (LIMITER_DBFS / 20);
    const release = 1 - Math.exp(-1000 / (LIMITER_RELEASE_MS * rate));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      // The gain ramps across the block so it never steps.
      const g = this.applied + ((next - this.applied) * (i + 1)) / n;
      const y = (samples[i] ?? 0) * g;
      const need = Math.abs(y) > ceiling ? ceiling / Math.abs(y) : 1;
      this.limit = Math.min(need, this.limit + (1 - this.limit) * release);
      out[i] = y * this.limit;
    }
    this.applied = next;
    return out;
  }

  reset(): void {
    this.gainDb = 0;
    this.applied = 1;
    this.floorDb = AGC_FLOOR_START_DBFS;
    this.limit = 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The front end
// ---------------------------------------------------------------------------------------------------------------

export type FrontEndStats = {
  /** Clipped samples over clipped samples plus the rest, last second of the raw capture. */
  clipRate: number;
  /** Clipped samples since the last reset (exact). */
  clipCount: number;
  /** Runs of three or more clipped samples in a row since the last reset (exact). */
  clipRuns: number;
  /** The last second crossed 0.1 % clipped samples or five runs of three. */
  clipped: boolean;
  peakDbfs: number;
  rmsDbfs: number;
  agcGainDb: number;
  hpf: boolean;
  agc: AgcMode;
  decimator: DecimatorKind;
  /** Stages skipped because they threw. */
  faults: number;
};

export class FrontEndDsp {
  private cfg: FrontEndConfig;
  private readonly highPass = new HighPass();
  private readonly meter = new ClipMeter();
  private readonly gain = new SlowAgc();
  private resampler: KaiserResampler | null = null;
  private faults = 0;
  private consecutiveFaults = 0;

  constructor(config: Partial<FrontEndConfig> = {}) {
    this.cfg = { ...FRONT_END_DEFAULTS };
    this.configure(config);
  }

  configure(next: Partial<FrontEndConfig>): void {
    const cfg = { ...this.cfg };
    if (typeof next.hpf === "boolean") cfg.hpf = next.hpf;
    if (typeof next.clipWarn === "boolean") cfg.clipWarn = next.clipWarn;
    if (next.agc === "browser" || next.agc === "own" || next.agc === "off") cfg.agc = next.agc;
    if (next.decimator === "fir" || next.decimator === "boxcar") cfg.decimator = next.decimator;
    if (cfg.hpf !== this.cfg.hpf) this.highPass.reset();
    if (cfg.decimator !== this.cfg.decimator) this.resampler = null;
    if (cfg.agc !== this.cfg.agc) this.gain.reset();
    this.cfg = cfg;
    this.consecutiveFaults = 0;
  }

  config(): FrontEndConfig {
    return { ...this.cfg };
  }

  private fault(): void {
    this.faults += 1;
    this.consecutiveFaults += 1;
    if (this.consecutiveFaults >= MAX_FAULTS) {
      // Fail to today's path: nothing of the front end stays in the audio.
      this.cfg = { ...this.cfg, hpf: false, agc: "off", decimator: "boxcar", clipWarn: false };
      this.resampler = null;
    }
  }

  /** Clip meter and high-pass at the native rate. Returns the input itself when nothing changes it. Never throws. */
  pre(samples: ArrayLike<number>, rate: number, atMono: number): ArrayLike<number> {
    if (samples.length === 0 || !(rate > 0)) return samples;
    try {
      if (this.cfg.clipWarn) this.meter.push(samples, atMono);
      const out = this.cfg.hpf ? this.highPass.process(samples, rate) : samples;
      this.consecutiveFaults = 0;
      return out;
    } catch {
      this.fault();
      return samples;
    }
  }

  /** Decimate to 16 kHz (when the rate is above it), then the own AGC. Never throws. */
  post(samples: ArrayLike<number>, rate: number): Float32Array {
    try {
      let mono: Float32Array;
      if (rate > FRONT_END_RATE) {
        if (this.cfg.decimator === "fir") {
          if (!this.resampler || this.resampler.fromRate !== rate) {
            this.resampler = new KaiserResampler(rate, FRONT_END_RATE);
          }
          mono = this.resampler.push(samples);
        } else {
          mono = boxcarDecimate(samples, rate);
        }
      } else {
        mono =
          samples instanceof Float32Array
            ? samples
            : Float32Array.from(samples, (v) => Number(v) || 0);
      }
      const out = this.cfg.agc === "own" ? this.gain.process(mono, FRONT_END_RATE) : mono;
      this.consecutiveFaults = 0;
      return out;
    } catch {
      this.fault();
      return boxcarDecimate(samples, rate);
    }
  }

  /**
   * The whole chain for one frame. `aec` receives the high-passed native-rate frame and returns that frame
   * cleaned as 16 kHz samples, or null to carry on without it. The result is 16 kHz.
   */
  process(
    raw: ArrayLike<number>,
    rate: number,
    atMono: number,
    aec?: (highPassed: ArrayLike<number>) => Float32Array | null,
  ): Float32Array {
    const filtered = this.pre(raw, rate, atMono);
    const cleaned = aec ? aec(filtered) : null;
    if (cleaned && cleaned.length > 0) return this.post(cleaned, FRONT_END_RATE);
    return this.post(filtered, rate);
  }

  stats(): FrontEndStats {
    const w = this.meter.window();
    return {
      clipRate: w.n ? w.clip / w.n : 0,
      clipCount: this.meter.total,
      clipRuns: this.meter.runs,
      clipped: w.n > 0 && (w.clip / w.n >= CLIP_FRACTION_FLAG || w.runs >= CLIP_RUNS_FLAG),
      peakDbfs: db(w.peak),
      rmsDbfs: db(w.n ? Math.sqrt(w.sumSq / w.n) : 0),
      agcGainDb: this.cfg.agc === "own" ? this.gain.gainDb : 0,
      hpf: this.cfg.hpf,
      agc: this.cfg.agc,
      decimator: this.cfg.decimator,
      faults: this.faults,
    };
  }

  /** Forget every filter memory and counter (the microphone closed). The configuration stays. */
  reset(): void {
    this.highPass.reset();
    this.meter.reset();
    this.gain.reset();
    this.resampler?.reset();
    this.consecutiveFaults = 0;
  }
}

const shared = new FrontEndDsp();

export function configureFrontEnd(cfg: Partial<FrontEndConfig>): void {
  shared.configure(cfg);
}

export function frontEndStats(): FrontEndStats {
  return shared.stats();
}

export function processFrontEnd(
  raw: ArrayLike<number>,
  rate: number,
  atMono: number,
  aec?: (highPassed: ArrayLike<number>) => Float32Array | null,
): Float32Array {
  return shared.process(raw, rate, atMono, aec);
}

export function resetFrontEnd(): void {
  shared.reset();
}
