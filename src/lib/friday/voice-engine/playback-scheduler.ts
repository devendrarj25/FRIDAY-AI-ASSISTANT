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

export type ContextLike = {
  currentTime: number;
  destination: unknown;
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

export class PcmPlayback {
  private nextTime = 0;
  private startedAt: number | null = null;
  private sources = new Set<SourceLike>();
  private dropped = 0;
  private underruns = 0;
  private scheduledMs = 0;
  private listener: ((whenSeconds: number, pcm: Int16Array) => void) | null = null;

  constructor(
    private readonly context: ContextLike,
    private readonly options: { rate: number; maxQueuedMs?: number },
  ) {}

  /**
   * Hear every chunk the moment it is scheduled, with the audio-clock time it will start. The echo canceller uses
   * this as its reference: what is about to leave the speaker. Pass null to stop listening.
   */
  onScheduled(listener: ((whenSeconds: number, pcm: Int16Array) => void) | null): void {
    this.listener = listener;
  }

  /** True when the chunk was scheduled. A chunk past the queue bound is refused and counted. */
  enqueue(pcm: Int16Array): boolean {
    if (pcm.length === 0) return true;
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
    source.connect(this.context.destination);
    const when = Math.max(this.nextTime, now);
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);
    source.start(when);
    this.listener?.(when, pcm);
    this.nextTime = when + ms / 1000;
    this.scheduledMs += ms;
    return true;
  }

  queuedMs(): number {
    return Math.max(0, (this.nextTime - this.context.currentTime) * 1000);
  }

  /** Milliseconds of this answer that were really played so far. */
  playedMs(): number {
    if (this.startedAt === null) return 0;
    const heard = Math.max(0, (this.context.currentTime - this.startedAt) * 1000);
    return Math.min(heard, this.scheduledMs);
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
    this.scheduledMs = 0;
    return Math.round(played);
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
