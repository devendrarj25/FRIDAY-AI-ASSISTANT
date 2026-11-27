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
import {
  floatToPcm16,
  pcm16ToFloat,
  REALTIME_RATE,
  samplesToMs,
  StreamResampler,
} from "./audio-format";
import {
  DEFAULT_EDGE_FADE_MS,
  DEFAULT_JOIN_MS,
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

/**
 * The one place a playback rate is assumed. Every clip is resampled to the audio context's own rate, whatever rate
 * the voice engine made it at (22.05, 24, 44.1 or 48 kHz); only a context that reports no usable rate falls back to
 * this one, so nothing downstream ever divides by zero.
 */
export const PCM_FALLBACK_RATE = REALTIME_RATE;

/** The rate the player runs at: the context's own, or `PCM_FALLBACK_RATE` when it reports none. */
export const playRate = (context: { sampleRate?: number }): number =>
  Number.isFinite(context.sampleRate) && (context.sampleRate ?? 0) > 0
    ? (context.sampleRate as number)
    : PCM_FALLBACK_RATE;

/** A clause is at most about 35 seconds of speech (500 characters); a queue longer than this is a runaway. */
export const PCM_MAX_QUEUED_MS = 60_000;
/** The loudness of the clause is published this often, for the companion's mouth. */
export const PCM_LEVEL_EVERY_MS = 50;

export type PcmClip = {
  /** Resolves when the last sample was played, or when the clip was stopped. */
  ended: Promise<void>;
  /** Length of the clip after resampling. */
  durationMs: number;
  /** Milliseconds the clip starts before the end of the clip before it (an equal-power join); 0 when butt-joined. */
  overlapMs: number;
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
      /**
       * Click-free seams: clips of one answer with no gap overlap by `DEFAULT_JOIN_MS` with an equal-power fade, and
       * an answer starts and stops with a `DEFAULT_EDGE_FADE_MS` fade. Off (the plain butt joint) when absent.
       */
      join?: boolean;
      /** `underrunRisk` turns true below this backlog (ms). */
      underrunFloorMs?: number;
    } = {},
  ) {
    this.timers = options.timers ?? realTimers;
    this.playback = new PcmPlayback(context, {
      rate: playRate(context),
      maxQueuedMs: options.maxQueuedMs ?? PCM_MAX_QUEUED_MS,
      ...(options.join ? { joinMs: DEFAULT_JOIN_MS, edgeFadeMs: DEFAULT_EDGE_FADE_MS } : {}),
      ...(options.underrunFloorMs !== undefined
        ? { underrunFloorMs: options.underrunFloorMs }
        : {}),
    });
  }

  get rate(): number {
    return playRate(this.context);
  }

  /** Scheduled audio not yet played (ms): what the speaker still has before it runs dry. */
  backlogMs(): number {
    return this.playback.backlogMs();
  }

  /** True when the backlog is below the floor: the next clause should be a short one. Audio is never stretched. */
  get underrunRisk(): boolean {
    return this.playback.underrunRisk();
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

  /**
   * Schedule one clause. Throws when the clip cannot be scheduled (the caller falls back to another path).
   * `gapMs` is the pause wanted before the clause: kept as silence, never crossfaded.
   */
  start(
    pcm: Int16Array,
    sourceRate: number,
    volume = 1,
    options: { gapMs?: number } = {},
  ): PcmClip {
    if (!(sourceRate > 0)) throw new Error("the clip has no sample rate");
    if (pcm.length === 0) throw new Error("the clip is empty");
    const gain = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
    let samples = pcm16ToFloat(pcm);
    const rate = this.rate;
    if (sourceRate !== rate) samples = new StreamResampler(sourceRate, rate).push(samples);
    if (gain !== 1)
      for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) * gain;
    const out = floatToPcm16(samples);
    if (out.length === 0) throw new Error("the clip is empty after resampling");
    const waitMs = this.playback.queuedMs();
    if (!this.playback.enqueue(out, this.playback.currentGeneration, options)) {
      throw new Error("the playback queue refused the clip");
    }
    const overlapMs = this.playback.lastOverlapMs();
    const durationMs = samplesToMs(out.length, rate);
    const endsInMs = this.playback.queuedMs();
    // A pause before the clause or an overlap with the one before moves its start off the old queue end.
    const startWaitMs = overlapMs > 0 || Number(options.gapMs) > 0 ? endsInMs - durationMs : waitMs;
    const startsAt = this.context.currentTime + startWaitMs / 1000;
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
      const rms = windowLevels(out, rate, PCM_LEVEL_EVERY_MS);
      let tick = -Math.round(startWaitMs / PCM_LEVEL_EVERY_MS);
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
      overlapMs,
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
