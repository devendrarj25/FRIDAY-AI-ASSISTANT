/**
 * FRIDAY · clause chunker: cut a growing answer into speakable clauses, the first one small.
 *
 * Local synthesis costs time in proportion to the audio it makes (about 0.22 of real time on a CPU), so the first
 * sound arrives sooner when the first clause is short. The first clause ends at the first comma, semicolon, colon,
 * dash or sentence end once it holds `minWords` to `maxWords` words and `minChars` characters. Without such a mark
 * it ends before an "and", "but", "aur" or "lekin" (or after a "toh") that falls in the same range, and without
 * that at the last word within `maxWords` that can end a clause: never inside a number and its unit, a time, a
 * link, a title and its name, between a Hindi word and its postposition, or after a word that leads into the next
 * ("the", "of", "ka", "ke"). That choice reads one word past the cut, so it waits for that word to arrive. Every
 * later clause is a sentence, and a sentence longer than `maxChars` is split the way `splitLongSpeech` splits it.
 *
 * Pure and deterministic, with nothing injected. A cut is made only where the text so far decides it (a break mark
 * must be followed by a space, or the answer must be final), so feeding the answer one character at a time gives
 * the same clauses as giving it whole. A cut never lands inside a number (3.5, 1,000), an abbreviation (Dr., e.g.),
 * an initial, a link or address, a code span, a quotation or a word (a word is whatever sits between spaces, so a
 * Devanagari word is never split). Hindi uses the danda and the same word counts.
 */
import { endsInOpenDot, splitLongSpeech } from "./language-segmenter";

export const FIRST_CLAUSE_MIN_WORDS = 4;
export const FIRST_CLAUSE_MAX_WORDS = 6;
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

/** Words that lead into the next word: a clause never ends on one of these. */
const LEADS_ON = new Set([
  ...[
    "the",
    "a",
    "an",
    "of",
    "to",
    "in",
    "on",
    "at",
    "for",
    "with",
    "by",
    "from",
    "and",
    "or",
    "but",
  ],
  ...[
    "my",
    "your",
    "his",
    "her",
    "our",
    "their",
    "this",
    "that",
    "these",
    "those",
    "is",
    "are",
    "was",
  ],
  ...[
    "were",
    "will",
    "can",
    "around",
    "about",
    "after",
    "before",
    "until",
    "because",
    "if",
    "when",
  ],
  ...["while", "than", "as", "into", "over", "under", "between", "through", "during", "without"],
  ...[
    "i",
    "we",
    "they",
    "he",
    "she",
    "what",
    "which",
    "who",
    "whom",
    "whose",
    "how",
    "why",
    "where",
  ],
  ...["aur", "lekin", "magar", "mera", "meri", "mere", "aapka", "aapki", "aapke", "tumhara", "ek"],
  ...["और", "लेकिन", "मगर", "मेरा", "मेरी", "मेरे", "आपका", "आपकी", "आपके", "एक"],
]);
/** Hindi postpositions belong to the word before them (Roman and Devanagari): a cut never lands in front of one. */
const POSTPOSITIONS = new Set([
  ...["ka", "ki", "ke", "ko", "se", "me", "mein", "par", "pe", "ne", "tak", "bhi", "hi", "saath"],
  ...["liye", "का", "की", "के", "को", "से", "में", "मे", "पर", "पे", "ने", "तक", "भी", "ही"],
  ...["साथ", "लिए"],
]);
/** The postpositions that cannot end a clause either ("me" and "hi" can: "tell me", "main bhi"). */
const POSTPOSITIONS_OPEN = new Set(
  ["ka", "ki", "ke", "ko", "se", "mein", "par", "pe", "ne", "tak", "liye"].concat([
    "का",
    "की",
    "के",
    "को",
    "से",
    "में",
    "पर",
    "पे",
    "ने",
    "तक",
    "लिए",
  ]),
);
const TITLES_BEFORE = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "shri",
  "smt",
  "sri",
  "miss",
  "श्री",
  "डॉ",
]);
const TITLES_AFTER = new Set([
  ...["ji", "jee", "sir", "saab", "sahab", "sahib", "madam", "maam", "bhai", "bhaiya", "didi"],
  ...["जी", "साहब", "भाई", "दीदी", "सर"],
]);
const CURRENCY_BEFORE = new Set(["rs", "inr", "usd", "eur", "₹", "$", "रु", "रुपये"]);
const UNITS_AFTER = new Set([
  ...[
    "am",
    "pm",
    "a.m",
    "p.m",
    "percent",
    "rupees",
    "rupaye",
    "rupay",
    "baje",
    "bje",
    "lakh",
    "crore",
  ],
  ...[
    "thousand",
    "hazaar",
    "hundred",
    "million",
    "billion",
    "dollars",
    "euros",
    "km",
    "kg",
    "mb",
    "gb",
  ],
  ...["बजे", "प्रतिशत", "रुपये", "लाख", "करोड़", "हज़ार", "हजार", "सौ"],
]);
/** A conjunction starts the clause after it: the cut comes before it. */
const CONJ_BEFORE = new Set([
  "and",
  "but",
  "aur",
  "lekin",
  "magar",
  "parantu",
  "और",
  "लेकिन",
  "मगर",
  "परंतु",
]);
/** "toh" closes the clause it belongs to: the cut comes after it. */
const CONJ_AFTER = new Set(["toh", "तो"]);
const NUMERIC = /^[\d०-९][\d०-९.,:]*$/u;

/** The word without marks around it, lower case. A Devanagari vowel sign stays (it is a mark inside the word). */
function norm(token: Token): string {
  return token.text.toLowerCase().replace(/^[^\p{L}\p{M}\p{N}₹$]+|[^\p{L}\p{M}\p{N}]+$/gu, "");
}

/** True when a cut between `prev` and `next` keeps what belongs together together. */
function safeBetween(text: string, prev: Token, next: Token | undefined): boolean {
  if (endsOpen(text, prev)) return false;
  const p = norm(prev);
  if (
    LEADS_ON.has(p) ||
    POSTPOSITIONS_OPEN.has(p) ||
    TITLES_BEFORE.has(p) ||
    CURRENCY_BEFORE.has(p)
  ) {
    return false;
  }
  if (!next) return true;
  const n = norm(next);
  if (POSTPOSITIONS.has(n) || TITLES_AFTER.has(n)) return false;
  if (UNITS_AFTER.has(n) && NUMERIC.test(p)) return false;
  return true;
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

/** A cut after the token at `index`, or before it when `before` is set (then the clause ends at the token before). */
type Candidate = { index: number; before: boolean; words: number };

/** The first clause, and whether the text has gone on too long to ever make a small one. */
function scanFirstClause(text: string, options: ClauseOptions): FirstScan {
  const minWords = options.minWords ?? FIRST_CLAUSE_MIN_WORDS;
  const maxWords = options.maxWords ?? FIRST_CLAUSE_MAX_WORDS;
  const minChars = options.minChars ?? FIRST_CLAUSE_MIN_CHARS;
  // A token touching the end of a growing text may still grow: only whole tokens are read.
  const all = tokenize(text);
  const first = all[0];
  if (!first) return { cut: null, gaveUp: false };
  const tokens = options.final ? all : all.filter((token) => token.end < text.length);
  const decide = (end: number): FirstScan => {
    const clause = text.slice(first.start, end).trim();
    if (!clause) return { cut: null, gaveUp: false };
    let consumed = end;
    while (consumed < text.length && /\s/.test(text[consumed] ?? "")) consumed += 1;
    return { cut: { spoken: clause, consumed }, gaveUp: false };
  };
  const wordAt: number[] = []; // token index of each word, in order
  const conj: Candidate[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) break;
    if (token.word) wordAt.push(i);
    const words = wordAt.length;
    if (!token.clean) continue;
    const kind = breakKind(text, token);
    const cutEnd = kind === "dash" ? token.start : token.end;
    const clause = text.slice(first.start, cutEnd).trim();
    if (
      kind !== null &&
      words >= minWords &&
      words <= maxWords &&
      clause.length >= minChars &&
      clause
    ) {
      return decide(cutEnd);
    }
    if (!token.word) continue;
    const name = norm(token);
    const prev = tokens[i - 1];
    if (CONJ_BEFORE.has(name) && prev?.clean && words - 1 >= minWords && words - 1 <= maxWords) {
      if (
        text.slice(first.start, prev.end).trim().length >= minChars &&
        safeBetween(text, prev, token)
      ) {
        conj.push({ index: i - 1, before: true, words: words - 1 });
      }
    } else if (CONJ_AFTER.has(name) && words >= minWords && words <= maxWords) {
      if (clause.length >= minChars && safeBetween(text, token, tokens[i + 1])) {
        conj.push({ index: i, before: false, words });
      }
    }
  }
  const known = wordAt.length;
  // Not enough text to read the word after the cut yet, or a short final answer that is spoken whole.
  if (known <= maxWords) return { cut: null, gaveUp: false };
  const tokenOf = (word: number): Token | undefined => tokens[wordAt[word - 1] ?? -1];
  const best = conj[conj.length - 1];
  if (best) {
    const token = tokens[best.index];
    if (token) return decide(token.end);
  }
  for (let w = maxWords; w <= maxWords + EXTENSION_WORDS; w += 1) {
    if (w < minWords) continue;
    if (w > known) return { cut: null, gaveUp: false };
    const at = wordAt[w - 1] ?? -1;
    const token = tokens[at];
    if (!token || !token.clean) continue;
    if (w === known && !options.final) return { cut: null, gaveUp: false };
    if (safeBetween(text, token, tokens[at + 1])) return decide(token.end);
    // Past the budget only a longer word run can still help: nothing before `maxWords` is tried again.
    if (w === maxWords) {
      for (let back = maxWords - 1; back >= minWords; back -= 1) {
        const earlier = tokenOf(back);
        const following = tokens[(wordAt[back - 1] ?? -1) + 1];
        if (earlier?.clean && safeBetween(text, earlier, following)) return decide(earlier.end);
      }
    }
  }
  return { cut: null, gaveUp: true };
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
