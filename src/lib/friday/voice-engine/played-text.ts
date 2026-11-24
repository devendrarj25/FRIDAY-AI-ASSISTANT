/**
 * FRIDAY · what was really heard of a spoken reply.
 *
 * When the owner cuts FRIDAY off, the conversation must remember what she managed to say, not the whole answer she
 * had planned. Every spoken clause is registered here with its text, its word count, its length and the moment it
 * started. At a stop, the heard part is the clauses that finished, plus the words of the clause that was playing,
 * counted by how much of it had elapsed and rounded down to a whole word. The elapsed time comes from the audio
 * element's own `currentTime` or the sample player's clock when a probe is given, and from the injected clock
 * otherwise, so the logic runs with a fake clock and no speaker.
 *
 * Clauses are grouped by the call that spoke them (one sentence). A stop that cut a sentence drops that sentence's
 * clauses from the record, because FRIDAY says it again from its start if the owner only nodded along.
 */

/** Spoken Hindi and English both run about 2.5 words a second; used only when a clip reports no length. */
export const ESTIMATED_WORD_MS = 400;
/** A reply this long (in clauses) is not recorded further; the heard part so far is kept. */
export const MAX_PLAYED_CLIPS = 500;

export type PlayedClip = {
  text: string;
  wordCount: number;
  durMs: number;
  startedAtMs: number;
};

/** The elapsed and total time of a clip as its player reports them, or null when the player cannot say. */
export type ClipProbe = () => { elapsedMs: number; durMs?: number } | null;

export type PlayedReply = {
  runId: string;
  /** What was heard, in order, with the original spacing and punctuation of every word kept. */
  text: string;
  words: number;
  wholeClips: number;
  /** Something was still playing or waiting when the voice was cut: the reply was not heard to its end. */
  interrupted: boolean;
};

/** Where a clause sits on the sample player's answer clock, from the TTS chunks it was made of. */
export type ClipSpan = { startMs: number; endMs: number };

/** The heard part cut at a clause boundary by the milliseconds the speaker really played. */
export type PlayedCut = PlayedReply & {
  /** The player's played milliseconds the cut was made for. */
  playedMs: number;
  /** End of the last whole clause that was heard, on the same clock (0 when none). */
  cutMs: number;
};

type Entry = PlayedClip & {
  group: number;
  done: boolean;
  probe: ClipProbe | undefined;
  span: ClipSpan | null;
};

const WORD = /\S+/g;

export const countWords = (text: string): number => (text.match(WORD) ?? []).length;

/** The first `words` words of the text exactly as written (spacing and marks kept), never a part of a word. */
export function firstWords(text: string, words: number): string {
  if (words <= 0) return "";
  let seen = 0;
  let end = 0;
  for (const match of text.matchAll(WORD)) {
    seen += 1;
    end = (match.index ?? 0) + match[0].length;
    if (seen >= words) break;
  }
  return text.slice(0, end);
}

export class PlayedTextTracker {
  private entries: Entry[] = [];
  private runId = "";
  private group = 0;
  private readonly open = new Set<number>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** The run whose clauses are recorded now. A different run forgets the earlier one; the same run keeps it. */
  begin(runId: string, force = false): void {
    if (!force && runId === this.runId) return;
    this.runId = runId;
    this.entries = [];
    this.group += 1;
    this.open.clear();
  }

  /** One `speakText` call (one sentence) is about to speak: its clauses share a group. Returns its end call. */
  openGroup(): () => void {
    this.group += 1;
    const id = this.group;
    this.open.add(id);
    // A stop empties the set, so a call that ends after a newer one started cannot close the newer one.
    return () => {
      this.open.delete(id);
    };
  }

  /**
   * A clause started playing now. `durMs` is its length; an unknown length is estimated from its words. `end` says it
   * played to its end; `drop` says it never made a sound (a failed clip), so it is not counted as heard.
   */
  startClip(
    text: string,
    durMs: number,
    probe?: ClipProbe,
    startedAtMs?: number,
    span?: ClipSpan | null,
  ): { end: () => void; drop: () => void } {
    const wordCount = countWords(text);
    const none = { end: () => undefined, drop: () => undefined };
    if (!wordCount || this.entries.length >= MAX_PLAYED_CLIPS) return none;
    const entry: Entry = {
      text: text.trim(),
      wordCount,
      durMs: Number.isFinite(durMs) && durMs > 0 ? durMs : wordCount * ESTIMATED_WORD_MS,
      startedAtMs: startedAtMs ?? this.clock(),
      group: this.group,
      done: false,
      probe,
      span: span && Number.isFinite(span.startMs) && Number.isFinite(span.endMs) ? span : null,
    };
    this.entries.push(entry);
    return {
      end: () => {
        entry.done = true;
      },
      drop: () => {
        this.entries = this.entries.filter((item) => item !== entry);
      },
    };
  }

  /** The heard part right now. Does not change the record. */
  snapshot(): PlayedReply {
    const parts: string[] = [];
    let words = 0;
    let whole = 0;
    let interrupted = this.open.size > 0;
    const now = this.clock();
    for (const entry of this.entries) {
      const state = this.progress(entry, now);
      if (state.fraction >= 1) {
        parts.push(entry.text);
        words += entry.wordCount;
        whole += 1;
        continue;
      }
      interrupted = true;
      const heard = Math.floor(state.fraction * entry.wordCount);
      if (heard > 0) {
        parts.push(firstWords(entry.text, heard));
        words += heard;
      }
      // Later clips of the record cannot have started before this one ended.
      break;
    }
    return { runId: this.runId, text: parts.join(" "), words, wholeClips: whole, interrupted };
  }

  /**
   * The heard part cut at the last clause boundary at or before `playedMs`, the milliseconds the speaker really
   * played (the sample player's clock minus its output buffer). A clause that carries its chunk span is whole when
   * its end is at or before `playedMs`; one with no span (the audio element, the system voice) is whole when its own
   * progress says so. The clause in progress is never part of it: the model is told only what was heard to the end
   * of a clause. Does not change the record.
   */
  heardAtMs(playedMs: number): PlayedCut {
    const at = Number.isFinite(playedMs) && playedMs > 0 ? playedMs : 0;
    const parts: string[] = [];
    let words = 0;
    let whole = 0;
    let cutMs = 0;
    let interrupted = this.open.size > 0;
    const now = this.clock();
    for (const entry of this.entries) {
      const complete = entry.span
        ? entry.span.endMs <= at + 0.5
        : this.progress(entry, now).fraction >= 1;
      if (!complete) {
        interrupted = true;
        break;
      }
      parts.push(entry.text);
      words += entry.wordCount;
      whole += 1;
      if (entry.span) cutMs = Math.max(cutMs, entry.span.endMs);
    }
    return {
      runId: this.runId,
      text: parts.join(" "),
      words,
      wholeClips: whole,
      interrupted,
      playedMs: at,
      cutMs,
    };
  }

  /**
   * The voice was stopped. Returns what was heard. A sentence that was cut leaves the record (it is said again from
   * its start if the reply resumes); the sentences before it stay.
   */
  stop(): PlayedReply {
    const heard = this.snapshot();
    if (heard.interrupted) {
      const cut = this.entries.find((entry) => !entry.done && this.progress(entry).fraction < 1);
      const cutGroup = cut ? cut.group : this.group;
      this.entries = this.entries.filter((entry) => entry.group < cutGroup);
    }
    for (const entry of this.entries) {
      entry.done = true;
      // The player's clock restarts after a stop: a span of the old clock means nothing to the next reply.
      entry.span = null;
    }
    this.open.clear();
    return heard;
  }

  /** How many clauses are recorded (tests and diagnostics). */
  size(): number {
    return this.entries.length;
  }

  private progress(entry: Entry, now = this.clock()): { fraction: number } {
    if (entry.done) return { fraction: 1 };
    const probed = entry.probe?.() ?? null;
    const dur =
      probed && Number.isFinite(probed.durMs) && (probed.durMs ?? 0) > 0
        ? (probed.durMs as number)
        : entry.durMs;
    const elapsed =
      probed && Number.isFinite(probed.elapsedMs) ? probed.elapsedMs : now - entry.startedAtMs;
    if (!(dur > 0)) return { fraction: 0 };
    return { fraction: Math.min(1, Math.max(0, elapsed / dur)) };
  }
}
