/**
 * FRIDAY · audio format helpers for the voice engine: PCM16, mono, sample-rate conversion, base64.
 *
 * Pure functions plus one small stateful resampler for a live stream. The microphone worklet delivers Float32
 * mono frames at the device rate (usually 48 kHz); a realtime provider wants PCM16 mono at its own rate
 * (24 kHz for the OpenAI Realtime style). Nothing here allocates without a bound the caller chose.
 */

export const REALTIME_RATE = 24_000;

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
