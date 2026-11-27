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

/**
 * One syllable-like unit of speech, in milliseconds: used only when a clip reports no length (a clause of average
 * Hindi or English runs close to 400 ms a word at this unit).
 */
export const ESTIMATED_UNIT_MS = 200;
/** A reply this long (in clauses) is not recorded further; the heard part so far is kept. */
export const MAX_PLAYED_CLIPS = 500;

/** One word of a clause on the clause's own clock: the words are the whitespace-separated tokens of its text. */
export type WordTime = { word: string; startMs: number; endMs: number };

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
  /** Real word timings from the voice engine, or null (the weighted estimate is used then). */
  wordTimes: readonly WordTime[] | null;
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

// Speech weights: one unit is one syllable-like beat. A word also costs a small onset, and punctuation after it a pause.
const WORD_ONSET = 0.35;
const DIGIT_UNITS = 1.2;
const MAX_DIGIT_UNITS = 8;
const PAUSE_UNITS: Record<string, number> = {
  ",": 0.5,
  ";": 0.7,
  ":": 0.7,
  "\u2014": 0.5,
  "\u2013": 0.4,
  ".": 1,
  "!": 1,
  "?": 1,
  "\u0964": 1,
  "\u0965": 1,
  "\u2026": 1.2,
};
const MAX_PAUSE_UNITS = 1.4;
const DEVANAGARI_RUN = /[\u0900-\u097F]+/g;
const VOWEL_GROUP = /[aeiouy]+/g;
const VIRAMA = "\u094D";
const NUKTA = "\u093C";

/** Syllables of a run of Devanagari: every vowel letter and every consonant that does not carry a virama. */
function devanagariSyllables(run: string): number {
  const chars = [...run];
  let count = 0;
  let lastIsBareConsonant = false;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] ?? "";
    const code = c.codePointAt(0) ?? 0;
    const independentVowel = (code >= 0x904 && code <= 0x914) || code === 0x960 || code === 0x961;
    const consonant = (code >= 0x915 && code <= 0x939) || (code >= 0x958 && code <= 0x95f);
    lastIsBareConsonant = false;
    if (independentVowel) {
      count += 1;
    } else if (consonant) {
      let next = chars[i + 1];
      if (next === NUKTA) next = chars[i + 2];
      if (next !== VIRAMA) {
        count += 1;
        lastIsBareConsonant = next === undefined;
      }
    }
  }
  // The inherent vowel is not said at the end of a word (kamal, not kamala).
  return lastIsBareConsonant && count > 1 ? count - 1 : count;
}

/** Syllables of a Latin word: vowel groups, a silent final e dropped; capitals-only short tokens read letter by letter. */
function latinSyllables(word: string): number {
  if (word.length >= 2 && word.length <= 6 && word === word.toUpperCase()) return word.length;
  let lower = word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  lower = lower.replace(/^y(?=[aeiou])/, "");
  let count = (lower.match(VOWEL_GROUP) ?? []).length;
  if (count > 1 && /[^aeiouyl]e$/.test(lower)) count -= 1;
  return Math.max(1, count);
}

/** Speech units of one token (no pause): syllables of its Devanagari, Latin, digit and other letters, plus the word onset. */
export function wordUnits(token: string): number {
  let units = 0;
  let letters = false;
  const rest = token.replace(DEVANAGARI_RUN, (run) => {
    letters = true;
    units += devanagariSyllables(run);
    return " ";
  });
  for (const part of rest.split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    for (const piece of part.match(/\p{N}+|[\p{L}\p{M}]+/gu) ?? []) {
      letters = true;
      if (/^\p{N}/u.test(piece))
        units += Math.min(MAX_DIGIT_UNITS, Math.ceil(piece.length * DIGIT_UNITS));
      else if (/^[A-Za-z\u00C0-\u024F]+$/.test(piece)) units += latinSyllables(piece);
      else units += [...piece].length;
    }
  }
  return letters ? WORD_ONSET + units : 0;
}

/** Pause units after a token: its trailing punctuation, capped. */
export function pauseUnits(token: string): number {
  const tail = token.match(/[^\p{L}\p{N}\p{M}]+$/u)?.[0] ?? "";
  let pause = 0;
  for (const ch of tail) pause += PAUSE_UNITS[ch] ?? 0;
  return Math.min(MAX_PAUSE_UNITS, pause);
}

/**
 * Where each word of a clause sits on the clause's clock when no real timings exist. Each word gets a weight from its
 * syllable-like units and the pause its punctuation asks for; the weights are scaled so the last word ends exactly at
 * `durMs` (the pause after the last word is not counted: the clip ends with the speech).
 */
export function estimateWordTimes(text: string, durMs: number): WordTime[] {
  const tokens = text.match(WORD) ?? [];
  if (!tokens.length || !(durMs > 0) || !Number.isFinite(durMs)) return [];
  const speech = tokens.map((token) => wordUnits(token));
  const pause = tokens.map((token, i) => (i === tokens.length - 1 ? 0 : pauseUnits(token)));
  let total = 0;
  for (let i = 0; i < tokens.length; i += 1) total += (speech[i] ?? 0) + (pause[i] ?? 0);
  // A clause of only marks has no speech to weigh: its words share the time evenly.
  const flat = !(total > 0);
  const unit = flat ? durMs / tokens.length : durMs / total;
  const out: WordTime[] = [];
  let cursor = 0;
  tokens.forEach((word, i) => {
    const startMs = cursor;
    const span = flat ? unit : (speech[i] ?? 0) * unit;
    const endMs = i === tokens.length - 1 ? durMs : startMs + span;
    out.push({ word, startMs, endMs });
    cursor = endMs + (flat ? 0 : (pause[i] ?? 0) * unit);
  });
  return out;
}

/** How long a clause is likely to take when its player cannot say: its weighted units at `ESTIMATED_UNIT_MS`. */
export function estimateClipMs(text: string): number {
  const tokens = text.match(WORD) ?? [];
  let total = 0;
  tokens.forEach((token, i) => {
    total += wordUnits(token) + (i === tokens.length - 1 ? 0 : pauseUnits(token));
  });
  return Math.max(tokens.length ? ESTIMATED_UNIT_MS : 0, total * ESTIMATED_UNIT_MS);
}

/**
 * Whole words said by `elapsedMs`, scaled to `wordCount` when the timing list counted the words differently (a
 * provider that splits "don't"). A word counts only when its end is reached, so the cut never lands inside a word.
 */
export function heardWordCount(
  times: readonly WordTime[],
  elapsedMs: number,
  wordCount: number,
): number {
  if (!times.length || !(elapsedMs > 0)) return 0;
  let done = 0;
  for (const item of times) {
    if (item.endMs <= elapsedMs + 1e-6) done += 1;
    else break;
  }
  return Math.min(wordCount, Math.floor((done * wordCount) / times.length + 1e-9));
}

function cleanWordTimes(times: readonly WordTime[] | null | undefined): readonly WordTime[] | null {
  if (!times || !times.length) return null;
  for (const item of times) {
    if (!Number.isFinite(item.startMs) || !Number.isFinite(item.endMs) || item.endMs < item.startMs)
      return null;
  }
  return times;
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
   * played to its end; `drop` says it never made a sound (a failed clip), so it is not counted as heard. `wordTimes`
   * are the voice engine's own word timings when it has them; without them the words are timed by weight.
   */
  startClip(
    text: string,
    durMs: number,
    probe?: ClipProbe,
    startedAtMs?: number,
    span?: ClipSpan | null,
    wordTimes?: readonly WordTime[] | null,
  ): { end: () => void; drop: () => void } {
    const wordCount = countWords(text);
    const none = { end: () => undefined, drop: () => undefined };
    if (!wordCount || this.entries.length >= MAX_PLAYED_CLIPS) return none;
    const entry: Entry = {
      text: text.trim(),
      wordCount,
      durMs: Number.isFinite(durMs) && durMs > 0 ? durMs : estimateClipMs(text),
      startedAtMs: startedAtMs ?? this.clock(),
      group: this.group,
      done: false,
      probe,
      span: span && Number.isFinite(span.startMs) && Number.isFinite(span.endMs) ? span : null,
      wordTimes: cleanWordTimes(wordTimes),
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
      const heard = this.heardWords(entry, state.elapsedMs, state.durMs);
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

  /** Whole words of the clause said by `elapsedMs`: its real word times, else the weighted estimate over `durMs`. */
  private heardWords(entry: Entry, elapsedMs: number, durMs: number): number {
    const times = entry.wordTimes ?? estimateWordTimes(entry.text, durMs);
    return heardWordCount(times, elapsedMs, entry.wordCount);
  }

  private progress(
    entry: Entry,
    now = this.clock(),
  ): { fraction: number; elapsedMs: number; durMs: number } {
    if (entry.done) return { fraction: 1, elapsedMs: entry.durMs, durMs: entry.durMs };
    const probed = entry.probe?.() ?? null;
    const dur =
      probed && Number.isFinite(probed.durMs) && (probed.durMs ?? 0) > 0
        ? (probed.durMs as number)
        : entry.durMs;
    const elapsed =
      probed && Number.isFinite(probed.elapsedMs) ? probed.elapsedMs : now - entry.startedAtMs;
    if (!(dur > 0)) return { fraction: 0, elapsedMs: 0, durMs: 0 };
    return { fraction: Math.min(1, Math.max(0, elapsed / dur)), elapsedMs: elapsed, durMs: dur };
  }
}
