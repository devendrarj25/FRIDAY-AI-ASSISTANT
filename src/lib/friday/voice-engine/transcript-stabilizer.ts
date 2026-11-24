/**
 * FRIDAY · transcript stabilizer for chunked (incremental) speech recognition.
 *
 * The local engine is not a native streaming recogniser: it re-reads a rolling window of audio and returns a
 * fresh hypothesis each time. This module turns that sequence into text the rest of FRIDAY can trust:
 *   · words that two hypotheses in a row agree on become `stable`;
 *   · a new window that overlaps the committed text does not repeat words (`mergeOverlap`);
 *   · a partial is never `actionable`. Only a final transcript, or a stable run that is long enough, was
 *     held long enough and carries enough confidence, may start a tool or a consequential action.
 */

const MAX_OVERLAP_WORDS = 12;

const clean = (word: string): string =>
  word
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "");

export const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** Append `next` to `committed`, dropping the words that repeat the end of `committed`. */
export function mergeOverlap(committed: string, next: string): string {
  const a = words(committed);
  const b = words(next);
  if (!a.length) return b.join(" ");
  if (!b.length) return a.join(" ");
  const limit = Math.min(MAX_OVERLAP_WORDS, a.length, b.length);
  for (let size = limit; size >= 1; size -= 1) {
    const tail = a.slice(a.length - size).map(clean);
    const head = b.slice(0, size).map(clean);
    if (tail.every((w, i) => w !== "" && w === head[i])) return [...a, ...b.slice(size)].join(" ");
  }
  return [...a, ...b].join(" ");
}

function commonPrefix(left: string[], right: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (clean(left[i] ?? "") !== clean(right[i] ?? "")) break;
    out.push(right[i] ?? "");
  }
  return out;
}

/** One recognised word with its time in seconds (absolute on the utterance clock once a pass is pushed). */
export type TimedWord = { text: string; start: number; end: number };

export type AgreementOptions = {
  /** The longest repeat of the committed tail that a new pass may start with and still be stripped. */
  maxOverlapWords?: number;
  /** A word starting at or before the last committed time minus this is already settled (s). */
  dropMarginS?: number;
  /** The overlap strip only applies when the first new word starts this close to the committed end (s). */
  overlapWindowS?: number;
  /** The most words one pass may carry; a runaway pass is cut here. */
  maxPassWords?: number;
};

export type AgreementResult = {
  /** Every word two passes agreed on, in order, for the whole utterance. */
  committed: TimedWord[];
  /** The words this pass newly settled. */
  newlyCommitted: TimedWord[];
  /** What the latest pass heard after the settled words: shown dim, never settled until a pass agrees. */
  unstable: TimedWord[];
  /** End time (s) of the last committed word; 0 before the first commit. */
  lastCommittedTime: number;
};

const wordKey = (text: string): string => clean(text) || text.normalize("NFC").toLowerCase();

/**
 * LocalAgreement-2 over timed words, adapted from the Whisper streaming work (ufal/whisper_streaming) and the
 * coalescing in WhisperLiveKit. Each pass reads the rolling audio buffer and yields words timed inside that buffer;
 * `push` shifts them by the buffer's offset into one absolute clock, then:
 *   · drops words that start at or before the last committed time minus 0.1 s (already settled);
 *   · strips a repeat of the committed tail (up to five words) when the first new word starts within 1 s of it;
 *   · commits the longest common word prefix of this pass and the previous pass (the first pass commits nothing);
 *   · keeps the rest as unstable.
 * A committed word is never changed afterwards. Pure: no clock, no audio, no model.
 */
export class LocalAgreementStabilizer {
  private committed: TimedWord[] = [];
  private pending: TimedWord[] = [];
  private lastCommitted = 0;
  private readonly maxOverlap: number;
  private readonly dropMargin: number;
  private readonly overlapWindow: number;
  private readonly maxPassWords: number;

  constructor(options: AgreementOptions = {}) {
    this.maxOverlap = options.maxOverlapWords ?? 5;
    this.dropMargin = options.dropMarginS ?? 0.1;
    this.overlapWindow = options.overlapWindowS ?? 1;
    this.maxPassWords = options.maxPassWords ?? 400;
  }

  get lastCommittedTime(): number {
    return this.lastCommitted;
  }

  push(pass: TimedWord[], bufferOffsetS = 0): AgreementResult {
    const shifted: TimedWord[] = [];
    for (const word of pass) {
      const text = (word.text ?? "").trim();
      if (!text || shifted.length >= this.maxPassWords) continue;
      shifted.push({ text, start: word.start + bufferOffsetS, end: word.end + bufferOffsetS });
    }
    if (!shifted.length) return this.result([]); // a pass that heard nothing says nothing: the state stands
    let fresh = shifted.filter((w) => w.start > this.lastCommitted - this.dropMargin);
    const first = fresh[0];
    if (
      first &&
      this.committed.length &&
      Math.abs(first.start - this.lastCommitted) < this.overlapWindow
    ) {
      const limit = Math.min(this.maxOverlap, this.committed.length, fresh.length);
      for (let n = limit; n >= 1; n -= 1) {
        const tail = this.committed.slice(this.committed.length - n).map((w) => wordKey(w.text));
        const head = fresh.slice(0, n).map((w) => wordKey(w.text));
        if (tail.every((key, i) => key === head[i])) {
          fresh = fresh.slice(n);
          break;
        }
      }
    }
    const newly: TimedWord[] = [];
    let at = 0;
    while (at < fresh.length && at < this.pending.length) {
      const now = fresh[at];
      const before = this.pending[at];
      if (!now || !before || wordKey(now.text) !== wordKey(before.text)) break;
      newly.push(now);
      at += 1;
    }
    if (newly.length) {
      this.committed.push(...newly);
      this.lastCommitted = newly[newly.length - 1]?.end ?? this.lastCommitted;
    }
    this.pending = fresh.slice(newly.length);
    return this.result(newly);
  }

  private result(newly: TimedWord[]): AgreementResult {
    return {
      committed: [...this.committed],
      newlyCommitted: newly,
      unstable: [...this.pending],
      lastCommittedTime: this.lastCommitted,
    };
  }

  reset(): void {
    this.committed = [];
    this.pending = [];
    this.lastCommitted = 0;
  }
}

export type StabilizerOptions = {
  /** Words a stable run needs before it may act. */
  minActionWords?: number;
  /** How long the same stable run must have stood, in ms. */
  holdMs?: number;
  /** Lowest confidence (0..1) a stable run may carry; unknown confidence counts as not enough. */
  minConfidence?: number;
  now?: () => number;
};

export type StabilizerSnapshot = {
  committed: string;
  stable: string;
  partial: string;
  final: boolean;
  confidence: number | null;
  actionable: boolean;
};

export class TranscriptStabilizer {
  private committed = "";
  private previous: string[] = [];
  private stableWords: string[] = [];
  private stableSince = 0;
  private partial = "";
  private isFinal = false;
  private confidence: number | null = null;
  private readonly minActionWords: number;
  private readonly holdMs: number;
  private readonly minConfidence: number;
  private readonly now: () => number;

  constructor(options: StabilizerOptions = {}) {
    this.minActionWords = options.minActionWords ?? 3;
    this.holdMs = options.holdMs ?? 600;
    this.minConfidence = options.minConfidence ?? 0.6;
    this.now = options.now ?? Date.now;
  }

  /** A hypothesis for the current window. `window` text may overlap what was already committed. */
  push(
    hypothesis: string,
    meta: { final?: boolean; confidence?: number } = {},
  ): StabilizerSnapshot {
    if (this.isFinal) this.reset();
    const next = words(mergeOverlap(this.committed, hypothesis));
    const agreed = commonPrefix(this.previous, next);
    if (
      agreed.length !== this.stableWords.length ||
      agreed.join(" ") !== this.stableWords.join(" ")
    ) {
      this.stableSince = this.now();
    }
    this.stableWords = agreed;
    this.previous = next;
    this.partial = next.join(" ");
    this.confidence = typeof meta.confidence === "number" ? meta.confidence : null;
    if (meta.final) {
      this.committed = this.partial;
      this.stableWords = next;
      this.isFinal = true;
    }
    return this.snapshot();
  }

  /** Text that earlier windows already settled; the next window is merged against it. */
  commit(text: string): void {
    this.committed = text.trim();
  }

  snapshot(): StabilizerSnapshot {
    const stable = this.stableWords.join(" ");
    const heldLongEnough = this.now() - this.stableSince >= this.holdMs;
    const confident = this.confidence !== null && this.confidence >= this.minConfidence;
    const actionable =
      this.isFinal ||
      (this.stableWords.length >= this.minActionWords && heldLongEnough && confident);
    return {
      committed: this.committed,
      stable,
      partial: this.partial,
      final: this.isFinal,
      confidence: this.confidence,
      actionable,
    };
  }

  reset(): void {
    this.committed = "";
    this.previous = [];
    this.stableWords = [];
    this.stableSince = 0;
    this.partial = "";
    this.isFinal = false;
    this.confidence = null;
  }
}
