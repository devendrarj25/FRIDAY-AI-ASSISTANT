/**
 * FRIDAY · clause chunker: cut a growing answer into speakable clauses, the first one small.
 *
 * Local synthesis costs time in proportion to the audio it makes (about 0.22 of real time on a CPU), so the first
 * sound arrives sooner when the first clause is short. The first clause ends at the first comma, semicolon, colon,
 * dash or sentence end once it holds `minWords` to `maxWords` words and `minChars` characters, or at `maxWords`
 * words when the answer offers no break. Every later clause is a sentence, and a sentence longer than `maxChars`
 * is split the way `splitLongSpeech` splits it.
 *
 * Pure and deterministic, with nothing injected. A cut is made only where the text so far decides it (a break mark
 * must be followed by a space, or the answer must be final), so feeding the answer one character at a time gives
 * the same clauses as giving it whole. A cut never lands inside a number (3.5, 1,000), an abbreviation (Dr., e.g.),
 * an initial, a link or address, a code span, a quotation or a word (a word is whatever sits between spaces, so a
 * Devanagari word is never split). Hindi uses the danda and the same word counts.
 */
import { endsInOpenDot, splitLongSpeech } from "./language-segmenter";

export const FIRST_CLAUSE_MIN_WORDS = 4;
export const FIRST_CLAUSE_MAX_WORDS = 8;
export const FIRST_CLAUSE_MIN_CHARS = 18;
export const CLAUSE_MAX_CHARS = 160;

/** How many words past `maxWords` the cut may be pushed on, by a quote or an abbreviation, before giving up. */
const EXTENSION_WORDS = 4;

export type ClauseOptions = {
  /** Apply the small first-clause rule to the first clause (the answer has not been spoken yet). */
  first?: boolean;
  /** The answer is complete: whatever is left is a clause. */
  final?: boolean;
  minWords?: number;
  maxWords?: number;
  minChars?: number;
  /** A later clause longer than this is split. */
  maxChars?: number;
};

export type ClauseChunks = {
  clauses: string[];
  /** The text that was not cut yet. */
  rest: string;
  /** How many characters of the input were cut (the clauses plus the spaces after them). */
  consumed: number;
};

type Token = {
  start: number;
  end: number;
  text: string;
  /** Not inside a code span or a quotation once this token is read. */
  clean: boolean;
  /** Carries a letter or a digit (a dash on its own is not a word). */
  word: boolean;
};

const TOKEN = /\S+/gu;
const HAS_WORD = /[\p{L}\p{N}]/u;
const CLOSERS = /["”’')\]}»]+$/u;
const LONE_DASH = new Set(["-", "--", "—", "–"]);
const NUMBER_BEFORE = /^[\d०-९][\d०-९.,]*$/u;

/** Cut the text into space-separated tokens and note, after each, whether a code span or a quotation is open. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let code = false;
  let quote = false;
  for (const match of text.matchAll(TOKEN)) {
    const word = match[0];
    for (const ch of word) {
      if (ch === "`") code = !code;
      else if (!code) {
        if (ch === '"') quote = !quote;
        else if (ch === "“") quote = true;
        else if (ch === "”") quote = false;
      }
    }
    const start = match.index ?? 0;
    out.push({
      start,
      end: start + word.length,
      text: word,
      clean: !code && !quote,
      word: HAS_WORD.test(word),
    });
  }
  return out;
}

type BreakKind = "sentence" | "soft" | "dash" | null;

/** What kind of cut, if any, this token allows after it. The text before decides, never the text after. */
function breakKind(text: string, token: Token): BreakKind {
  if (LONE_DASH.has(token.text)) return "dash";
  const core = token.text.replace(CLOSERS, "");
  const last = core.slice(-1);
  if (!last) return null;
  const upTo = text.slice(Math.max(0, token.start + core.length - 120), token.start + core.length);
  if (/[!?।॥]/u.test(last)) return "sentence";
  if (last === ".") return endsInOpenDot(upTo) ? null : "sentence";
  if (/[,;:]/.test(last)) {
    if (endsInOpenDot(upTo.slice(0, -1))) return null;
    if (NUMBER_BEFORE.test(core.slice(0, -1))) return null;
    return "soft";
  }
  if (/[—–]/u.test(last)) return "soft";
  return null;
}

/** An abbreviation or an initial ("Dr.", "e.g.", "J.") must never be the last word of a clause. */
function endsOpen(text: string, token: Token): boolean {
  return endsInOpenDot(text.slice(Math.max(0, token.start + token.text.length - 120), token.end));
}

/**
 * The first clause of an answer, or null when the text so far does not yet decide one. `consumed` includes the
 * spaces after the clause. Only the words of the text so far are read, so a longer text never changes an earlier cut.
 */
export function firstClauseCut(
  text: string,
  options: ClauseOptions = {},
): { spoken: string; consumed: number } | null {
  return scanFirstClause(text, options).cut;
}

type FirstScan = { cut: { spoken: string; consumed: number } | null; gaveUp: boolean };

/** The first clause, and whether the text has gone on too long to ever make a small one. */
function scanFirstClause(text: string, options: ClauseOptions): FirstScan {
  const minWords = options.minWords ?? FIRST_CLAUSE_MIN_WORDS;
  const maxWords = options.maxWords ?? FIRST_CLAUSE_MAX_WORDS;
  const minChars = options.minChars ?? FIRST_CLAUSE_MIN_CHARS;
  const tokens = tokenize(text);
  const first = tokens[0];
  if (!first) return { cut: null, gaveUp: false };
  let words = 0;
  for (const token of tokens) {
    if (token.end >= text.length && !options.final) break; // not followed by a space yet: it may still grow
    if (token.word) words += 1;
    if (words > maxWords + EXTENSION_WORDS) return { cut: null, gaveUp: true };
    if (!token.clean) continue;
    const kind = breakKind(text, token);
    const cutEnd = kind === "dash" ? token.start : token.end;
    const clause = text.slice(first.start, cutEnd).trim();
    const byBreak =
      kind !== null && words >= minWords && words <= maxWords && clause.length >= minChars;
    const byLength = token.word && words >= maxWords && !endsOpen(text, token);
    if (!(byBreak || byLength) || !clause) continue;
    let consumed = token.end;
    while (consumed < text.length && /\s/.test(text[consumed] ?? "")) consumed += 1;
    return { cut: { spoken: clause, consumed }, gaveUp: false };
  }
  return { cut: null, gaveUp: false };
}

/**
 * Cut as many clauses as the text so far decides. `rest` is what waits for more text; with `final` it is empty.
 * Call again with the rest and the next words; pass `first` only until the first clause has been taken.
 */
export function chunkClauses(text: string, options: ClauseOptions = {}): ClauseChunks {
  const maxChars = options.maxChars ?? CLAUSE_MAX_CHARS;
  const clauses: string[] = [];
  let from = 0;
  const skipSpace = (at: number): number => {
    let next = at;
    while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
    return next;
  };
  let sentenceMode = !options.first;
  if (options.first) {
    const scan = scanFirstClause(text, options);
    if (scan.cut) {
      clauses.push(scan.cut.spoken);
      from = scan.cut.consumed;
    }
    // Undecided means wait for more words; only a final answer, or one too long to ever make a small first clause,
    // is cut as sentences from the start.
    sentenceMode = scan.cut !== null || scan.gaveUp || options.final === true;
  }
  if (sentenceMode) {
    let start = skipSpace(from);
    for (const token of tokenize(text)) {
      if (token.end <= start) continue;
      if (token.end >= text.length && !options.final) break;
      if (!token.clean || breakKind(text, token) !== "sentence") continue;
      for (const piece of splitLongSpeech(text.slice(start, token.end), maxChars))
        clauses.push(piece);
      from = skipSpace(token.end);
      start = from;
    }
    if (options.final) {
      const tail = text.slice(start).trim();
      if (tail) for (const piece of splitLongSpeech(tail, maxChars)) clauses.push(piece);
      from = text.length;
    }
  }
  return { clauses, rest: text.slice(from), consumed: from };
}
