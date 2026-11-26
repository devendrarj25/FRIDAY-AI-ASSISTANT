/**
 * FRIDAY · acoustic echo canceller for audio FRIDAY plays itself.
 *
 * When FRIDAY plays a stream she owns (a realtime session's answer), she knows exactly what the speaker is
 * doing. That is the reference a canceller needs, and it is why this can work without a native module: the
 * far-end signal is pushed in with its time, the microphone frames are pushed through `process`, and what
 * comes out has the speaker's echo taken away.
 *
 *   · the bulk delay (speaker and microphone latency, tens to hundreds of ms) is found by FFT cross-correlation
 *     with a phase transform over the last half second, averaged over searches, and the filter is centred on it;
 *   · a proportionate NLMS adaptive filter (`taps` long) models the room between speaker and microphone: taps that
 *     already carry echo learn faster, and the step is larger until the filter has converged;
 *   · learning stops while the reference is silent, and while the owner talks over the echo: a Geigel guard on
 *     peaks, and, once the filter has converged, a dominant-near-end test (the microphone is more than
 *     `nearEndRatio` times louder than the echo the filter predicts) or a filter that stopped explaining the
 *     microphone. A long stretch of that adapts only with a small step, so a changed room is still followed;
 *   · the first `warmupMs` of audible reference are passed through unchanged, unless the filter has already
 *     converged: a half-learned filter is not trusted with the owner's voice;
 *   · a clock drift tracker follows the bulk delay over time (a line through the delay searches). A sample clock
 *     that runs a little fast or slow moves the echo along a few samples a second, faster than an NLMS filter can
 *     follow; the slope of that line is the offset in ppm, and the reference is resampled (windowed-sinc, at
 *     `index - drift(index)`) so the filter sees a steady room. A line that is only measurement noise counts as no
 *     drift;
 *   · an optional residual suppressor (`suppressor`, default off) lowers what a converged filter still leaves in
 *     the echo-only stretches, and does nothing while the owner talks;
 *   · five failures in a row switch the canceller to plain passthrough until `reset`; it never raises an
 *     exception into the audio path unless even the passthrough copy cannot be made.
 * Measured only on simulated echo paths (see the tests); a real room, a real speaker and real device clocks on
 * the owner's PC have not been measured. All positions are absolute sample indices on one shared timeline at
 * `rate`.
 */

export type EchoOptions = {
  rate?: number;
  /** Filter length in samples. 512 at 16 kHz is 32 ms of room response. */
  taps?: number;
  /** NLMS step size, 0..1. */
  mu?: number;
  /** Longest bulk delay searched, in ms. */
  maxDelayMs?: number;
  /** Near-end louder than this fraction of the far-end peak counts as double talk. */
  geigel?: number;
  /** How far ahead of the speaker the reference may be pushed (the playback queue bound), in ms. */
  lookaheadMs?: number;
  /** Audible reference passed through while the filter is not trusted, in ms; 0 turns the warm-up off. */
  warmupMs?: number;
  /** A converged filter that predicts an echo this many times quieter than the microphone: near end dominates. */
  nearEndRatio?: number;
  /** Follow a clock offset between the speaker and the microphone (default on). */
  driftTracking?: boolean;
  /** Lower the residual echo of a converged filter (default off). */
  suppressor?: boolean;
};

export type EchoStats = {
  delayMs: number;
  /** Echo return loss enhancement over the last second, in dB; null until there is enough echo to judge. */
  erleDb: number | null;
  doubleTalkFrames: number;
  processedSamples: number;
  /**
   * How sure the last delay search was: the correlation peak and the runner-up, each as a multiple of the mean
   * correlation over all lags (a clear lock is well above 6), and how many searches ran.
   */
  delaySearch: { best: number; second: number; searches: number };
  /** The clock offset the drift tracker follows, in parts per million (positive: the echo arrives later and later). */
  driftPpm: number;
  /** True while audible reference is still being passed through (warm-up). */
  warmingUp: boolean;
  /** True once the filter has explained the microphone well for a quarter of a second. */
  converged: boolean;
  /** Frames the canceller failed on, and whether it has switched itself to passthrough. */
  failures: number;
  disabled: boolean;
  /** How far the residual suppressor is pulling the output down right now, in dB (0 when off or idle). */
  suppressionDb: number;
};

const ACTIVE_ENERGY_PER_TAP = 1e-5;

/** A sample the canceller can use: anything that is not a finite number is silence. */
const clean = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
/** After this many failures in a row the canceller passes everything through. */
export const MAX_AEC_FAILURES = 5;
const SEARCH_SECONDS = 0.5;
const SEARCH_FAST_S = 0.25;
const SEARCH_SLOW_S = 1;
/** The speech band the correlation looks at. */
const BAND_LOW_HZ = 150;
const BAND_HIGH_HZ = 3800;
/** Exclusion around the best lag when looking for a runner-up, in ms. */
const SECOND_EXCLUDE_MS = 3;
const LOCK_PEAK_TO_MEAN = 6;
const LOCK_PEAK_TO_SECOND = 1.25;
const CONVERGED_RATIO = 0.2;
const CONVERGED_HOLD_S = 0.25;
const CONVERGED_WINDOW_S = 0.5;
/** Learning stays frozen this long after the near end starts to dominate, then crawls. */
const DOMINANT_HOLD_S = 0.3;
const SUPPRESSOR_FLOOR = 0.1;
/** The residual echo estimate is taken this many times over, as in spectral subtraction, so a little too much is removed rather than too little. */
const SUPPRESSOR_OVERSUBTRACT = 1.5;
/** Largest clock offset believed, as a ratio (1000 ppm), and how the drift line is built. */
const MAX_DRIFT = 1e-3;
const LAG_HISTORY = 20;
const DRIFT_MIN_SPAN_S = 2.5;
/** IPNLMS proportionality: -1 is plain NLMS, towards 1 favours the taps that already carry echo. */
const PROPORTION = -0.5;

const SINC_TAPS = 32;
const SINC_PHASES = 512;
let sincTableCache: Float32Array | null = null;

/** Windowed-sinc fractional-delay kernels: row `p` reads between two samples at fraction p / SINC_PHASES. */
function sincTable(): Float32Array {
  if (sincTableCache) return sincTableCache;
  const table = new Float32Array(SINC_PHASES * SINC_TAPS);
  const half = SINC_TAPS / 2;
  for (let p = 0; p < SINC_PHASES; p += 1) {
    const f = p / SINC_PHASES;
    let sum = 0;
    for (let t = 0; t < SINC_TAPS; t += 1) {
      const x = t - (half - 1) - f;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const v = sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / half));
      table[p * SINC_TAPS + t] = v;
      sum += v;
    }
    for (let t = 0; t < SINC_TAPS; t += 1)
      table[p * SINC_TAPS + t] = table[p * SINC_TAPS + t]! / sum;
  }
  sincTableCache = table;
  return table;
}

/** In-place iterative radix-2 FFT with tables built once per size. */
class Fft {
  readonly n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Int32Array;

  constructor(n: number) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i += 1) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Int32Array(n);
    let bits = 0;
    while (1 << bits < n) bits += 1;
    for (let i = 0; i < n; i += 1) {
      let r = 0;
      for (let b = 0; b < bits; b += 1) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward uses exp(-j...), inverse exp(+j...) and is not scaled. */
  transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.n;
    for (let i = 0; i < n; i += 1) {
      const j = this.rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k += 1) {
          const wr = this.cos[k * step]!;
          const wi = sign * this.sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

type SearchBuffers = {
  fft: Fft;
  zr: Float64Array;
  zi: Float64Array;
  sr: Float64Array;
  si: Float64Array;
};

export class EchoCanceller {
  readonly rate: number;
  private readonly taps: number;
  private readonly mu: number;
  private readonly geigel: number;
  private readonly maxDelay: number;
  private readonly warmup: number;
  private readonly nearEndRatio: number;
  private readonly driftOn: boolean;
  private readonly suppress: boolean;
  private readonly ref: Float32Array;
  private readonly mask: number;
  private refEnd = 0;
  private readonly w: Float32Array;
  private delay = 0;
  private delayKnown = false;
  private doubleTalk = 0;
  private processed = 0;
  private framesSinceSearch = 0;
  private echoPower = 0;
  private residualPower = 0;
  private nearIndexNext: number | null = null;
  private lastPeak = { best: 0, second: 0, searches: 0 };
  /** The last stretch of microphone samples, for the delay search. */
  private readonly nearRaw = new Float32Array(1 << 16);
  private xbuf = new Float32Array(0);
  private search: SearchBuffers | null = null;
  private corrAcc: Float32Array;
  private pendingWanted: number | null = null;
  // loudness trackers (about 10 ms) for the double-talk and suppressor decisions
  private readonly aP: number;
  private pd = 0;
  private py = 0;
  private pe = 0;
  private pxe = 0;
  private pxx = 0;
  // adaptation state
  /** Index (in processed samples) where the reference first became audible after a reset, or -1. */
  private startedAt = -1;
  private converged = false;
  private convErr = 0;
  private convNear = 0;
  private convCount = 0;
  private dtRun = 0;
  // clock drift: the reference is read at `idx - phi(idx)`, phi growing at `eps` samples per sample
  private eps = 0;
  private phi0 = 0;
  private phiAt = 0;
  private lags: { t: number; lag: number }[] = [];
  private curEnv: Float32Array;
  // suppressor
  private rho = 0.1;
  private gain = 1;
  // failure fallback
  private failStreak = 0;
  private failures = 0;
  private disabled = false;

  constructor(options: EchoOptions = {}) {
    this.rate = options.rate ?? 16_000;
    this.taps = options.taps ?? 512;
    this.mu = options.mu ?? 0.4;
    this.geigel = options.geigel ?? 0.6;
    this.maxDelay = Math.round(((options.maxDelayMs ?? 500) / 1000) * this.rate);
    this.warmup = Math.round(((options.warmupMs ?? 2500) / 1000) * this.rate);
    this.nearEndRatio = options.nearEndRatio ?? 4;
    this.driftOn = options.driftTracking !== false;
    this.suppress = options.suppressor === true;
    this.aP = 1 / Math.max(8, 0.01 * this.rate);
    let size = 1;
    const lookahead = Math.round(((options.lookaheadMs ?? 6000) / 1000) * this.rate);
    while (size < this.maxDelay + this.taps + lookahead + this.rate) size <<= 1;
    this.ref = new Float32Array(size);
    this.mask = size - 1;
    this.w = new Float32Array(this.taps);
    this.corrAcc = new Float32Array(this.maxDelay + 1);
    this.curEnv = new Float32Array(this.maxDelay + 1);
  }

  /** Far-end samples that start at absolute index `start`. A gap before `start` is silence. */
  pushReference(start: number, samples: ArrayLike<number>): void {
    if (samples.length === 0) return;
    if (start > this.refEnd) {
      const gap = Math.min(start - this.refEnd, this.ref.length);
      for (let i = 0; i < gap; i += 1) this.ref[(start - gap + i) & this.mask] = 0;
    }
    for (let i = 0; i < samples.length; i += 1)
      this.ref[(start + i) & this.mask] = clean(samples[i]);
    this.refEnd = Math.max(this.refEnd, start + samples.length);
  }

  private far(index: number): number {
    if (index < 0 || index >= this.refEnd || index < this.refEnd - this.ref.length) return 0;
    return this.ref[index & this.mask] ?? 0;
  }

  /**
   * Clean one microphone frame that starts at absolute index `start` (continuing from the previous frame when
   * omitted). Returns a new array of the same length. A failure inside returns the frame unchanged; five in a row
   * switch the canceller to passthrough until `reset`.
   */
  process(near: ArrayLike<number>, start?: number): Float32Array {
    const first = start ?? this.nearIndexNext ?? 0;
    if (this.disabled) return this.passthrough(near, first);
    try {
      const out = this.run(near, first);
      this.failStreak = 0;
      return out;
    } catch {
      this.failures += 1;
      this.failStreak += 1;
      if (this.failStreak >= MAX_AEC_FAILURES) this.disabled = true;
      return this.passthrough(near, first);
    }
  }

  private passthrough(near: ArrayLike<number>, first: number): Float32Array {
    const out = new Float32Array(near.length);
    for (let j = 0; j < near.length; j += 1) out[j] = clean(near[j]);
    this.nearIndexNext = first + near.length;
    this.processed += near.length;
    return out;
  }

  private run(near: ArrayLike<number>, first: number): Float32Array {
    const n = near.length;
    const T = this.taps;
    const out = new Float32Array(n);
    const w = this.w;
    this.nearIndexNext = first + n;
    // The reference a tap reads is a fixed offset from the microphone sample, so one contiguous copy of it serves the whole frame.
    const xlen = n + T - 1;
    if (this.xbuf.length < xlen) this.xbuf = new Float32Array(xlen);
    const xb = this.xbuf;
    const x0 = first - this.delay - (T - 1);
    this.fillReference(xb, x0, xlen);
    let energy = 0;
    for (let m = 0; m < T && m < xlen; m += 1) energy += xb[m]! * xb[m]!;
    const aP = this.aP;
    const mask = this.nearRaw.length - 1;
    let frameEcho = 0;
    let frameResidual = 0;
    let frameDouble = false;
    let goodErr = 0;
    let goodNear = 0;
    let goodCount = 0;
    const hold = Math.round(DOMINANT_HOLD_S * this.rate);
    // the tap that carries the most echo is the one the error is checked against
    let peakTap = Math.floor(T / 4);
    let peakW = 0;
    for (let k = 0; k < T; k += 1) {
      const a = Math.abs(w[k]!);
      if (a > peakW) {
        peakW = a;
        peakTap = k;
      }
    }
    const known = this.delayKnown;
    for (let j = 0; j < n; j += 1) {
      const i = first + j;
      const d = clean(near[j]);
      this.nearRaw[i & mask] = d;
      if (j > 0) {
        const add = xb[j + T - 1]!;
        const sub = xb[j - 1]!;
        energy += add * add - sub * sub;
        if (energy < 0) energy = 0;
      }
      const base = j + T - 1;
      let y = 0;
      let peak = 0;
      let l1 = 0;
      let weighted = 0;
      for (let k = 0; k < T; k += 1) {
        const x = xb[base - k]!;
        const wk = w[k]!;
        y += wk * x;
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
        const aw = wk < 0 ? -wk : wk;
        l1 += aw;
        weighted += aw * x * x;
      }
      const e = d - y;
      this.pd += (d * d - this.pd) * aP;
      this.py += (y * y - this.py) * aP;
      this.pe += (e * e - this.pe) * aP;
      const active = energy > ACTIVE_ENERGY_PER_TAP * T;
      if (active && this.startedAt < 0) this.startedAt = this.processed + j;
      const geigel = active && Math.abs(d) > this.geigel * peak && Math.abs(d) > 0.02;
      // What the filter leaves is the owner's voice when it has nothing to do with the reference; a filter that
      // lost the room leaves an error that still follows the reference, and must go on learning.
      const xk = xb[base - peakTap]!;
      this.pxe += (e * xk - this.pxe) * aP;
      this.pxx += (xk * xk - this.pxx) * aP;
      const uncorrelated = this.pxe * this.pxe < 0.04 * this.pe * this.pxx;
      const dominant =
        active &&
        this.converged &&
        (this.pd > this.nearEndRatio * this.py + 1e-7 ||
          (this.pe > 0.25 * this.pd && this.pd > 1e-6 && uncorrelated));
      const doubleTalk = geigel || dominant;
      if (doubleTalk) {
        frameDouble = true;
        this.dtRun += 1;
      } else {
        this.dtRun = 0;
      }
      if (active && known) {
        // Learning freezes at a peak that is clearly the owner, and for a moment when the near end dominates; a
        // long stretch of it crawls with a small step, so a room that really changed is still followed.
        let step = this.mu * (this.converged ? 1 : 1.6);
        if (geigel) step = 0;
        else if (dominant) step = this.dtRun > hold ? this.mu * 0.15 : 0;
        if (step > 0) {
          // Proportionate NLMS: a tap that carries echo learns faster than one that does not, so the sparse
          // room response (a clear first arrival, a short tail) is found and followed much sooner.
          const uniform = (1 - PROPORTION) / (2 * T);
          const share = (1 + PROPORTION) / (2 * l1 + 1e-6);
          const norm = uniform * energy + share * weighted + 1e-6;
          const gain = (Math.min(step, 1.2) * e) / norm;
          for (let k = 0; k < T; k += 1) {
            const wk = w[k]!;
            w[k] = wk + gain * (uniform + share * (wk < 0 ? -wk : wk)) * xb[base - k]!;
          }
        }
      }
      // A filter that is not trusted yet (warm-up) or one that makes the signal louder must not touch the output.
      const warming = this.isWarming(this.processed + j);
      const harmful = this.pe > 1.2 * this.pd + 1e-7;
      let y2 = known && !warming && !harmful && Math.abs(e) <= Math.abs(d) * 4 + 0.05 ? e : d;
      if (this.suppress && known && !warming) y2 = this.suppressSample(y2, active, dominant);
      out[j] = y2;
      if (active) {
        goodErr += e * e;
        goodNear += d * d;
        goodCount += 1;
        if (!doubleTalk) {
          frameEcho += d * d;
          frameResidual += y2 * y2;
        }
      }
    }
    if (!Number.isFinite(this.pe + this.py + this.pd + energy)) this.recover();
    if (frameDouble) this.doubleTalk += 1;
    const decay = 1 - n / this.rate;
    this.echoPower = this.echoPower * Math.max(0, decay) + frameEcho;
    this.residualPower = this.residualPower * Math.max(0, decay) + frameResidual;
    this.processed += n;
    this.framesSinceSearch += n;
    if (known) this.trackConvergence(goodErr, goodNear, goodCount);
    const interval = Math.round((this.delayKnown ? SEARCH_SLOW_S : SEARCH_FAST_S) * this.rate);
    if (this.framesSinceSearch >= interval) {
      this.framesSinceSearch = 0;
      this.searchDelay(first + n);
    }
    return out;
  }

  /** The residual suppressor: pull the output down where the echo estimate says the output is only residual echo. */
  private suppressSample(value: number, active: boolean, nearEnd: boolean): number {
    let target = 1;
    if (active && this.converged && !nearEnd && this.py > 1e-7) {
      const r = Math.min(1, this.pe / this.py);
      this.rho += (r - this.rho) * 0.003;
      const leak = (SUPPRESSOR_OVERSUBTRACT * this.rho * this.py) / (this.pe + 1e-9);
      target = Math.sqrt(Math.max(SUPPRESSOR_FLOOR * SUPPRESSOR_FLOOR, 1 - leak));
    }
    // fast to let the owner through, slow to close
    this.gain += (target - this.gain) * (target > this.gain ? 1 / 32 : 1 / 320);
    return value * this.gain;
  }

  /** Warm-up lasts `warmup` samples from the first audible reference, and ends early once the filter has converged. */
  private isWarming(at: number): boolean {
    return !this.converged && this.startedAt >= 0 && at - this.startedAt < this.warmup;
  }

  /**
   * The filter has converged when, over about the last half second of echo, the error was 7 dB or more below the
   * microphone for at least a quarter of a second of it. Quiet stretches count by their energy, so a pause does not
   * undo it.
   */
  private trackConvergence(err: number, near: number, count: number): void {
    if (count === 0) return;
    const keep = Math.max(0, 1 - count / (CONVERGED_WINDOW_S * this.rate));
    this.convErr = this.convErr * keep + err;
    this.convNear = this.convNear * keep + near;
    this.convCount = this.convCount * keep + count;
    if (
      this.convCount >= CONVERGED_HOLD_S * this.rate * 0.5 &&
      this.convNear > 1e-9 &&
      this.convErr / this.convNear < CONVERGED_RATIO
    )
      this.converged = true;
  }

  /** How far behind the microphone clock the reference is running at reference index `idx`, in samples. */
  private phi(idx: number): number {
    return this.phi0 + this.eps * (idx - this.phiAt);
  }

  /**
   * `out[m]` = the reference at index `from + m`, read where the clock drift puts it: at `index - phi(index)`,
   * with a 16-tap windowed-sinc interpolation when that is between samples. With no drift this is the plain read.
   */
  private fillReference(out: Float32Array, from: number, count: number): void {
    if (this.eps === 0 && this.phi0 === 0) {
      for (let m = 0; m < count; m += 1) out[m] = this.far(from + m);
      return;
    }
    const table = sincTable();
    for (let m = 0; m < count; m += 1) {
      const idx = from + m;
      const pos = idx - this.phi(idx);
      let i0 = Math.floor(pos);
      let phase = Math.round((pos - i0) * SINC_PHASES);
      if (phase === SINC_PHASES) {
        phase = 0;
        i0 += 1;
      }
      const row = phase * SINC_TAPS;
      let acc = 0;
      for (let t = 0; t < SINC_TAPS; t += 1)
        acc += table[row + t]! * this.far(i0 - SINC_TAPS / 2 + 1 + t);
      out[m] = acc;
    }
  }

  /**
   * One more measured raw lag (the reference as played against the microphone, in samples) at index `t`. A straight
   * line through the last measurements is the drift: its slope is the clock offset, and it re-anchors where the
   * reference is being read so the line and the reading agree.
   */
  private noteLag(t: number, lag: number): void {
    if (!this.driftOn) return;
    const last = this.lags[this.lags.length - 1];
    // a jump no drift explains starts a new line
    if (last && Math.abs(lag - last.lag) > this.taps / 8 + Math.abs(t - last.t) * MAX_DRIFT)
      this.lags = [];
    this.lags.push({ t, lag });
    if (this.lags.length > LAG_HISTORY) this.lags.shift();
    const first = this.lags[0]!;
    if (this.lags.length < 3 || t - first.t < DRIFT_MIN_SPAN_S * this.rate) return;
    let mt = 0;
    let ml = 0;
    for (const p of this.lags) {
      mt += p.t;
      ml += p.lag;
    }
    mt /= this.lags.length;
    ml /= this.lags.length;
    let num = 0;
    let den = 0;
    for (const p of this.lags) {
      num += (p.t - mt) * (p.lag - ml);
      den += (p.t - mt) * (p.t - mt);
    }
    const slope = den > 0 ? num / den : 0;
    let resid = 0;
    for (const p of this.lags) resid += (p.lag - (ml + slope * (p.t - mt))) ** 2;
    const rms = Math.sqrt(resid / this.lags.length);
    if (Math.abs(slope) > MAX_DRIFT || rms > 1.5) return;
    const have = this.phi(t);
    // The lines of a clock that does not drift are all measurement noise: the move over the whole line must stand
    // clearly above it before it counts as drift, and until then the reading stays where it is.
    if (Math.abs(slope) * (t - first.t) < Math.max(2, 4 * rms)) {
      this.phi0 = have;
      this.phiAt = t;
      this.eps = 0;
      return;
    }
    // where the line says the echo is now, against where the reference is being read
    const want = ml + slope * (t - mt) - Math.floor(this.taps / 4) - this.delay;
    // a measurement is good to about a third of a sample: only a real disagreement moves the reading, a little at a time
    const gap = want - have;
    this.phi0 = Math.abs(gap) < 1 ? have : have + Math.max(-0.25, Math.min(0.25, gap));
    this.phiAt = t;
    this.eps = slope;
  }

  private driftPpm(): number {
    return Math.round(this.eps * 1e6);
  }

  /**
   * Same as `process`, with the far-end reference for this very frame supplied alongside it, already on the
   * microphone clock (`echo-reference.ts` produces it): `reference` holds the samples the speaker played during
   * the frame, the same length as `near`. A null or empty reference is exactly `process(near, start)`, so
   * nothing changes for a caller that has none. The bulk delay between speaker and microphone is still found by
   * the search below.
   */
  processWithReference(
    near: ArrayLike<number>,
    reference: ArrayLike<number> | null,
    start?: number,
  ): Float32Array {
    const first = start ?? this.nearIndexNext ?? 0;
    if (reference && reference.length > 0) this.pushReference(first, reference);
    return this.process(near, first);
  }

  /** Something went non-finite: forget the room (not the reference) and learn it again. */
  private recover(): void {
    this.w.fill(0);
    this.delayKnown = false;
    this.converged = false;
    this.pd = 0;
    this.py = 0;
    this.pe = 0;
    this.pxe = 0;
    this.pxx = 0;
    this.gain = 1;
    this.eps = 0;
    this.phi0 = 0;
    this.lags = [];
    this.corrAcc.fill(0);
    this.failures += 1;
  }

  /** True after five failures in a row: every frame is passed through until `reset`. */
  isPassthrough(): boolean {
    return this.disabled;
  }

  /** The absolute index the next microphone frame continues from, or null before the first frame. */
  nextNearIndex(): number | null {
    return this.nearIndexNext;
  }

  private buffers(): SearchBuffers {
    if (!this.search) {
      const need = Math.round(SEARCH_SECONDS * this.rate) + this.maxDelay;
      let n = 1;
      while (n < need) n <<= 1;
      this.search = {
        fft: new Fft(n),
        zr: new Float64Array(n),
        zi: new Float64Array(n),
        sr: new Float64Array(n),
        si: new Float64Array(n),
      };
    }
    return this.search;
  }

  /**
   * Find the bulk delay by FFT cross-correlation with a phase transform over the last half second: the
   * correlation is whitened, so a room's colour and reverberation do not smear the peak, and the envelope of its
   * speech-band part gives the lag to a sample. Searches are averaged, so a lock needs the same lag again and
   * again, not one lucky window.
   */
  private searchDelay(upTo: number): void {
    const length = Math.round(SEARCH_SECONDS * this.rate);
    const M = this.maxDelay;
    const from = upTo - length;
    if (from < 0 || this.processed < length) return;
    const buf = this.buffers();
    const N = buf.fft.n;
    const { zr, zi, sr, si } = buf;
    zr.fill(0);
    zi.fill(0);
    const mask = this.nearRaw.length - 1;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i < length; i += 1) {
      const v = this.nearRaw[(from + i) & mask] ?? 0;
      zr[i] = v;
      ea += v * v;
    }
    for (let j = 0; j < length + M; j += 1) {
      const v = this.far(from - M + j);
      zi[j] = v;
      eb += v * v;
    }
    if (ea / length < 1e-8 || eb / (length + M) < 1e-8) return;
    buf.fft.transform(zr, zi, false);
    sr.fill(0);
    si.fill(0);
    const lo = Math.max(1, Math.round((BAND_LOW_HZ * N) / this.rate));
    const hi = Math.min(N / 2 - 1, Math.round((BAND_HIGH_HZ * N) / this.rate));
    for (let k = lo; k <= hi; k += 1) {
      const pr = zr[N - k]!;
      const pi = zi[N - k]!;
      const ar = (zr[k]! + pr) / 2;
      const ai = (zi[k]! - pi) / 2;
      const br = (zi[k]! + pi) / 2;
      const bi = -(zr[k]! - pr) / 2;
      // conj(A) * B, then the phase transform (a partial whitening keeps weak bins from being all noise)
      const cr = ar * br + ai * bi;
      const ci = ar * bi - ai * br;
      const mag = Math.hypot(cr, ci);
      const scale = 1 / (Math.pow(mag, 0.8) + 1e-12);
      sr[k] = cr * scale;
      si[k] = ci * scale;
    }
    buf.fft.transform(sr, si, true);
    const acc = this.corrAcc;
    const cur = this.curEnv;
    let sum = 0;
    let best = 0;
    let bestLag = 0;
    for (let lag = 0; lag <= M; lag += 1) {
      const m = M - lag;
      const v = Math.hypot(sr[m]!, si[m]!);
      cur[lag] = v;
      const a = acc[lag]! * 0.5 + v;
      acc[lag] = a;
      sum += a;
      if (a > best) {
        best = a;
        bestLag = lag;
      }
    }
    const mean = sum / (M + 1);
    if (mean < 1e-12) return;
    const exclude = Math.round((SECOND_EXCLUDE_MS / 1000) * this.rate);
    let second = 0;
    for (let lag = 0; lag <= M; lag += 1)
      if (Math.abs(lag - bestLag) > exclude && acc[lag]! > second) second = acc[lag]!;
    const searches = this.lastPeak.searches + 1;
    this.lastPeak = {
      best: Math.round((best / mean) * 10) / 10,
      second: Math.round((second / mean) * 10) / 10,
      searches,
    };
    if (best / mean < LOCK_PEAK_TO_MEAN || best < LOCK_PEAK_TO_SECOND * second) return;
    // the raw lag to a fraction of a sample, from this window alone (the average is for deciding, not for timing)
    let near = bestLag;
    for (let lag = Math.max(0, bestLag - 3); lag <= Math.min(M, bestLag + 3); lag += 1)
      if (cur[lag]! > cur[near]!) near = lag;
    let lagNow = near;
    if (near > 0 && near < M) {
      const l = cur[near - 1]!;
      const c = cur[near]!;
      const r = cur[near + 1]!;
      const bend = l - 2 * c + r;
      if (bend < 0) lagNow = near + Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / bend));
    }
    const wanted = Math.max(0, Math.round(lagNow) - Math.floor(this.taps / 4));
    if (!this.delayKnown) {
      this.lock(wanted, upTo);
      this.noteLag(upTo - length / 2, lagNow);
      return;
    }
    if (cur[near]! >= 4 * mean) this.noteLag(upTo - length / 2, lagNow);
    // measured against where the reference is being read now, so a followed drift is no change at all
    const have = this.delay + this.phi(upTo);
    if (Math.abs(wanted - have) <= this.taps / 4) {
      this.pendingWanted = null;
      return;
    }
    // A known delay moves only when two searches in a row agree on the new one.
    if (this.pendingWanted !== null && Math.abs(wanted - this.pendingWanted) <= this.taps / 8) {
      this.lock(wanted, upTo);
    } else {
      this.pendingWanted = wanted;
    }
  }

  private lock(wanted: number, at: number): void {
    this.delay = wanted;
    this.delayKnown = true;
    this.pendingWanted = null;
    this.w.fill(0);
    this.converged = false;
    this.convErr = 0;
    this.convNear = 0;
    this.convCount = 0;
    this.eps = 0;
    this.phi0 = 0;
    this.phiAt = at;
    this.lags = [];
    this.corrAcc.fill(0);
  }

  stats(): EchoStats {
    const erle =
      this.residualPower > 1e-9 && this.echoPower > 1e-9
        ? Math.round(10 * Math.log10(this.echoPower / this.residualPower) * 10) / 10
        : null;
    return {
      delayMs: Math.round((this.delay / this.rate) * 1000),
      erleDb: this.delayKnown ? erle : null,
      doubleTalkFrames: this.doubleTalk,
      processedSamples: this.processed,
      delaySearch: { ...this.lastPeak },
      driftPpm: this.driftPpm(),
      warmingUp: this.delayKnown && this.isWarming(this.processed),
      converged: this.converged,
      failures: this.failures,
      disabled: this.disabled,
      suppressionDb: this.suppress
        ? Math.round(-20 * Math.log10(Math.max(1e-3, this.gain)) * 10) / 10
        : 0,
    };
  }

  /** Forget the room: a new device or a long pause starts from scratch. */
  reset(): void {
    this.ref.fill(0);
    this.refEnd = 0;
    this.w.fill(0);
    this.delay = 0;
    this.delayKnown = false;
    this.echoPower = 0;
    this.residualPower = 0;
    this.doubleTalk = 0;
    this.processed = 0;
    this.nearIndexNext = null;
    this.framesSinceSearch = 0;
    this.lastPeak = { best: 0, second: 0, searches: 0 };
    this.corrAcc.fill(0);
    this.pendingWanted = null;
    this.pd = 0;
    this.py = 0;
    this.pe = 0;
    this.pxe = 0;
    this.pxx = 0;
    this.startedAt = -1;
    this.converged = false;
    this.convErr = 0;
    this.convNear = 0;
    this.convCount = 0;
    this.dtRun = 0;
    this.eps = 0;
    this.phi0 = 0;
    this.phiAt = 0;
    this.lags = [];
    this.rho = 0.1;
    this.gain = 1;
    this.failStreak = 0;
    this.failures = 0;
    this.disabled = false;
  }
}
