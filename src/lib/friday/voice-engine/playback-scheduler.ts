/**
 * FRIDAY · gapless PCM playback with a bounded queue and an instant flush.
 *
 * One authoritative playback path for streamed speech (a realtime provider's audio chunks). Chunks are placed
 * back to back on the audio clock, the queue holds at most `maxQueuedMs` (newer chunks are refused past that,
 * and counted), and `flush()` stops everything audible at once and says how many milliseconds were really
 * played, which is what a provider needs to truncate the answer where the owner heard it. The audio context is
 * injected, so the logic is tested without a speaker.
 */
import { floatToPcm16, pcm16ToFloat, samplesToMs } from "./audio-format";

/** Overlap taken from the edges of two clips of one utterance that follow each other with no gap (equal-power). */
export const DEFAULT_JOIN_MS = 8;
/** Fade at the start of an utterance and at a stop, so a cut-off never clicks. */
export const DEFAULT_EDGE_FADE_MS = 4;
/** Below this much scheduled-but-unplayed audio the speaker is close to running dry. */
export const DEFAULT_UNDERRUN_FLOOR_MS = 120;
/** A pending clip tail is replaced only while it is at least this far from starting (the audio clock moves on). */
const JOIN_GUARD_S = 0.01;

/** Whole samples in `ms` at `rate` (at least 1 for a positive time, 0 for none or a bad number). */
export const msToSamples = (ms: number, rate: number): number =>
  Number.isFinite(ms) && ms > 0 && rate > 0 ? Math.max(1, Math.round((ms * rate) / 1000)) : 0;

/**
 * The two equal-power curves of a fade over `length` samples: `out` falls as cos, `inn` rises as sin, so for every
 * sample out^2 + inn^2 = 1 and the power of two uncorrelated signals stays constant across the seam.
 */
export function equalPowerCurves(length: number): { out: Float32Array; inn: Float32Array } {
  const n = Math.max(0, Math.floor(length));
  const out = new Float32Array(n);
  const inn = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const angle = ((i + 0.5) / n) * (Math.PI / 2);
    out[i] = Math.cos(angle);
    inn[i] = Math.sin(angle);
  }
  return { out, inn };
}

/** The seam: the tail of one clip falling and the head of the next rising over the same samples (equal lengths). */
export function joinSeam(tail: Float32Array, head: Float32Array): Float32Array {
  const n = Math.min(tail.length, head.length);
  const { out, inn } = equalPowerCurves(n);
  const seam = new Float32Array(n);
  for (let i = 0; i < n; i += 1)
    seam[i] = (tail[i] ?? 0) * (out[i] ?? 0) + (head[i] ?? 0) * (inn[i] ?? 0);
  return seam;
}

/**
 * Two clips of one utterance joined with `overlap` samples crossfaded. Everything outside the seam is the clips'
 * own samples, and the length is `prev + next - overlap`: no sample is lost and the durations add up, so the played
 * time of the answer stays exact. An overlap longer than a clip is cut to the shorter one.
 */
export function joinClips(prev: Float32Array, next: Float32Array, overlap: number): Float32Array {
  const n = Math.max(0, Math.min(Math.floor(overlap), prev.length, next.length));
  const joined = new Float32Array(prev.length + next.length - n);
  joined.set(prev.subarray(0, prev.length - n), 0);
  joined.set(joinSeam(prev.subarray(prev.length - n), next.subarray(0, n)), prev.length - n);
  joined.set(next.subarray(n), prev.length);
  return joined;
}

/** A copy of the samples with the first (`in`) or last (`out`) `length` samples faded with the equal-power curve. */
export function fadeEdge(samples: Float32Array, length: number, edge: "in" | "out"): Float32Array {
  const copy = samples.slice();
  const n = Math.min(Math.max(0, Math.floor(length)), copy.length);
  const { out, inn } = equalPowerCurves(n);
  for (let i = 0; i < n; i += 1) {
    if (edge === "in") copy[i] = (copy[i] ?? 0) * (inn[i] ?? 0);
    else copy[copy.length - n + i] = (copy[copy.length - n + i] ?? 0) * (out[i] ?? 0);
  }
  return copy;
}

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

/** What the scheduler may shape at the seams. Absent or 0 keeps every chunk exactly as it came. */
export type PlaybackOptions = {
  rate: number;
  maxQueuedMs?: number;
  /** Overlap of two clips with no gap between them (`DEFAULT_JOIN_MS` is the usual value); 0 or absent: butt joint. */
  joinMs?: number;
  /** Fade at an answer's start and at a stop (`DEFAULT_EDGE_FADE_MS`); 0 or absent: none. */
  edgeFadeMs?: number;
  /** `underrunRisk` is true below this backlog (default `DEFAULT_UNDERRUN_FLOOR_MS`). */
  underrunFloorMs?: number;
};

/** One chunk of audio: when it is meant to end the answer's pending tail, so a following clip can replace it. */
type PendingTail = { source: SourceLike; samples: Float32Array; when: number };

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
  private tail: PendingTail | null = null;
  private overlapMs = 0;
  private readonly joinSamples: number;
  private readonly fadeSamples: number;
  private readonly fadeSeconds: number;

  constructor(
    private readonly context: ContextLike,
    private readonly options: PlaybackOptions,
  ) {
    this.joinSamples = msToSamples(options.joinMs ?? 0, options.rate);
    this.fadeSamples = msToSamples(options.edgeFadeMs ?? 0, options.rate);
    this.fadeSeconds = this.fadeSamples / Math.max(1, options.rate);
  }

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
   *
   * `gapMs` is silence wanted before this chunk (the pause between clauses): it is honoured as time on the clock and
   * never crossfaded. With `joinMs` set, a chunk that follows the last one with no gap overlaps its edges with an
   * equal-power fade instead of a hard cut; with `edgeFadeMs` set, an answer's first chunk (and one after a gap)
   * fades in. A chunk too short for two overlaps is placed whole.
   */
  enqueue(pcm: Int16Array, generation?: number, options: { gapMs?: number } = {}): boolean {
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
    let fresh = false;
    if (this.startedAt === null) {
      this.startedAt = now;
      this.nextTime = now;
      fresh = true;
    } else if (this.nextTime < now - 0.005 && this.sources.size === 0) {
      // Audio had started and the queue ran dry before this chunk arrived: a gap the listener hears.
      this.underruns += 1;
      this.nextTime = now;
      fresh = true;
    }
    const gapMs = Number(options.gapMs);
    const gap = !fresh && Number.isFinite(gapMs) && gapMs > 0 ? gapMs / 1000 : 0;
    this.overlapMs = 0;
    let when: number;
    if (this.joinSamples === 0 && this.fadeSamples === 0) {
      when = Math.max(this.nextTime + gap, now);
      this.place(pcm16ToFloat(pcm), when, pcm);
      this.nextTime = when + ms / 1000;
    } else {
      when = this.placeShaped(pcm16ToFloat(pcm), now, fresh, gap);
    }
    const base = this.startedAt ?? when;
    this.span = { startMs: (when - base) * 1000, endMs: (this.nextTime - base) * 1000 };
    return true;
  }

  /** One buffer on the clock at `when`; the listeners hear `heard` (the samples as placed). */
  private place(samples: Float32Array, when: number, heard?: Int16Array): SourceLike {
    const buffer = this.context.createBuffer(1, samples.length, this.options.rate);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output());
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);
    source.start(when);
    if (heard) this.notifyScheduled(when, heard);
    return source;
  }

  /** Stop a source that has not started yet and forget it. */
  private cancel(source: SourceLike): void {
    source.onended = null;
    this.sources.delete(source);
    try {
      source.stop();
    } catch {
      /* a source that already ended */
    }
  }

  /**
   * The shaped placement: crossfade into the pending tail when there is no gap, else fade the tail out and the head
   * in. The clip is held as a body source and a tail source (the last `joinSamples`), so the tail can still be
   * replaced when the next clip arrives. Returns the audio-clock time the clip starts, which is before the end of the
   * clip before it by the overlap when it was joined; `nextTime` moves by the clip's length less that overlap.
   */
  private placeShaped(samples: Float32Array, now: number, fresh: boolean, gap: number): number {
    const n = this.joinSamples;
    const rate = this.options.rate;
    const prev = this.tail && this.sources.has(this.tail.source) ? this.tail : null;
    const pending = prev !== null && prev.when > now + JOIN_GUARD_S ? prev : null;
    let shaped = samples;
    let when = Math.max(this.nextTime + gap, now);
    if (n > 0 && pending && !fresh && gap === 0 && samples.length >= 2 * n) {
      this.cancel(pending.source);
      shaped = samples.slice();
      shaped.set(joinSeam(pending.samples, samples.subarray(0, n)), 0);
      when = pending.when;
      this.overlapMs = (n * 1000) / rate;
    } else {
      if (pending && gap > 0 && this.fadeSamples > 0) {
        // Silence follows the last clip: its tail leaves with a fade instead of a hard end.
        this.cancel(pending.source);
        const faded = fadeEdge(pending.samples, this.fadeSamples, "out");
        this.place(faded, pending.when, floatToPcm16(faded));
      }
      if (this.fadeSamples > 0 && (fresh || gap > 0)) {
        shaped = fadeEdge(samples, Math.min(this.fadeSamples, samples.length >> 1), "in");
      }
    }
    const heard = floatToPcm16(shaped);
    if (n > 0 && shaped.length >= 2 * n) {
      const split = shaped.length - n;
      this.place(shaped.subarray(0, split), when, heard);
      const tailWhen = when + split / rate;
      const tailSamples = shaped.slice(split);
      this.tail = {
        source: this.place(tailSamples, tailWhen),
        samples: tailSamples,
        when: tailWhen,
      };
    } else {
      this.place(shaped, when, heard);
      this.tail = null;
    }
    this.nextTime = when + shaped.length / rate;
    return when;
  }

  /** Milliseconds the clip that `enqueue` just scheduled starts before the end of the one before it (0: no join). */
  lastOverlapMs(): number {
    return this.overlapMs;
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

  /** Scheduled audio that has not played yet, in milliseconds; 0 before the answer started and after a flush. */
  backlogMs(): number {
    return this.startedAt === null ? 0 : this.queuedMs();
  }

  /**
   * True while an answer is open and its backlog is below the floor: the speaker is close to running dry, so the
   * driver should hand over a shorter next clause now. The audio is never stretched to cover it.
   */
  underrunRisk(
    floorMs: number = this.options.underrunFloorMs ?? DEFAULT_UNDERRUN_FLOOR_MS,
  ): boolean {
    return this.startedAt !== null && this.backlogMs() < floorMs;
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

  /**
   * The time sources stop at. With an edge fade and a gain stage the voice falls to silence over the fade and the
   * stage is left behind (the next answer makes a fresh one at its own level); otherwise every source stops now.
   */
  private fadeOutAt(): number | undefined {
    const gain = this.gain;
    const ramp = gain?.gain.setTargetAtTime;
    if (!gain || !ramp || this.fadeSeconds <= 0 || this.sources.size === 0) return undefined;
    const now = this.context.currentTime;
    ramp.call(gain.gain, 0, now, this.fadeSeconds / 5);
    this.gain = null;
    return now + this.fadeSeconds;
  }

  /** Stop at once. Returns the milliseconds that were played, then starts a fresh answer. */
  flush(): number {
    const played = this.playedMs();
    const at = this.fadeOutAt();
    for (const source of this.sources) {
      try {
        source.onended = null;
        if (at === undefined) source.stop();
        else source.stop(at);
      } catch {
        /* a source that already ended */
      }
    }
    this.sources.clear();
    this.tail = null;
    this.overlapMs = 0;
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
