/**
 * FRIDAY · audio format helpers for the voice engine: PCM16, mono, sample-rate conversion, base64.
 *
 * Pure functions plus one small stateful resampler for a live stream. The microphone worklet delivers Float32
 * mono frames at the device rate (usually 48 kHz); a realtime provider wants PCM16 mono at its own rate
 * (24 kHz for the OpenAI Realtime style). Nothing here allocates without a bound the caller chose.
 */

export const REALTIME_RATE = 24_000;

/**
 * Audio rates per realtime provider, mono PCM16. OpenAI style and xAI: 24 kHz both ways (xAI from secondary
 * sources only). Gemini Live: 16 kHz in and 24 kHz out, from Google's Live API reference.
 */
export const REALTIME_FORMATS: Record<string, { inputRate: number; outputRate: number }> = {
  openai: { inputRate: 24_000, outputRate: 24_000 },
  xai: { inputRate: 24_000, outputRate: 24_000 },
  gemini: { inputRate: 16_000, outputRate: 24_000 },
};

export const realtimeFormat = (provider: string): { inputRate: number; outputRate: number } =>
  REALTIME_FORMATS[provider] ?? { inputRate: REALTIME_RATE, outputRate: REALTIME_RATE };

export function floatToPcm16(input: ArrayLike<number>): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const v = Math.max(-1, Math.min(1, Number(input[i]) || 0));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1)
    out[i] = (input[i] ?? 0) / (input[i]! < 0 ? 32768 : 32767);
  return out;
}

/** Average the channels into one. An empty list gives an empty frame. */
export function downmixToMono(channels: ArrayLike<number>[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array();
  if (channels.length === 1) return Float32Array.from(first);
  const out = new Float32Array(first.length);
  for (let i = 0; i < first.length; i += 1) {
    let sum = 0;
    for (const ch of channels) sum += Number(ch[i]) || 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Streaming linear resampler. It remembers the fractional position and the last input sample between frames,
 * so frame boundaries do not click and the output length follows the rates exactly over time.
 */
export class StreamResampler {
  private pos = 0;
  private last = 0;
  private hasLast = false;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error("sample rates must be positive");
  }

  push(input: ArrayLike<number>): Float32Array {
    if (input.length === 0) return new Float32Array();
    if (this.fromRate === this.toRate) return Float32Array.from(input);
    const step = this.fromRate / this.toRate;
    const out: number[] = [];
    // Position 0 is the sample before this frame when there is one (the previous frame's last sample).
    const at = (i: number): number => (i < 0 ? this.last : Number(input[i]) || 0);
    let p = this.hasLast ? this.pos - 1 : this.pos;
    const limit = input.length - 1;
    while (p < limit) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = at(i);
      const b = at(i + 1);
      out.push(a + (b - a) * frac);
      p += step;
    }
    this.pos = p - input.length + 1;
    this.last = Number(input[input.length - 1]) || 0;
    this.hasLast = true;
    return Float32Array.from(out);
  }

  reset(): void {
    this.pos = 0;
    this.last = 0;
    this.hasLast = false;
  }
}

/**
 * Streaming band-limited resampler (windowed sinc) for a path where the error matters, such as the echo
 * reference: it low-passes below the new Nyquist and interpolates in one pass, so nothing folds back and the
 * samples stay on the original timeline. It needs a little look-ahead, so a push returns the samples whose
 * neighbourhood has arrived; `lastOffset` says where the first returned sample sits, in input samples, relative
 * to the start of the frame just pushed (about minus the look-ahead when a stream is running).
 */
export class StreamSincResampler {
  /** Input samples from the start of the last pushed frame to where its first output sample sits. */
  lastOffset = 0;
  private readonly step: number;
  private readonly cutoff: number;
  private readonly reach: number;
  private tail = new Float32Array(0);
  private tailStart = 0;
  private total = 0;
  private next = 0;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
    zeroCrossings = 12,
  ) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error("sample rates must be positive");
    this.step = fromRate / toRate;
    this.cutoff = toRate < fromRate ? 0.92 * (toRate / fromRate) : 1;
    this.reach = Math.ceil(zeroCrossings / this.cutoff);
  }

  private weight(d: number): number {
    const x = d / this.reach;
    if (x <= -1 || x >= 1) return 0;
    const arg = Math.PI * this.cutoff * d;
    const sinc = d === 0 ? 1 : Math.sin(arg) / arg;
    const blackman = 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
    return this.cutoff * sinc * blackman;
  }

  push(input: ArrayLike<number>): Float32Array {
    const before = this.total;
    this.lastOffset = this.next - before;
    if (input.length === 0) return new Float32Array();
    if (this.fromRate === this.toRate) {
      this.total += input.length;
      this.next = this.total;
      this.lastOffset = 0;
      return Float32Array.from(input, (v) => Number(v) || 0);
    }
    const data = new Float32Array(this.tail.length + input.length);
    data.set(this.tail, 0);
    for (let i = 0; i < input.length; i += 1) data[this.tail.length + i] = Number(input[i]) || 0;
    const origin = this.tailStart;
    this.total = before + input.length;
    const last = this.total - 1;
    const out: number[] = [];
    while (Math.floor(this.next) + this.reach <= last) {
      const centre = Math.floor(this.next);
      let acc = 0;
      let norm = 0;
      for (let i = centre - this.reach + 1; i <= centre + this.reach; i += 1) {
        const w = this.weight(this.next - i);
        norm += w;
        if (i >= 0) acc += w * (data[i - origin] ?? 0);
      }
      out.push(norm !== 0 ? acc / norm : 0);
      this.next += this.step;
    }
    const keepFrom = Math.max(0, Math.floor(this.next) - this.reach);
    this.tail = data.slice(Math.max(0, keepFrom - origin));
    this.tailStart = Math.max(origin, keepFrom);
    return Float32Array.from(out);
  }

  reset(): void {
    this.tail = new Float32Array(0);
    this.tailStart = 0;
    this.total = 0;
    this.next = 0;
    this.lastOffset = 0;
  }
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const even = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(even);
  for (let i = 0; i < even; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** Milliseconds of audio in `samples` frames at `rate`. */
export const samplesToMs = (samples: number, rate: number): number =>
  rate > 0 ? (samples * 1000) / rate : 0;
