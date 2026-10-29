/** Small real DFT, log-mel and MFCC. Reference checks use these same functions. */

const MEL_BANDS = 8;
const MFCC = 6;

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

export function dftMagnitude(frame: ArrayLike<number>): number[] {
  const n = frame.length;
  const out: number[] = [];
  for (let k = 0; k < n; k += 1) {
    let real = 0;
    let imag = 0;
    for (let t = 0; t < n; t += 1) {
      const sample = frame[t] ?? 0;
      const angle = (2 * Math.PI * k * t) / n;
      real += sample * Math.cos(angle);
      imag -= sample * Math.sin(angle);
    }
    out.push(Math.sqrt(real * real + imag * imag));
  }
  return out;
}

export function logMel(magnitude: number[], rate: number): number[] {
  const n = magnitude.length;
  const low = hzToMel(0);
  const high = hzToMel(rate / 2);
  const bands = new Array<number>(MEL_BANDS).fill(0);
  const counts = new Array<number>(MEL_BANDS).fill(0);
  for (let bin = 0; bin < n; bin += 1) {
    const hz = (bin * rate) / n;
    const mel = hzToMel(hz);
    const position = ((mel - low) / Math.max(1, high - low)) * (MEL_BANDS - 1);
    const index = Math.max(0, Math.min(MEL_BANDS - 1, Math.round(position)));
    bands[index] = (bands[index] ?? 0) + (magnitude[bin] ?? 0);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return bands.map((sum, index) => Math.log1p(sum / Math.max(1, counts[index] ?? 1)));
}

export function mfcc(mel: number[]): number[] {
  const out: number[] = [];
  for (let coeff = 0; coeff < MFCC; coeff += 1) {
    let sum = 0;
    for (let band = 0; band < mel.length; band += 1) {
      sum += (mel[band] ?? 0) * Math.cos((Math.PI * coeff * (band + 0.5)) / mel.length);
    }
    out.push(sum);
  }
  return out;
}

export function deltas(rows: number[][]): number[][] {
  return rows.map((row, index) => {
    const prev = rows[index - 1] ?? row;
    return row.map((value, band) => value - (prev[band] ?? 0));
  });
}

export function featuresFor(
  frame: ArrayLike<number>,
  rate: number,
): { mel: number[]; mfcc: number[]; delta: number[] } {
  const mel = logMel(dftMagnitude(frame), rate);
  const coeffs = mfcc(mel);
  const delta = deltas([coeffs])[0] ?? [];
  return { mel, mfcc: coeffs, delta };
}

export function peakBin(frame: ArrayLike<number>): number {
  const magnitude = dftMagnitude(frame);
  let best = 0;
  let peak = -1;
  magnitude.forEach((value, index) => {
    if (value > peak) {
      peak = value;
      best = index;
    }
  });
  return best;
}
