/**
 * FRIDAY · gapless PCM playback with a bounded queue and an instant flush.
 *
 * One authoritative playback path for streamed speech (a realtime provider's audio chunks). Chunks are placed
 * back to back on the audio clock, the queue holds at most `maxQueuedMs` (newer chunks are refused past that,
 * and counted), and `flush()` stops everything audible at once and says how many milliseconds were really
 * played, which is what a provider needs to truncate the answer where the owner heard it. The audio context is
 * injected, so the logic is tested without a speaker.
 */
import { pcm16ToFloat, samplesToMs } from "./audio-format";

export type SourceLike = {
  buffer: unknown;
  connect: (node: unknown) => void;
  start: (when?: number) => void;
  stop: (when?: number) => void;
  onended: (() => void) | null;
};

/** A gain stage in front of the speaker: how the playing voice is ducked and restored without a stop. */
export type GainLike = {
  gain: { value: number; setTargetAtTime?: (target: number, at: number, constant: number) => void };
  connect: (node: unknown) => void;
};

export type ContextLike = {
  currentTime: number;
  destination: unknown;
  /** Seconds between a sample leaving the audio clock and the speaker making it audible (browser report; 0 or absent when unknown). */
  outputLatency?: number;
  baseLatency?: number;
  createGain?: () => GainLike;
  createBuffer: (
    channels: number,
    length: number,
    rate: number,
  ) => { copyToChannel: (data: Float32Array, ch: number) => void };
  createBufferSource: () => SourceLike;
};

export type PlaybackStats = {
  queuedMs: number;
  playedMs: number;
  dropped: number;
  underruns: number;
};

/** Where one chunk sits on the answer's own clock, the same clock `playedMs()` reads. */
export type ChunkSpan = { startMs: number; endMs: number };

/** Hears one scheduled chunk: the audio-clock time it starts, and its samples at the playback rate. */
export type ScheduledListener = (whenSeconds: number, pcm: Int16Array) => void;

export class PcmPlayback {
  private nextTime = 0;
  private startedAt: number | null = null;
  private sources = new Set<SourceLike>();
  private dropped = 0;
  private underruns = 0;
  private listener: ScheduledListener | null = null;
  private readonly extraListeners = new Set<ScheduledListener>();
  private generation = 0;
  private disposed = false;
  private gain: GainLike | null = null;
  private duckLevel = 1;
  private span: ChunkSpan | null = null;

  constructor(
    private readonly context: ContextLike,
    private readonly options: { rate: number; maxQueuedMs?: number },
  ) {}

  /**
   * Hear every chunk the moment it is scheduled, with the audio-clock time it will start. The echo canceller uses
   * this as its reference: what is about to leave the speaker. Pass null to stop listening.
   */
  onScheduled(listener: ScheduledListener | null): void {
    this.listener = listener;
  }

  /**
   * Another listener next to the one `onScheduled` holds (the live echo reference taps here while the realtime
   * voice keeps its own). Returns the function that removes it. A listener that throws is skipped for that chunk:
   * it can never stop the audio or the listeners after it.
   */
  addScheduledListener(listener: ScheduledListener): () => void {
    this.extraListeners.add(listener);
    return () => void this.extraListeners.delete(listener);
  }

  private notifyScheduled(whenSeconds: number, pcm: Int16Array): void {
    for (const listener of [...(this.listener ? [this.listener] : []), ...this.extraListeners]) {
      try {
        listener(whenSeconds, pcm);
      } catch {
        /* a listener is only a listener: the chunk is already scheduled */
      }
    }
  }

  /**
   * The number a chunk must carry to be heard. `flush()` moves it on, so a chunk of an answer that was cut off
   * and arrives afterwards (a provider still sending) is refused and counted instead of starting a stale answer.
   */
  get currentGeneration(): number {
    return this.generation;
  }

  /**
   * True when the chunk was scheduled. A chunk past the queue bound, of an old generation, or after `dispose()`
   * is refused and counted. Without a generation the chunk belongs to whatever is current (the older call shape).
   */
  enqueue(pcm: Int16Array, generation?: number): boolean {
    if (pcm.length === 0) return true;
    if (this.disposed || (generation !== undefined && generation !== this.generation)) {
      this.dropped += 1;
      return false;
    }
    const max = this.options.maxQueuedMs ?? 4000;
    const ms = samplesToMs(pcm.length, this.options.rate);
    if (this.queuedMs() + ms > max) {
      this.dropped += 1;
      return false;
    }
    const now = this.context.currentTime;
    if (this.startedAt === null) {
      this.startedAt = now;
      this.nextTime = now;
    } else if (this.nextTime < now - 0.005 && this.sources.size === 0) {
      // Audio had started and the queue ran dry before this chunk arrived: a gap the listener hears.
      this.underruns += 1;
      this.nextTime = now;
    }
    const buffer = this.context.createBuffer(1, pcm.length, this.options.rate);
    buffer.copyToChannel(pcm16ToFloat(pcm), 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output());
    const when = Math.max(this.nextTime, now);
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);
    source.start(when);
    this.notifyScheduled(when, pcm);
    this.nextTime = when + ms / 1000;
    const base = this.startedAt ?? when;
    this.span = { startMs: (when - base) * 1000, endMs: (this.nextTime - base) * 1000 };
    return true;
  }

  /** Where the chunk that `enqueue` just scheduled sits on the answer clock; null before any. */
  lastSpan(): ChunkSpan | null {
    return this.span;
  }

  /** The node every source plays into: a gain stage when the context has one, else the speaker directly. */
  private output(): unknown {
    if (this.gain) return this.gain;
    const make = this.context.createGain;
    if (!make) return this.context.destination;
    try {
      const node = make.call(this.context);
      node.gain.value = this.duckLevel;
      node.connect(this.context.destination);
      this.gain = node;
      return node;
    } catch {
      return this.context.destination;
    }
  }

  /**
   * Lower (or restore) the voice without stopping it: `level` is 0..1 of its own loudness. A short ramp keeps it
   * click-free. Returns false when the context has no gain stage (the caller then ducks another way or not at all).
   */
  setDuck(level: number): boolean {
    this.duckLevel = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 1));
    if (!this.gain) return typeof this.context.createGain === "function";
    const ramp = this.gain.gain.setTargetAtTime;
    if (ramp) ramp.call(this.gain.gain, this.duckLevel, this.context.currentTime, 0.015);
    else this.gain.gain.value = this.duckLevel;
    return true;
  }

  /** Seconds the speaker is behind the audio clock (0 when the browser does not say). */
  private latencySeconds(): number {
    const out = Number(this.context.outputLatency);
    if (Number.isFinite(out) && out > 0) return out;
    const base = Number(this.context.baseLatency);
    return Number.isFinite(base) && base > 0 ? base : 0;
  }

  queuedMs(): number {
    return Math.max(0, (this.nextTime - this.context.currentTime) * 1000);
  }

  /**
   * Milliseconds of this answer that the speaker has really played: the audio clock minus the output buffer still
   * between the clock and the speaker, never more than the end of the last scheduled chunk (a gap between two
   * clauses counts as time that passed, not as speech).
   */
  playedMs(): number {
    if (this.startedAt === null) return 0;
    const heard = Math.max(
      0,
      (this.context.currentTime - this.startedAt - this.latencySeconds()) * 1000,
    );
    return Math.min(heard, Math.max(0, (this.nextTime - this.startedAt) * 1000));
  }

  /** Stop at once. Returns the milliseconds that were played, then starts a fresh answer. */
  flush(): number {
    const played = this.playedMs();
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* a source that already ended */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.startedAt = null;
    this.span = null;
    this.generation += 1; // what was cut off cannot continue, and the next answer starts clean at once
    return Math.round(played);
  }

  /** End of use: stop everything audible, stop listening, and refuse every later chunk. */
  dispose(): number {
    const played = this.flush();
    this.listener = null;
    this.extraListeners.clear();
    this.disposed = true;
    return played;
  }

  /** True while audio is scheduled to come out. */
  audible(): boolean {
    return this.sources.size > 0 && this.queuedMs() > 0;
  }

  stats(): PlaybackStats {
    return {
      queuedMs: Math.round(this.queuedMs()),
      playedMs: Math.round(this.playedMs()),
      dropped: this.dropped,
      underruns: this.underruns,
    };
  }
}
