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
  private trimmed = 0;
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

  /** Seconds before which the audio buffer has been cut; never beyond the last committed word. */
  get trimmedAt(): number {
    return this.trimmed;
  }

  /**
   * The audio buffer is cut at `seconds` (the `trim_at` of the streaming committer). Only settled audio may be cut, so
   * the point is clamped to the last committed time and never moves back. Unsettled words that ended before the cut are
   * gone from the next pass, so they are dropped here instead of holding the next agreement back. Returns the applied
   * point.
   */
  trimAt(seconds: number): number {
    if (!Number.isFinite(seconds)) return this.trimmed;
    const point = Math.min(seconds, this.lastCommitted);
    if (point > this.trimmed) {
      this.trimmed = point;
      this.pending = this.pending.filter((w) => w.end > point);
    }
    return this.trimmed;
  }

  /** Replace the committed words from a corrected list (a revision; callers announce it). Pending words are cleared. */
  replaceCommitted(words: TimedWord[]): void {
    this.committed = words.map((w) => ({ ...w }));
    this.pending = [];
    this.lastCommitted = this.committed[this.committed.length - 1]?.end ?? 0;
    this.trimmed = Math.min(this.trimmed, this.lastCommitted);
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
    this.trimmed = 0;
  }
}

/** A word is `committed` (two passes agreed; fixed), `stable` (the same word at the same place in two passes in a row, but not agreed as a prefix yet) or `volatile` (new or changed in this pass). */
export type WordState = "committed" | "stable" | "volatile";
export type StatedWord = TimedWord & { state: WordState };

/** The only way committed words ever change: announced, counted and carrying what went and what came. */
export type RevisionEvent = {
  revision: number;
  reason: string;
  fromIndex: number;
  removed: TimedWord[];
  added: TimedWord[];
};

export type WordStreamSnapshot = {
  /** Counts revisions of committed words. While it is unchanged, committed words only ever grow at the end. */
  revision: number;
  /** committed, then stable, then volatile. */
  words: StatedWord[];
  committed: TimedWord[];
  stable: TimedWord[];
  volatile: TimedWord[];
  newlyCommitted: TimedWord[];
  lastCommittedTime: number;
  trimmedAt: number;
  /** Set only on the snapshot a revision happened in. */
  revised: RevisionEvent | null;
};

const sameWord = (a: TimedWord | undefined, b: TimedWord | undefined): boolean =>
  !!a && !!b && wordKey(a.text) === wordKey(b.text);

/**
 * LocalAgreement-2 plus the guarantees a screen needs: every word carries a state (committed, stable, volatile), and
 * committed words are append-only unless an explicit revision (`revise` or `finalize`) changes them, which bumps
 * `revision` and reports the change once. `trimAt` mirrors the streaming committer's trim point in seconds. Pure.
 */
export class WordStateStabilizer {
  private readonly agree: LocalAgreementStabilizer;
  private revision = 0;
  private lastUnstable: TimedWord[] = [];

  constructor(options: AgreementOptions = {}) {
    this.agree = new LocalAgreementStabilizer(options);
  }

  push(pass: TimedWord[], bufferOffsetS = 0): WordStreamSnapshot {
    const result = this.agree.push(pass, bufferOffsetS);
    const shift = result.newlyCommitted.length;
    const stable: TimedWord[] = [];
    const volatile: TimedWord[] = [];
    result.unstable.forEach((word, at) => {
      (sameWord(word, this.lastUnstable[shift + at]) ? stable : volatile).push(word);
    });
    this.lastUnstable = result.unstable;
    return this.snapshot(result.newlyCommitted, null, stable, volatile);
  }

  /** The audio buffer is cut at `seconds`; clamped to settled audio. Returns the applied point. */
  trimAt(seconds: number): number {
    const applied = this.agree.trimAt(seconds);
    this.lastUnstable = this.lastUnstable.filter((w) => w.end > applied);
    return applied;
  }

  /** Change committed words from `fromIndex` on. A no-op (no revision) when the words are already those. */
  revise(fromIndex: number, replacement: TimedWord[], reason = "revised"): WordStreamSnapshot {
    const current = this.agree.push([], 0).committed;
    const at = Math.max(0, Math.min(Math.trunc(fromIndex) || 0, current.length));
    const removed = current.slice(at);
    const same =
      removed.length === replacement.length &&
      removed.every((w, i) => w.text === replacement[i]?.text);
    if (same) return this.snapshot([], null, [], []);
    const next = [...current.slice(0, at), ...replacement];
    this.agree.replaceCommitted(next);
    this.lastUnstable = [];
    this.revision += 1;
    return this.snapshot(
      [],
      { revision: this.revision, reason, fromIndex: at, removed, added: replacement },
      [],
      [],
    );
  }

  /**
   * The final reading is authoritative. When it only extends the committed words they are appended (no revision);
   * when it disagrees with a committed word, that is a revision from the first difference on. Afterwards every word is
   * committed.
   */
  finalize(final: TimedWord[]): WordStreamSnapshot {
    const current = this.agree.push([], 0).committed;
    let at = 0;
    while (at < current.length && at < final.length && sameWord(current[at], final[at])) at += 1;
    if (at < current.length) return this.revise(at, final.slice(at), "final");
    const tail = final.slice(at);
    if (!tail.length) return this.snapshot([], null, [], []);
    this.agree.replaceCommitted([...current, ...tail]);
    this.lastUnstable = [];
    return this.snapshot(tail, null, [], []);
  }

  reset(): void {
    this.agree.reset();
    this.revision = 0;
    this.lastUnstable = [];
  }

  private snapshot(
    newly: TimedWord[],
    revised: RevisionEvent | null,
    stable: TimedWord[],
    volatile: TimedWord[],
  ): WordStreamSnapshot {
    const committed = this.agree.push([], 0).committed;
    const state = (words: TimedWord[], kind: WordState): StatedWord[] =>
      words.map((w) => ({ ...w, state: kind }));
    return {
      revision: this.revision,
      words: [
        ...state(committed, "committed"),
        ...state(stable, "stable"),
        ...state(volatile, "volatile"),
      ],
      committed,
      stable,
      volatile,
      newlyCommitted: newly,
      lastCommittedTime: this.agree.lastCommittedTime,
      trimmedAt: this.agree.trimmedAt,
      revised,
    };
  }
}

/** The flicker guarantee: between two snapshots, committed words only grew at the end unless the revision moved. */
export function isAppendOnly(before: WordStreamSnapshot, after: WordStreamSnapshot): boolean {
  if (after.revision !== before.revision) return after.revision > before.revision;
  if (after.committed.length < before.committed.length) return false;
  return before.committed.every((w, i) => w.text === after.committed[i]?.text);
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
