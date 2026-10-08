/** First-party capture maths. Samples stay in memory for the turn. */

export function removeDc(samples: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < samples.length; i += 1) mean += samples[i] ?? 0;
  mean = samples.length ? mean / samples.length : 0;
  const out = new Float32Array(samples.length);
  let last = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = (samples[i] ?? 0) - mean;
    last = sample - last * 0.995;
    out[i] = sample + last * 0.995;
  }
  return out;
}

export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export function agc(samples: Float32Array, target = 0.1): Float32Array {
  const level = rms(samples);
  const gain = level > 1e-6 ? Math.min(8, target / level) : 1;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = (samples[i] ?? 0) * gain;
    out[i] = Math.max(-1, Math.min(1, sample));
  }
  return out;
}

export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || !samples.length) return new Float32Array();
  if (fromRate === toRate) return samples.slice();
  const outLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = (i * fromRate) / toRate;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const mix = position - left;
    const a = samples[left] ?? 0;
    const b = samples[right] ?? a;
    out[i] = a + (b - a) * mix;
  }
  return out;
}

/** Four-tap windowed sinc. Used when the rate ratio is not 1. */
export function polyphaseResample(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  const linear = resampleLinear(samples, fromRate, toRate);
  if (linear.length < 4) return linear;
  const kernel = [0.1, 0.4, 0.4, 0.1];
  const out = new Float32Array(linear.length);
  for (let i = 0; i < linear.length; i += 1) {
    let sum = 0;
    for (let tap = 0; tap < kernel.length; tap += 1) {
      const index = Math.min(linear.length - 1, i + tap);
      sum += (linear[index] ?? 0) * (kernel[tap] ?? 0);
    }
    out[i] = sum;
  }
  return out;
}

export function spectralGate(samples: Float32Array, frame = 160): Float32Array {
  const out = samples.slice();
  const floors: number[] = [];
  for (let start = 0; start < samples.length; start += frame) {
    floors.push(rms(samples.subarray(start, Math.min(samples.length, start + frame))));
  }
  floors.sort((a, b) => a - b);
  const mid = floors[Math.floor(floors.length / 2)] ?? 0;
  const gate = mid * 1.5;
  for (let start = 0; start < samples.length; start += frame) {
    const slice = samples.subarray(start, Math.min(samples.length, start + frame));
    if (rms(slice) >= gate || rms(slice) > 0.05) continue;
    for (let i = 0; i < slice.length; i += 1) out[start + i] = (slice[i] ?? 0) * 0.05;
  }
  return out;
}

export function sine(rate: number, hz: number, seconds: number, amplitude = 0.4): Float32Array {
  const length = Math.max(0, Math.floor(rate * seconds));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * amplitude;
  return out;
}

export class SampleRing {
  private readonly data: Float32Array;
  private write = 0;
  private count = 0;

  constructor(capacity: number) {
    this.data = new Float32Array(Math.max(1, capacity));
  }

  push(samples: ArrayLike<number>): number {
    let dropped = 0;
    for (let i = 0; i < samples.length; i += 1) {
      if (this.count === this.data.length) dropped += 1;
      this.data[this.write] = samples[i] ?? 0;
      this.write = (this.write + 1) % this.data.length;
      this.count = Math.min(this.data.length, this.count + 1);
    }
    return dropped;
  }

  snapshot(): Float32Array {
    const out = new Float32Array(this.count);
    const start = (this.write - this.count + this.data.length) % this.data.length;
    for (let i = 0; i < this.count; i += 1) out[i] = this.data[(start + i) % this.data.length] ?? 0;
    return out;
  }
}
