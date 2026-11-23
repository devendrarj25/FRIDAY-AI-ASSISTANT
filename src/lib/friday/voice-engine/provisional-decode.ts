/**
 * FRIDAY · provisional (speculative) decode of the closing pause.
 *
 * While the owner is quiet and the end-of-turn model already says the turn is probably over, the audio so far is
 * read at once instead of after the pause is up. If speech resumes the read is cancelled and thrown away. If the
 * pause closes with the same audio, that read IS the answer: the final decode is not run a second time
 * (adopt-on-equal). A read for an older pause is never adopted (a generation counter plus a cancelled flag), and
 * the audio must match sample for sample over the window the read heard.
 *
 * Pure: the clock, the recogniser and the cancel are injected, so a test needs no PC and no worker.
 */

/** The longest stretch of quiet that may follow the read's window and still count as the same audio. */
export const PROVISIONAL_MAX_TAIL_MS = 1_500;
/** The tail may be this much longer than the time that passed (frame and timer granularity). */
const TAIL_SLACK_MS = 250;
/** The gate's quiet clock may read this much lower than the elapsed time before it counts as speech heard. */
const QUIET_SLACK_MS = 80;
/** Below this the end-of-turn model does not think the turn is over, and nothing is read early. */
export const PROVISIONAL_MIN_SCORE = 0.5;
/**
 * A cancelled read cannot stop inside the model call it is in (the cancel is read between segments and passes), so a
 * final decode that follows a cancel waits for it. On a decoder slower than this the wait can cost more than the
 * early read saves, and no early read is made.
 */
export const PROVISIONAL_MAX_DECODE_MS = 1_200;
/**
 * How many recent reads are remembered, and the share of wasted ones above which reading early pauses. Measured on a
 * CPU decoder (about 1.2 s a clip): a kept read saves about 0.35 s, a cancelled one costs the final decode about 0.6 s,
 * so reading early only pays while fewer than about a third of the reads are wasted.
 */
const OUTCOME_WINDOW = 8;
const OUTCOME_MIN = 4;
const WASTED_SHARE = 0.34;
/** While paused, this many new utterances pass and then the record is cleared so the idea is tried again. */
const RETRY_AFTER_SEGMENTS = 6;
const RATE = 16_000;

/** A cheap fingerprint of a sample window (FNV-1a over the float bits). */
export function fingerprintSamples(samples: Float32Array): number {
  const bits = new Uint32Array(1);
  const view = new Float32Array(bits.buffer);
  let hash = 0x811c9dc5;
  for (let i = 0; i < samples.length; i += 1) {
    view[0] = samples[i] ?? 0;
    hash = Math.imul(hash ^ (bits[0] ?? 0), 0x01000193) >>> 0;
  }
  return hash;
}

export type ProvisionalWindow = {
  length: number;
  fingerprint: number;
  startedAt: number;
  quietMs: number;
};

/**
 * True when `final` is the audio the read heard plus the quiet that followed: the same first `length` samples, a
 * tail no longer than the time that passed (and never past the cap), and no speech since (the gate's quiet clock
 * kept counting up from the value it had when the read began).
 */
export function sameWindow(
  window: ProvisionalWindow,
  final: Float32Array,
  at: { quietMs: number; now: number },
): boolean {
  if (final.length < window.length || window.length === 0) return false;
  const elapsed = at.now - window.startedAt;
  const tailMs = ((final.length - window.length) * 1000) / RATE;
  if (tailMs > PROVISIONAL_MAX_TAIL_MS || tailMs > elapsed + TAIL_SLACK_MS) return false;
  if (at.quietMs < window.quietMs + elapsed - QUIET_SLACK_MS) return false;
  return fingerprintSamples(final.subarray(0, window.length)) === window.fingerprint;
}

/** One tick's answer: is a provisional read wanted now? */
export function provisionalWanted(input: {
  /** The end-of-turn model's probability for this pause, or null when it has not answered. */
  score: number | null;
  speech: boolean;
  tooLong: boolean;
  /** An earlier utterance is still being transcribed (the worker is not free). */
  busy: boolean;
  /** A read is already running or was already made for this pause. */
  running: boolean;
  /** The owner keeps spoken clips for diagnostics: every utterance must then be a real, recorded decode. */
  keepClips: boolean;
  /** The utterance comes from the PCM ring (the recorder path has no window to compare). */
  pcm: boolean;
}): boolean {
  if (input.score === null || !Number.isFinite(input.score) || input.score < PROVISIONAL_MIN_SCORE)
    return false;
  return (
    !input.speech &&
    !input.tooLong &&
    !input.busy &&
    !input.running &&
    !input.keepClips &&
    input.pcm
  );
}

export type ProvisionalAnswer = {
  ok: boolean;
  text?: string;
  cancelled?: boolean;
  reason?: string;
};

export type ProvisionalDeps<R extends ProvisionalAnswer> = {
  now: () => number;
  transcribe: (request: { utteranceId: string; samples: Float32Array }) => Promise<R>;
  cancel: (utteranceId: string) => void | Promise<unknown>;
};

type ReadRecord<R extends ProvisionalAnswer> = {
  id: string;
  generation: number;
  window: ProvisionalWindow;
  signature: string;
  cancelled: boolean;
  told: boolean;
  promise: Promise<R | null>;
};

/** The read of one sealed pause, handed to the queue with the utterance. */
export class ProvisionalHandle<R extends ProvisionalAnswer> {
  constructor(
    private readonly record: ReadRecord<R>,
    private readonly owner: ProvisionalDecoder<R>,
  ) {}

  /** The provisional answer when it can stand as the final one, else null (the caller decodes as usual). */
  async take(): Promise<R | null> {
    const answer = await this.record.promise;
    if (this.record.cancelled || !answer?.ok || answer.cancelled) return null;
    if (!(answer.text ?? "").trim()) return null;
    this.owner.noteAdopted();
    return answer;
  }

  /** The utterance was dropped before it was transcribed. */
  cancel(): void {
    this.owner.cancelRecord(this.record);
  }
}

export class ProvisionalDecoder<R extends ProvisionalAnswer> {
  private generation = 0;
  private startedGeneration = -1;
  private sequence = 0;
  /** Ids stay unique across a reload of the page, so a late cancel can never hit another page's read. */
  private readonly epoch = Date.now().toString(36);
  private current: ReadRecord<R> | null = null;
  private counts = { started: 0, cancelled: 0, adopted: 0, discarded: 0 };
  private outcomes: boolean[] = [];
  private skipped = 0;

  constructor(private readonly deps: ProvisionalDeps<R>) {}

  active(): boolean {
    return this.current !== null;
  }

  /** True once a read was made for this pause (even one that failed): a pause gets one read, not one per tick. */
  attempted(): boolean {
    return this.startedGeneration === this.generation;
  }

  stats(): { started: number; cancelled: number; adopted: number; discarded: number } {
    return { ...this.counts };
  }

  /** Speech resumed: whatever read was running is for an older pause. */
  invalidate(): void {
    this.generation += 1;
    this.cancel();
  }

  /** A new utterance opened. Like `invalidate`, and it lets a paused decoder try again after a few utterances. */
  openSegment(): void {
    this.invalidate();
    if (this.paused() && (this.skipped += 1) >= RETRY_AFTER_SEGMENTS) {
      this.outcomes = [];
      this.skipped = 0;
    }
  }

  private paused(): boolean {
    if (this.outcomes.length < OUTCOME_MIN) return false;
    const wasted = this.outcomes.filter(Boolean).length;
    return wasted / this.outcomes.length > WASTED_SHARE;
  }

  /**
   * Is an early read worth making? Not when the recent decodes were slow (a cancel would then cost more than the
   * read saves), and not while most recent reads were wasted (the owner pauses and goes on a lot).
   */
  worthwhile(expectedDecodeMs: number | null): boolean {
    if (expectedDecodeMs !== null && expectedDecodeMs > PROVISIONAL_MAX_DECODE_MS) return false;
    return !this.paused();
  }

  private note(wasted: boolean): void {
    this.outcomes = [...this.outcomes.slice(-(OUTCOME_WINDOW - 1)), wasted];
  }

  /** Read the audio so far. False when one was already made for this pause, or there is nothing to read. */
  start(input: { samples: Float32Array; quietMs: number; signature: string }): boolean {
    if (this.attempted() || this.current || input.samples.length === 0) return false;
    this.startedGeneration = this.generation;
    this.sequence += 1;
    const id = `p${this.epoch}-${this.sequence}g${this.generation}`;
    const record: ReadRecord<R> = {
      id,
      generation: this.generation,
      window: {
        length: input.samples.length,
        fingerprint: fingerprintSamples(input.samples),
        startedAt: this.deps.now(),
        quietMs: input.quietMs,
      },
      signature: input.signature,
      cancelled: false,
      told: false,
      promise: Promise.resolve(null),
    };
    try {
      record.promise = this.deps
        .transcribe({ utteranceId: id, samples: input.samples })
        .catch(() => null);
    } catch {
      /* a bridge that throws at once is the same as one that answers not ok: the final decode runs as usual */
    }
    this.current = record;
    this.counts.started += 1;
    return true;
  }

  /** Stop the read that is running (speech resumed, the owner stopped listening). */
  cancel(): void {
    if (this.current) this.cancelRecord(this.current);
  }

  /**
   * The pause closed with `samples`. A handle when this audio is the window the read heard (and the request is the
   * same), else the read is cancelled and null is returned. Either way the decoder is free for the next pause.
   */
  seal(input: {
    samples: Float32Array;
    quietMs: number;
    signature: string;
  }): ProvisionalHandle<R> | null {
    const record = this.current;
    if (!record) return null;
    this.current = null;
    const same =
      record.generation === this.generation &&
      !record.cancelled &&
      record.signature === input.signature &&
      sameWindow(record.window, input.samples, { quietMs: input.quietMs, now: this.deps.now() });
    if (!same) {
      this.cancelRecord(record);
      this.counts.discarded += 1;
      return null;
    }
    return new ProvisionalHandle(record, this);
  }

  /** @internal */
  cancelRecord(record: ReadRecord<R>): void {
    if (this.current === record) this.current = null;
    if (record.cancelled) return;
    record.cancelled = true;
    this.counts.cancelled += 1;
    this.note(true);
    if (record.told) return;
    record.told = true;
    try {
      const out = this.deps.cancel(record.id);
      if (out && typeof (out as Promise<unknown>).catch === "function") {
        (out as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      /* the bridge is gone; the worker answers the read and it is dropped anyway */
    }
  }

  /** @internal */
  noteAdopted(): void {
    this.counts.adopted += 1;
    this.note(false);
  }
}
