/**
 * FRIDAY · the echo reference: what FRIDAY's own speaker played, on the microphone's clock.
 *
 * A canceller can only take FRIDAY's voice out of the microphone if it knows what she played and when. The
 * playback scheduler (`playback-scheduler.ts`) tells us both: every chunk it schedules arrives here with the
 * audio-clock time it will start. This module keeps those chunks as 16 kHz mono PCM16 in one fixed ring, stamped
 * on the audio clock with the output latency added (so the stamp is when the sound leaves the speaker), and
 * hands back one reference frame per microphone frame, on the microphone clock.
 *
 *   · `tap` is the listener for `PcmPlayback.onScheduled`; `truncate` is for its flush (the cut-off tail was
 *     never heard);
 *   · `alignedReference(micFrameStartTime, frameLen)` returns `frameLen` samples, zeros where nothing played;
 *   · a stamp that disagrees with the samples already placed (a changed output latency, a clock that runs a
 *     little fast or slow, an underrun) is followed at the next silent boundary, so the reference never jumps in
 *     the middle of a word; only a large disagreement forces a jump;
 *   · memory is fixed: one ring of `maxSeconds`, whatever is played and for however long.
 *
 * Pure: no timers, no audio objects, no network. The remaining delay between the speaker and the microphone
 * (room, driver, input latency) is the canceller's job (`audio-aec.ts`, `kernel/echo_canceller.py`); a safety
 * margin keeps the reference ahead of the echo so that delay is never negative. Tested on simulated rooms only;
 * a real speaker, a real device clock and the browser's own echo flags are not measured.
 */
import { floatToPcm16, pcm16ToFloat, StreamSincResampler } from "./audio-format";

/** The one rate of the echo path: what the kernel canceller and the TypeScript canceller both take. */
export const ECHO_RATE = 16_000;
/** A reference whose peak is under this carries no echo (same floor as `kernel/echo_canceller.py`). */
export const ECHO_SILENT_PEAK = 32;

export type EchoReferenceOptions = {
  /** Ring length in seconds (the longest stretch the microphone can lag the speaker). Default 8. */
  maxSeconds?: number;
  /** Output latency in seconds, or a function read at every chunk (it can change while playing). Default 0. */
  latencySeconds?: number | (() => number);
  /** The reference is read this much later than the microphone frame, so the echo always arrives after it. */
  marginMs?: number;
  /** A stamp this close to the end of the samples already placed counts as seamless. Default 2 ms. */
  toleranceMs?: number;
  /** A disagreement larger than this is followed at once, even in the middle of speech. Default 40 ms. */
  forceResyncMs?: number;
};

export type EchoReferenceStats = {
  capacitySamples: number;
  chunks: number;
  ignored: number;
  placedSamples: number;
  /** Jumps to the stamp at a silent boundary or a gap. */
  resyncs: number;
  /** Jumps to the stamp in the middle of audible speech because the disagreement was large. */
  forcedResyncs: number;
  /** The disagreement being carried until the next silent boundary, in ms (positive: stamps are later). */
  pendingDriftMs: number;
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const SILENT_EDGE = Math.round(ECHO_RATE * 0.005);

export class EchoReference {
  private readonly ring: Int16Array;
  private readonly size: number;
  private readonly latency: () => number;
  private readonly margin: number;
  private readonly tol: number;
  private readonly force: number;
  /** Index (on the 16 kHz audio-clock timeline) just after the last sample placed. */
  private end = 0;
  private hasData = false;
  private tailSilent = true;
  /** Index just after the newest audible sample placed, or -1. */
  private audibleEnd = -1;
  private chain: { rate: number; resample: StreamSincResampler } | null = null;
  private counts = { chunks: 0, ignored: 0, placed: 0, resyncs: 0, forced: 0, pending: 0 };

  constructor(options: EchoReferenceOptions = {}) {
    const seconds = Math.min(60, Math.max(1, options.maxSeconds ?? 8));
    this.size = Math.round(seconds * ECHO_RATE);
    this.ring = new Int16Array(this.size);
    const lat = options.latencySeconds;
    this.latency = typeof lat === "function" ? lat : () => lat ?? 0;
    this.margin = Math.round(((options.marginMs ?? 0) / 1000) * ECHO_RATE);
    this.tol = Math.round(((options.toleranceMs ?? 2) / 1000) * ECHO_RATE);
    this.force = Math.round(((options.forceResyncMs ?? 40) / 1000) * ECHO_RATE);
  }

  private latencyNow(): number {
    try {
      const v = this.latency();
      return finite(v) ? Math.min(1, Math.max(0, v)) : 0;
    } catch {
      return 0;
    }
  }

  /** 16 kHz samples of the chunk, and the seconds from the chunk's start to the first of them (about -1 ms). */
  private toMono16(pcm: Int16Array, sourceRate: number): { samples: Float32Array; lead: number } {
    const float = pcm16ToFloat(pcm);
    if (sourceRate === ECHO_RATE) {
      this.chain = null;
      return { samples: float, lead: 0 };
    }
    if (!this.chain || this.chain.rate !== sourceRate) {
      this.chain = { rate: sourceRate, resample: new StreamSincResampler(sourceRate, ECHO_RATE) };
    }
    const samples = this.chain.resample.push(float);
    return { samples, lead: this.chain.resample.lastOffset / sourceRate };
  }

  /**
   * One chunk the playback scheduler just scheduled: `whenSeconds` is the audio-clock time it starts, `pcm` is
   * PCM16 mono at `sourceRate`. Never throws; a chunk it cannot use is counted and ignored.
   */
  tap(whenSeconds: number, pcm: Int16Array, sourceRate: number = ECHO_RATE): void {
    try {
      if (!finite(whenSeconds) || !finite(sourceRate) || sourceRate <= 0 || !(pcm.length > 0)) {
        this.counts.ignored += 1;
        return;
      }
      const { samples, lead } = this.toMono16(pcm, sourceRate);
      if (samples.length === 0) return;
      const out = floatToPcm16(samples);
      const stamp = Math.round((whenSeconds + this.latencyNow() + lead) * ECHO_RATE);
      this.place(stamp, out);
      this.counts.chunks += 1;
    } catch {
      this.counts.ignored += 1;
    }
  }

  private edgeSilent(samples: Int16Array, fromEnd: boolean): boolean {
    const n = Math.min(SILENT_EDGE, samples.length);
    const from = fromEnd ? samples.length - n : 0;
    for (let i = from; i < from + n; i += 1)
      if (Math.abs(samples[i] ?? 0) >= ECHO_SILENT_PEAK) return false;
    return true;
  }

  private place(stamp: number, samples: Int16Array): void {
    let at = stamp;
    if (this.hasData) {
      const offset = stamp - this.end;
      if (Math.abs(offset) <= this.tol) {
        at = this.end;
        this.counts.pending = 0;
      } else if (this.tailSilent || this.edgeSilent(samples, false)) {
        this.counts.resyncs += 1;
        this.counts.pending = 0;
      } else if (Math.abs(offset) > this.force) {
        this.counts.resyncs += 1;
        this.counts.forced += 1;
        this.counts.pending = 0;
      } else {
        at = this.end; // mid-word: stay seamless, carry the disagreement to the next silent boundary
        this.counts.pending = offset;
      }
    }
    let data = samples;
    if (at < 0) {
      data = data.subarray(Math.min(data.length, -at)); // before time zero there is nothing to place
      at = 0;
    }
    if (data.length === 0) return;
    if (data.length > this.size) {
      at += data.length - this.size;
      data = data.subarray(data.length - this.size);
    }
    if (this.hasData && at > this.end) {
      const gap = Math.min(at - this.end, this.size);
      for (let i = 0; i < gap; i += 1) this.ring[(at - gap + i) % this.size] = 0;
    }
    for (let i = 0; i < data.length; i += 1) this.ring[(at + i) % this.size] = data[i]!;
    this.end = at + data.length;
    this.hasData = true;
    this.tailSilent = this.edgeSilent(data, true);
    for (let i = data.length - 1; i >= 0; i -= 1) {
      if (Math.abs(data[i] ?? 0) >= ECHO_SILENT_PEAK) {
        this.audibleEnd = at + i + 1;
        break;
      }
    }
    this.counts.placed += data.length;
  }

  /**
   * The playback was cut at audio-clock time `whenSeconds` (a flush): nothing after it was heard. Also starts the
   * next answer's resampler clean.
   */
  truncate(whenSeconds: number): void {
    this.chain = null;
    if (!finite(whenSeconds) || !this.hasData) return;
    const idx = Math.round((whenSeconds + this.latencyNow()) * ECHO_RATE);
    if (idx < this.end) {
      this.end = Math.max(idx, this.end - this.size);
      this.tailSilent = true;
    }
  }

  /**
   * The reference for one microphone frame: `frameLen` samples of what the speaker played during
   * [`micFrameStartTime`, + frameLen / 16 kHz) on the audio clock, plus the safety margin. Zeros where nothing
   * played or nothing is known. Always a new array.
   */
  alignedReference(micFrameStartTime: number, frameLen: number): Int16Array {
    const n = Number.isInteger(frameLen) && frameLen > 0 ? Math.min(frameLen, this.size) : 0;
    const out = new Int16Array(n);
    if (n === 0 || !this.hasData || !finite(micFrameStartTime)) return out;
    const start = Math.round(micFrameStartTime * ECHO_RATE) + this.margin;
    const low = Math.max(0, this.end - this.size);
    for (let i = 0; i < n; i += 1) {
      const idx = start + i;
      if (idx >= low && idx < this.end) out[i] = this.ring[idx % this.size] ?? 0;
    }
    return out;
  }

  /**
   * True when something audible was played at or shortly before `timeSeconds` (within `holdSeconds`, to cover the
   * room's tail and the canceller's delay search). A canceller only needs to run while this is true.
   */
  activeAt(timeSeconds: number, holdSeconds = 1.5): boolean {
    if (!finite(timeSeconds) || this.audibleEnd < 0) return false;
    return (
      Math.round(timeSeconds * ECHO_RATE) <= this.audibleEnd + Math.round(holdSeconds * ECHO_RATE)
    );
  }

  stats(): EchoReferenceStats {
    return {
      capacitySamples: this.size,
      chunks: this.counts.chunks,
      ignored: this.counts.ignored,
      placedSamples: this.counts.placed,
      resyncs: this.counts.resyncs,
      forcedResyncs: this.counts.forced,
      pendingDriftMs: Math.round((this.counts.pending / ECHO_RATE) * 1000 * 10) / 10,
    };
  }

  /** Forget everything (a new answer after a long pause, a new device). */
  reset(): void {
    this.ring.fill(0);
    this.end = 0;
    this.hasData = false;
    this.tailSilent = true;
    this.audibleEnd = -1;
    this.chain = null;
    this.counts = { chunks: 0, ignored: 0, placed: 0, resyncs: 0, forced: 0, pending: 0 };
  }
}

/** Safety margin the live hook reads the reference ahead by: room and driver delay must stay positive. */
export const LIVE_MARGIN_MS = 20;

/**
 * The output latency of an audio context in seconds: `outputLatency` when the browser reports it, else the
 * context's `baseLatency`, else 0. Use as `latencySeconds: () => contextLatencySeconds(context)`.
 */
export function contextLatencySeconds(context: {
  outputLatency?: number;
  baseLatency?: number;
}): number {
  const out = context.outputLatency;
  if (finite(out) && out > 0) return out;
  const base = context.baseLatency;
  return finite(base) && base > 0 ? base : 0;
}

export type MicFrameTiming = {
  /** Audio-clock time when the frame was delivered (its last sample was captured about now). */
  deliveredAt: number;
  /** Frame length in 16 kHz samples. */
  frameLen: number;
  /** Input latency in seconds (`MediaTrackSettings.latency` or the capture context's `baseLatency`). Default 0. */
  inputLatencySeconds?: number;
};

/** When the first sample of a microphone frame was in the air, on the audio clock. */
export const micFrameStartTime = (t: MicFrameTiming): number =>
  t.deliveredAt -
  t.frameLen / ECHO_RATE -
  Math.max(0, finite(t.inputLatencySeconds) ? t.inputLatencySeconds : 0);

/**
 * LIVE-CAPTURE HOOK (pure). For one 16 kHz microphone frame: the reference frame to hand to a canceller, or null
 * when nothing played during the frame (no reference: the canceller passes the microphone through unchanged).
 * Never throws.
 */
export function echoReferenceForMicFrame(
  reference: EchoReference,
  timing: MicFrameTiming,
): Int16Array | null {
  try {
    const ref = reference.alignedReference(micFrameStartTime(timing), timing.frameLen);
    for (let i = 0; i < ref.length; i += 1)
      if (Math.abs(ref[i] ?? 0) >= ECHO_SILENT_PEAK) return ref;
    return null;
  } catch {
    return null;
  }
}

/** The part of `EchoCanceller` the hook below needs (audio-aec.ts). */
export type ReferenceCanceller = {
  processWithReference: (
    near: ArrayLike<number>,
    reference: ArrayLike<number> | null,
    start?: number,
  ) => Float32Array;
  nextNearIndex: () => number | null;
};

/**
 * LIVE-CAPTURE HOOK for the TypeScript canceller (pure). `mic` is one float 16 kHz frame. Returns the frame with
 * FRIDAY's own voice taken out, or `mic` itself when nothing has played lately or anything fails. Nothing is
 * allocated that outlives the call.
 */
export function cancelMicFrame(
  reference: EchoReference,
  canceller: ReferenceCanceller,
  mic: Float32Array,
  timing: Omit<MicFrameTiming, "frameLen">,
): Float32Array {
  try {
    const full = { ...timing, frameLen: mic.length };
    const startTime = micFrameStartTime(full);
    const ref = echoReferenceForMicFrame(reference, full);
    // Silent reference: pass through, unless something played a moment ago. Then the canceller keeps its timeline
    // (its delay search needs the loudness of the quiet stretches too) and learns nothing from the silence.
    if (!ref && !reference.activeAt(startTime)) return mic;
    const wanted = Math.round(startTime * ECHO_RATE);
    const expected = canceller.nextNearIndex();
    const start = expected !== null && Math.abs(wanted - expected) <= 32 ? undefined : wanted;
    return canceller.processWithReference(mic, ref ? pcm16ToFloat(ref) : null, start);
  } catch {
    return mic;
  }
}
