/**
 * FRIDAY · acoustic features of a barge-in candidate (shadow only).
 *
 * Five cheap numbers from the echo-clean frames that triggered a possible interruption: how abrupt the onset is,
 * how long the voice lasted, how loud it was, how noisy its waveform is (zero crossings) and how much its pitch
 * moves (autocorrelation over voiced windows). The interruption controller copies them into the decision trace so
 * a later round can learn whether a cough, a door or a TV differs from the owner's real takeover. Nothing here
 * decides anything. Pure: no DOM, no timer, no clock, no random; the input frames are never modified.
 *
 * Empty, silent, very short or hostile input (NaN, Infinity, values beyond full scale) gives finite numbers, and
 * all zeros when no voice is found. Work is bounded: one pass over the samples plus at most MAX_PITCH_WINDOWS
 * autocorrelations, however long the input is.
 */

export type AcousticFeatures = {
  /** Steepest rise of the frame level, in dB per 10 ms, over the first 100 ms of voice. 0 without voice. */
  onsetSlopeDb: number;
  /** Total length of the frames that carry voice, in milliseconds. */
  voicedMs: number;
  /** Level of the voiced samples in dBFS (at most 0). 0 when there is no voice. */
  rmsDb: number;
  /** Zero crossings per sample over the voiced frames, 0 to 1. A tone is low, a noise burst near 0.5. */
  zcr: number;
  /** Standard deviation of the pitch in cents over the periodic windows. 0 when fewer than two are found. */
  pitchVarCents: number;
};

/** Optional work counter: `ops` grows by the samples read and the multiplications done. */
export type WorkMeter = { ops: number };

/** A frame whose level is below this is silence for the voiced count. */
export const VOICED_FLOOR_DB = -50;
/** Lowest level used for the onset slope, so a start from digital zero stays finite. */
export const ONSET_FLOOR_DB = -60;
/** How much voice after its start the onset slope looks at. */
export const ONSET_SPAN_MS = 100;
/** Pitch search range in Hz and the analysis window. */
export const PITCH_MIN_HZ = 60;
export const PITCH_MAX_HZ = 400;
export const PITCH_WINDOW_MS = 40;
export const PITCH_HOP_MS = 20;
/** A window counts as periodic only when its normalised autocorrelation peak reaches this. */
export const PITCH_MIN_PEAK = 0.5;
/** Upper bound of autocorrelation windows per call, whatever the input length. */
export const MAX_PITCH_WINDOWS = 48;

const ZERO: AcousticFeatures = Object.freeze({
  onsetSlopeDb: 0,
  voicedMs: 0,
  rmsDb: 0,
  zcr: 0,
  pitchVarCents: 0,
});

const round3 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);
/** One sample, made safe: non-numbers and NaN become 0, the rest is held inside full scale. */
const clean = (x: number | undefined): number => {
  if (typeof x !== "number" || x !== x) return 0;
  return x > 1 ? 1 : x < -1 ? -1 : x;
};
const toDb = (ms: number): number => (ms > 1e-9 ? 10 * Math.log10(ms) : -120);

type Pitch = number | null;

/** Pitch of one window in Hz by normalised autocorrelation, or null when it is not periodic. */
function windowPitch(
  x: Float32Array,
  start: number,
  len: number,
  sampleRate: number,
  meter: WorkMeter | undefined,
): Pitch {
  const minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));
  const maxLag = Math.min(len - 2, Math.ceil(sampleRate / PITCH_MIN_HZ));
  if (maxLag - minLag < 2) return null;
  let r0 = 0;
  for (let i = 0; i < len; i += 1) {
    const s = clean(x[start + i]);
    r0 += s * s;
  }
  if (r0 / len < 10 ** (VOICED_FLOOR_DB / 10)) return null;
  const r = new Float64Array(maxLag + 2);
  let best = -1;
  for (let lag = minLag; lag <= maxLag + 1 && lag < len; lag += 1) {
    let acc = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i + lag < len; i += 1) {
      const a = clean(x[start + i]);
      const b = clean(x[start + i + lag]);
      acc += a * b;
      ea += a * a;
      eb += b * b;
    }
    if (meter) meter.ops += (len - lag) * 3;
    const norm = Math.sqrt(ea * eb);
    r[lag] = norm > 1e-12 ? acc / norm : 0;
    if (lag <= maxLag && r[lag]! > best) best = r[lag]!;
  }
  if (best < PITCH_MIN_PEAK) return null;
  // The first local peak near the best one avoids picking a multiple of the period.
  let pick = -1;
  for (let lag = minLag + 1; lag <= maxLag; lag += 1) {
    const v = r[lag]!;
    if (v >= 0.9 * best && v >= r[lag - 1]! && v >= r[lag + 1]!) {
      pick = lag;
      break;
    }
  }
  if (pick < 0) return null;
  const a = r[pick - 1]!;
  const b = r[pick]!;
  const c = r[pick + 1]!;
  const denom = a - 2 * b + c;
  const shift =
    Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  const hz = sampleRate / (pick + shift);
  return Number.isFinite(hz) && hz > 0 ? hz : null;
}

/**
 * The five features of the frames that raised a barge-in candidate. `frames` are mono Float32 blocks in time
 * order (any length each), `sampleRate` in Hz. Never throws and never returns NaN.
 */
export function acousticFeatures(
  frames: Float32Array[],
  sampleRate: number,
  meter?: WorkMeter,
): AcousticFeatures {
  if (!Array.isArray(frames) || !(typeof sampleRate === "number" && sampleRate > 0))
    return { ...ZERO };
  if (!Number.isFinite(sampleRate)) return { ...ZERO };

  // Pass 1: level of every frame, and the voiced totals.
  const levels: number[] = [];
  const durs: number[] = [];
  const voiced: boolean[] = [];
  let total = 0;
  let voicedMs = 0;
  let voicedEnergy = 0;
  let voicedSamples = 0;
  let crossings = 0;
  for (const f of frames) {
    if (!(f instanceof Float32Array) || f.length === 0) continue;
    let e = 0;
    let zc = 0;
    let prev = 0;
    for (let i = 0; i < f.length; i += 1) {
      const s = clean(f[i]);
      e += s * s;
      if (i > 0 && s > 0 !== prev > 0 && s !== 0 && prev !== 0) zc += 1;
      if (s !== 0) prev = s;
    }
    if (meter) meter.ops += f.length;
    const ms = (f.length / sampleRate) * 1000;
    const db = toDb(e / f.length);
    const isVoiced = db >= VOICED_FLOOR_DB;
    levels.push(Math.max(ONSET_FLOOR_DB, Math.min(0, db)));
    durs.push(ms);
    voiced.push(isVoiced);
    total += f.length;
    if (isVoiced) {
      voicedMs += ms;
      voicedEnergy += e;
      voicedSamples += f.length;
      crossings += zc;
    }
  }
  if (voicedSamples === 0) return { ...ZERO };

  // Onset: the steepest rise in the first ONSET_SPAN_MS of voice, per 10 ms.
  const first = voiced.indexOf(true);
  let slope = 0;
  let spanned = 0;
  for (let i = first; i < levels.length && spanned < ONSET_SPAN_MS; i += 1) {
    const before = i === 0 ? ONSET_FLOOR_DB : levels[i - 1]!;
    const rise = ((levels[i]! - before) / Math.max(durs[i]!, 1e-6)) * 10;
    if (rise > slope) slope = rise;
    spanned += durs[i]!;
  }

  // Pitch: autocorrelation windows over the joined signal, at most MAX_PITCH_WINDOWS of them.
  const joined = new Float32Array(total);
  let at = 0;
  for (const f of frames) {
    if (!(f instanceof Float32Array) || f.length === 0) continue;
    joined.set(f, at);
    at += f.length;
  }
  const win = Math.round((PITCH_WINDOW_MS / 1000) * sampleRate);
  const hop = Math.max(1, Math.round((PITCH_HOP_MS / 1000) * sampleRate));
  const logs: number[] = [];
  if (total >= win) {
    const count = Math.floor((total - win) / hop) + 1;
    const step = Math.max(1, Math.ceil(count / MAX_PITCH_WINDOWS));
    for (let w = 0; w < count; w += step) {
      const hz = windowPitch(joined, w * hop, win, sampleRate, meter);
      if (hz !== null) logs.push(1200 * Math.log2(hz));
    }
  }
  let pitchVar = 0;
  if (logs.length >= 2) {
    const mean = logs.reduce((s, v) => s + v, 0) / logs.length;
    pitchVar = Math.sqrt(logs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / logs.length);
  }

  const rmsDb = Math.min(0, toDb(voicedEnergy / voicedSamples));
  return {
    onsetSlopeDb: round3(slope),
    voicedMs: round3(voicedMs),
    rmsDb: round3(rmsDb),
    zcr: round3(crossings / voicedSamples),
    pitchVarCents: round3(pitchVar),
  };
}
