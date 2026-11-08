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
