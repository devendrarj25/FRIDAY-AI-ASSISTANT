/**
 * FRIDAY · acoustic echo canceller for audio FRIDAY plays itself.
 *
 * When FRIDAY plays a stream she owns (a realtime session's answer), she knows exactly what the speaker is
 * doing. That is the reference a canceller needs, and it is why this can work without a native module: the
 * far-end signal is pushed in with its time, the microphone frames are pushed through `process`, and what
 * comes out has the speaker's echo taken away.
 *
 *   · bulk delay (speaker and microphone latency, tens to hundreds of ms) is found by correlating loudness
 *     envelopes, then the filter is centred on it;
 *   · an NLMS adaptive filter (`taps` long) models the room between speaker and microphone;
 *   · a Geigel double-talk guard freezes learning while the owner is talking, so her voice is not learned
 *     as echo and is kept in the output;
 *   · learning also stops while the reference is silent.
 * There is no nonlinear residual suppressor. Measured only on simulated echo paths (see the tests); a real room
 * and a real speaker on the owner's PC have not been measured. All positions are absolute sample indices on one
 * shared timeline at `rate`.
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
};

export type EchoStats = {
  delayMs: number;
  /** Echo return loss enhancement over the last second, in dB; null until there is enough echo to judge. */
  erleDb: number | null;
  doubleTalkFrames: number;
  processedSamples: number;
  /** How sure the last delay search was (peak against the runner-up), for diagnostics. */
  delaySearch: { best: number; second: number; searches: number };
};

const BIN_MS = 10;

export class EchoCanceller {
  readonly rate: number;
  private readonly taps: number;
  private readonly mu: number;
  private readonly geigel: number;
  private readonly maxDelay: number;
  private readonly ref: Float32Array;
  private readonly mask: number;
  private refEnd = 0;
  private readonly w: Float32Array;
  private delay = 0;
  private delayKnown = false;
  private nearEnv: Float32Array;
  private readonly binSamples: number;
  private framesSinceSearch = 0;
  private echoPower = 0;
  private residualPower = 0;
  private doubleTalk = 0;
  private processed = 0;
  private lastBinSeen = -1;
  private binAcc = 0;
  private binCount = 0;
  private nearIndexNext: number | null = null;
  private lastPeak = { best: 0, second: 0, searches: 0 };
  /** The last stretch of microphone samples, for the fine delay search. */
  private readonly nearRaw = new Float32Array(1 << 16);
  private searchesSinceRefine = 0;

  constructor(options: EchoOptions = {}) {
    this.rate = options.rate ?? 16_000;
    this.taps = options.taps ?? 512;
    this.mu = options.mu ?? 0.4;
    this.geigel = options.geigel ?? 0.6;
    this.maxDelay = Math.round(((options.maxDelayMs ?? 500) / 1000) * this.rate);
    this.binSamples = Math.round((BIN_MS / 1000) * this.rate);
    let size = 1;
    const lookahead = Math.round(((options.lookaheadMs ?? 6000) / 1000) * this.rate);
    while (size < this.maxDelay + this.taps + lookahead + this.rate) size <<= 1;
    this.ref = new Float32Array(size);
    this.mask = size - 1;
    this.w = new Float32Array(this.taps);
    this.nearEnv = new Float32Array(512);
  }

  /** Far-end samples that start at absolute index `start`. A gap before `start` is silence. */
  pushReference(start: number, samples: ArrayLike<number>): void {
    if (samples.length === 0) return;
    if (start > this.refEnd) {
      const gap = Math.min(start - this.refEnd, this.ref.length);
      for (let i = 0; i < gap; i += 1) this.ref[(start - gap + i) & this.mask] = 0;
    }
    for (let i = 0; i < samples.length; i += 1)
      this.ref[(start + i) & this.mask] = Number(samples[i]) || 0;
    this.refEnd = Math.max(this.refEnd, start + samples.length);
  }

  private far(index: number): number {
    if (index < 0 || index >= this.refEnd || index < this.refEnd - this.ref.length) return 0;
    return this.ref[index & this.mask] ?? 0;
  }

  /**
   * Clean one microphone frame that starts at absolute index `start` (continuing from the previous frame when
   * omitted). Returns a new array of the same length.
   */
  process(near: ArrayLike<number>, start?: number): Float32Array {
    const out = new Float32Array(near.length);
    const first = start ?? this.nearIndexNext ?? 0;
    this.nearIndexNext = first + near.length;
    let frameEcho = 0;
    let frameResidual = 0;
    let frameDouble = false;
    for (let j = 0; j < near.length; j += 1) {
      const i = first + j;
      const d = Number(near[j]) || 0;
      this.nearRaw[i & (this.nearRaw.length - 1)] = d;
      this.trackEnvelope(i, d);
      let y = 0;
      let energy = 0;
      let peak = 0;
      const base = i - this.delay;
      for (let k = 0; k < this.taps; k += 1) {
        const x = this.far(base - k);
        y += (this.w[k] ?? 0) * x;
        energy += x * x;
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
      }
      const e = d - y;
      const active = energy > 1e-5 * this.taps;
      const doubleTalk = active && Math.abs(d) > this.geigel * peak && Math.abs(d) > 0.02;
      if (doubleTalk) frameDouble = true;
      if (active && !doubleTalk && this.delayKnown) {
        const gain = (this.mu * e) / (energy + 1e-6);
        for (let k = 0; k < this.taps; k += 1) {
          this.w[k] = (this.w[k] ?? 0) + gain * this.far(base - k);
        }
      }
      // Never let the cleaned signal be louder than what came in: a diverging filter must not add noise.
      out[j] = this.delayKnown && Math.abs(e) <= Math.abs(d) * 4 + 0.05 ? e : d;
      if (active && !doubleTalk) {
        frameEcho += d * d;
        frameResidual += out[j]! * out[j]!;
      }
    }
    if (frameDouble) this.doubleTalk += 1;
    const decay = 1 - near.length / this.rate;
    this.echoPower = this.echoPower * Math.max(0, decay) + frameEcho;
    this.residualPower = this.residualPower * Math.max(0, decay) + frameResidual;
    this.processed += near.length;
    this.framesSinceSearch += near.length;
    if (this.framesSinceSearch >= this.rate / 2) {
      this.framesSinceSearch = 0;
      this.searchDelay(first + near.length);
    }
    return out;
  }

  private trackEnvelope(i: number, d: number): void {
    const bin = Math.floor(i / this.binSamples);
    if (bin !== this.lastBinSeen) {
      if (this.lastBinSeen >= 0 && this.binCount > 0) {
        this.nearEnv[this.lastBinSeen % this.nearEnv.length] = this.binAcc / this.binCount;
      }
      this.lastBinSeen = bin;
      this.binAcc = 0;
      this.binCount = 0;
    }
    this.binAcc += d < 0 ? -d : d;
    this.binCount += 1;
  }

  private refEnvelope(bin: number): number {
    const from = bin * this.binSamples;
    let sum = 0;
    for (let s = 0; s < this.binSamples; s += 1) {
      const x = this.far(from + s);
      sum += x < 0 ? -x : x;
    }
    return sum / this.binSamples;
  }

  /** Find the bulk delay by correlating loudness envelopes over the last second. */
  private searchDelay(upTo: number): void {
    const endBin = Math.floor(upTo / this.binSamples) - 2;
    const span = 100;
    const maxLag = Math.floor(this.maxDelay / this.binSamples);
    if (endBin - span - maxLag < 0) return;
    const near: number[] = [];
    for (let b = endBin - span; b < endBin; b += 1)
      near.push(this.nearEnv[b % this.nearEnv.length] ?? 0);
    const refBins: number[] = [];
    for (let b = endBin - span - maxLag; b < endBin; b += 1) refBins.push(this.refEnvelope(b));
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    const nMean = mean(near);
    const nCentered = near.map((v) => v - nMean);
    const nNorm = Math.sqrt(nCentered.reduce((s, v) => s + v * v, 0));
    if (nNorm < 1e-6) return;
    const corrs: number[] = [];
    for (let lag = 0; lag <= maxLag; lag += 1) {
      const seg = refBins.slice(maxLag - lag, maxLag - lag + span);
      const sMean = mean(seg);
      let dot = 0;
      let sNorm = 0;
      for (let k = 0; k < span; k += 1) {
        const c = (seg[k] ?? 0) - sMean;
        dot += c * (nCentered[k] ?? 0);
        sNorm += c * c;
      }
      corrs.push(sNorm < 1e-9 ? -1 : dot / (Math.sqrt(sNorm) * nNorm));
    }
    let bestLag = 0;
    for (let lag = 1; lag < corrs.length; lag += 1)
      if ((corrs[lag] ?? -1) > (corrs[bestLag] ?? -1)) bestLag = lag;
    const best = corrs[bestLag] ?? -1;
    if (best < 0.35) {
      this.lastPeak = { best, second: 0, searches: this.lastPeak.searches + 1 };
      return;
    }
    // Speech loudness repeats (syllables), so several lags can look alike. The waveform itself does not
    // repeat: the loudness peaks only nominate candidates, the raw samples choose between them.
    this.searchesSinceRefine += 1;
    if (this.delayKnown && this.searchesSinceRefine < 8) {
      this.lastPeak = { ...this.lastPeak, searches: this.lastPeak.searches + 1 };
      return;
    }
    this.searchesSinceRefine = 0;
    const candidates: number[] = [];
    for (let lag = 0; lag < corrs.length; lag += 1) {
      const c = corrs[lag] ?? -1;
      if (c < best - 0.15) continue;
      let isPeak = true;
      for (let k = Math.max(0, lag - 2); k <= Math.min(corrs.length - 1, lag + 2); k += 1) {
        if ((corrs[k] ?? -1) > c) isPeak = false;
      }
      if (isPeak) candidates.push(lag);
    }
    candidates.sort((a, b) => (corrs[b] ?? 0) - (corrs[a] ?? 0));
    const fine = this.fineLag(candidates.slice(0, 6), upTo);
    this.lastPeak = { best: fine.best, second: fine.second, searches: this.lastPeak.searches + 1 };
    if (fine.best < 0.15 || fine.best - fine.second < 0.05) return;
    const wanted = Math.max(0, fine.lag - Math.floor(this.taps / 4));
    if (!this.delayKnown || Math.abs(wanted - this.delay) > this.taps / 4) {
      this.delay = wanted;
      this.delayKnown = true;
      this.w.fill(0);
    }
  }

  /** Normalised waveform correlation around each candidate loudness lag; returns the best sample lag. */
  private fineLag(
    candidateBins: number[],
    upTo: number,
  ): { lag: number; best: number; second: number } {
    const window = Math.floor(this.rate / 4);
    const from = upTo - window;
    const mask = this.nearRaw.length - 1;
    let dEnergy = 0;
    for (let i = from; i < upTo; i += 2) {
      const d = this.nearRaw[i & mask] ?? 0;
      dEnergy += d * d;
    }
    let bestLag = 0;
    let best = -1;
    const scores: { lag: number; c: number }[] = [];
    if (dEnergy < 1e-9) return { lag: 0, best: -1, second: 0 };
    for (const bins of candidateBins) {
      let localBest = -1;
      let localLag = 0;
      const centre = bins * this.binSamples;
      for (
        let lag = Math.max(0, centre - 3 * this.binSamples);
        lag <= centre + 3 * this.binSamples;
        lag += 1
      ) {
        let dot = 0;
        let xEnergy = 0;
        for (let i = from; i < upTo; i += 2) {
          const x = this.far(i - lag);
          dot += (this.nearRaw[i & mask] ?? 0) * x;
          xEnergy += x * x;
        }
        if (xEnergy < 1e-9) continue;
        const c = dot / Math.sqrt(dEnergy * xEnergy);
        if (c > localBest) {
          localBest = c;
          localLag = lag;
        }
      }
      scores.push({ lag: localLag, c: localBest });
      if (localBest > best) {
        best = localBest;
        bestLag = localLag;
      }
    }
    let second = 0;
    for (const sc of scores)
      if (Math.abs(sc.lag - bestLag) > 2 * this.binSamples) second = Math.max(second, sc.c);
    return { lag: bestLag, best, second };
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
    };
  }

  /** Forget the room: a new device or a long pause starts from scratch. */
  reset(): void {
    this.ref.fill(0);
    this.refEnd = 0;
    this.w.fill(0);
    this.delay = 0;
    this.delayKnown = false;
    this.nearEnv.fill(0);
    this.echoPower = 0;
    this.residualPower = 0;
    this.doubleTalk = 0;
    this.processed = 0;
    this.lastBinSeen = -1;
    this.nearIndexNext = null;
    this.framesSinceSearch = 0;
  }
}
