/**
 * FRIDAY · one spoken clause as raw PCM through the gapless scheduler.
 *
 * The local voice can hand back 16-bit samples with no file and no container (`speak-pcm`). This player puts
 * such a clause on the audio clock through `PcmPlayback`: resampled to the context rate, scaled to the clause's
 * volume, scheduled back to back with the clause before it, and stopped at once by `stop()`, which flushes the
 * scheduler (the queue is cut and every audible source is stopped). It cannot pause, so a hold for a possible
 * interruption is a stop, and the caller keeps the unspoken text, exactly as the page audio element path does.
 *
 * The context and the timers are injected, so the logic is tested without a speaker.
 */
import { floatToPcm16, pcm16ToFloat, samplesToMs, StreamResampler } from "./audio-format";
import {
  PcmPlayback,
  type ContextLike,
  type PlaybackStats,
  type ScheduledListener,
} from "./playback-scheduler";

export type PcmContext = ContextLike & {
  sampleRate: number;
  /** What the browser reports for the speaker path; the echo reference adds it to the audio-clock stamp. */
  outputLatency?: number;
  baseLatency?: number;
  state?: string;
  resume?: () => Promise<void>;
};

export type PcmTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
};

const realTimers: PcmTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

/** A clause is at most about 35 seconds of speech (500 characters); a queue longer than this is a runaway. */
export const PCM_MAX_QUEUED_MS = 60_000;
/** The loudness of the clause is published this often, for the companion's mouth. */
export const PCM_LEVEL_EVERY_MS = 50;

export type PcmClip = {
  /** Resolves when the last sample was played, or when the clip was stopped. */
  ended: Promise<void>;
  /** Length of the clip after resampling. */
  durationMs: number;
  /** Stop everything this player is playing now. Returns the milliseconds that were really played. */
  stop: () => number;
  /** Milliseconds of this clip that the speaker has played so far (0 before it starts, its length at the end). */
  playedMs: () => number;
  /** Where the clip sits on the answer clock (`PcmClipPlayer.playedMs()` reads the same clock), or null when unknown. */
  span: { startMs: number; endMs: number } | null;
};

export class PcmClipPlayer {
  private readonly playback: PcmPlayback;
  private readonly timers: PcmTimers;
  private readonly settle = new Set<() => void>();
  private readonly stopListeners = new Set<(atSeconds: number) => void>();

  constructor(
    private readonly context: PcmContext,
    private readonly options: {
      maxQueuedMs?: number;
      timers?: PcmTimers;
      /** The measured loudness (RMS, 0 to 1) of the part of the clip that is playing now. */
      onLevel?: (rms: number) => void;
    } = {},
  ) {
    this.timers = options.timers ?? realTimers;
    this.playback = new PcmPlayback(context, {
      rate: context.sampleRate,
      maxQueuedMs: options.maxQueuedMs ?? PCM_MAX_QUEUED_MS,
    });
  }

  get rate(): number {
    return this.context.sampleRate;
  }

  stats(): PlaybackStats {
    return this.playback.stats();
  }

  /** Milliseconds of the current answer the speaker has really played (output latency taken off). */
  playedMs(): number {
    return this.playback.playedMs();
  }

  /** Lower (level < 1) or restore (1) the voice without stopping it. False when the context has no gain stage. */
  setDuck(level: number): boolean {
    return this.playback.setDuck(level);
  }

  /** The audio context the clauses are played on (its clock and latency), for the echo reference. */
  get clock(): PcmContext {
    return this.context;
  }

  /**
   * Hear every chunk the moment it is scheduled (audio-clock start time and samples at `rate`). More than one
   * listener may be added; returns the function that removes it.
   */
  addScheduledListener(listener: ScheduledListener): () => void {
    return this.playback.addScheduledListener(listener);
  }

  /** Hear every stop or dispose with the audio-clock time it happened: what was queued after it was never heard. */
  addStopListener(listener: (atSeconds: number) => void): () => void {
    this.stopListeners.add(listener);
    return () => void this.stopListeners.delete(listener);
  }

  private notifyStop(atSeconds: number): void {
    for (const listener of [...this.stopListeners]) {
      try {
        listener(atSeconds);
      } catch {
        /* a listener never stops the stop */
      }
    }
  }

  /**
   * The audio context must be running, or nothing would come out of the speaker: a suspended one is resumed, and a
   * context that does not start within `timeoutMs` (no user gesture allowed) is refused, never waited on.
   */
  async ready(timeoutMs = 500): Promise<void> {
    if (this.context.state === "suspended") {
      await new Promise<void>((resolve, reject) => {
        const timer = this.timers.setTimeout(
          () => reject(new Error("the audio context did not start")),
          timeoutMs,
        );
        Promise.resolve(this.context.resume?.()).then(
          () => {
            this.timers.clearTimeout(timer);
            resolve();
          },
          (error: unknown) => {
            this.timers.clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    }
    if (this.context.state !== undefined && this.context.state !== "running")
      throw new Error(`the audio context is ${this.context.state}`);
  }

  /** Schedule one clause. Throws when the clip cannot be scheduled (the caller falls back to another path). */
  start(pcm: Int16Array, sourceRate: number, volume = 1): PcmClip {
    if (!(sourceRate > 0)) throw new Error("the clip has no sample rate");
    if (pcm.length === 0) throw new Error("the clip is empty");
    const gain = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
    let samples = pcm16ToFloat(pcm);
    if (sourceRate !== this.context.sampleRate) {
      samples = new StreamResampler(sourceRate, this.context.sampleRate).push(samples);
    }
    if (gain !== 1)
      for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) * gain;
    const out = floatToPcm16(samples);
    if (out.length === 0) throw new Error("the clip is empty after resampling");
    const waitMs = this.playback.queuedMs();
    const startsAt = this.context.currentTime + waitMs / 1000;
    if (!this.playback.enqueue(out, this.playback.currentGeneration)) {
      throw new Error("the playback queue refused the clip");
    }
    const durationMs = samplesToMs(out.length, this.context.sampleRate);
    const endsInMs = this.playback.queuedMs();
    let done = false;
    let endTimer: unknown = null;
    let levelTimer: unknown = null;
    let release: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = () => {
      if (done) return;
      done = true;
      this.settle.delete(finish);
      if (endTimer !== null) this.timers.clearTimeout(endTimer);
      if (levelTimer !== null) this.timers.clearInterval(levelTimer);
      this.options.onLevel?.(0);
      release();
    };
    this.settle.add(finish);
    endTimer = this.timers.setTimeout(finish, Math.max(0, endsInMs));
    if (this.options.onLevel) {
      const rms = windowLevels(out, this.context.sampleRate, PCM_LEVEL_EVERY_MS);
      let tick = -Math.round(waitMs / PCM_LEVEL_EVERY_MS);
      levelTimer = this.timers.setInterval(() => {
        const level = tick >= 0 ? rms[tick] : undefined;
        tick += 1;
        if (level !== undefined) this.options.onLevel?.(level);
      }, PCM_LEVEL_EVERY_MS);
    }
    const latencyMs = (): number => {
      const out = Number(this.context.outputLatency);
      if (Number.isFinite(out) && out > 0) return out * 1000;
      const base = Number(this.context.baseLatency);
      return Number.isFinite(base) && base > 0 ? base * 1000 : 0;
    };
    const playedMs = () =>
      Math.min(durationMs, Math.max(0, (this.context.currentTime - startsAt) * 1000 - latencyMs()));
    const span = this.playback.lastSpan();
    return {
      ended,
      durationMs,
      stop: () => this.stop(),
      playedMs,
      span: span ? { startMs: span.startMs, endMs: span.endMs } : null,
    };
  }

  /** Stop at once: flush the scheduler and end every clip that was waiting for its audio to finish. */
  stop(): number {
    const at = this.context.currentTime;
    const played = this.playback.flush();
    for (const finish of [...this.settle]) finish();
    this.notifyStop(at);
    return played;
  }

  /** End of use: stop everything and refuse every later clip. */
  dispose(): number {
    const at = this.context.currentTime;
    const played = this.playback.dispose();
    for (const finish of [...this.settle]) finish();
    this.notifyStop(at);
    this.stopListeners.clear();
    return played;
  }
}

/** RMS of each `windowMs` of the clip: the real envelope of what is about to be heard. */
export function windowLevels(pcm: Int16Array, rate: number, windowMs: number): number[] {
  const size = Math.max(1, Math.round((rate * windowMs) / 1000));
  const out: number[] = [];
  for (let at = 0; at < pcm.length; at += size) {
    let sum = 0;
    const end = Math.min(pcm.length, at + size);
    for (let i = at; i < end; i += 1) {
      const v = (pcm[i] ?? 0) / 32768;
      sum += v * v;
    }
    out.push(Math.sqrt(sum / (end - at)));
  }
  return out;
}

/** A little-endian Int16 byte stream (as the worker sends it) as samples. Copies, so the alignment never matters. */
export function bytesToPcm16(bytes: ArrayLike<number> & { length: number }): Int16Array {
  const even = bytes.length - (bytes.length % 2);
  const out = new Int16Array(even / 2);
  for (let i = 0; i < out.length; i += 1) {
    const lo = Number(bytes[i * 2]) & 0xff;
    const hi = Number(bytes[i * 2 + 1]) & 0xff;
    const value = (hi << 8) | lo;
    out[i] = value >= 0x8000 ? value - 0x10000 : value;
  }
  return out;
}

/** A mono 16-bit WAV file of the samples, as base64: the clause can still be played by the page audio element. */
export function pcm16ToWavBase64(pcm: Int16Array, sampleRate: number): string {
  const dataBytes = pcm.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i] ?? 0, true);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
