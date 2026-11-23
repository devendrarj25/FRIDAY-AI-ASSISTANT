/**
 * FRIDAY Tidy: FRIDAY's own transcript cleanup for Hindi, English and Hinglish.
 *
 * Pure text in, text and a change list out: no network, no clock, no model, nothing stored. It runs on this PC only,
 * so SENSITIVE text never goes anywhere because of it. What it does, in this order:
 *   1. spoken punctuation ("comma", "full stop", "purn viram", "question mark", "new line", "naya paragraph") becomes
 *      the symbol, and the next Latin word after a spoken full stop or line break starts with a capital;
 *   2. filler words go: sounds like "um", "uh", "hmm", "अम", "हम्म" always, and the words that are fillers only when
 *      the speaker set them off ("you know,", "like,", "matlab,", "वो,") and only as whole words;
 *   3. a spoken correction ("two, actually three", "nahi nahi teen", "John, I mean Jane", "scratch that") replaces
 *      the phrase it corrects, and corrections can follow corrections;
 *   4. when the owner asks for a list in words ("list", "suchi", "सूची", "लिस्ट") a spoken "one ... two ..." becomes
 *      numbered lines (never without that word);
 *   5. the owner's personal dictionary (whole word, case kept) and snippets, which arrive as data.
 * Script policy: nothing is ever transliterated. Devanagari stays Devanagari, Latin stays Latin, digits stay as the
 * recogniser wrote them (the spoken number words are only read to find list markers and corrections). Quoted text,
 * `code`, links, e-mail addresses and file paths are never touched. Reuses the number words of the speech normalizer
 * and the script policy of the language segmenter; it does not copy them.
 */
import { scriptPolicy, type PolicyLang } from "./language-segmenter";
import { englishNumber, hindiNumber } from "./text-normalizer";

export type TidyKind =
  "punctuation" | "case" | "filler" | "backtrack" | "list" | "dictionary" | "snippet";
/** One edit, for the raw-versus-cleaned view. `to` is empty when words were only removed. */
export type TidyChange = { kind: TidyKind; from: string; to: string };
/** The owner wants what is heard as `heard` written as `write`. */
export type DictionaryEntry = { heard: string; write: string };
/** The owner says `trigger` and FRIDAY writes `text`. */
export type Snippet = { trigger: string; text: string };
export type TidyOptions = {
  /** Turn a step off. Every step is on by default. */
  punctuation?: boolean;
  fillers?: boolean;
  backtrack?: boolean;
  lists?: boolean;
  dictionary?: readonly DictionaryEntry[];
  snippets?: readonly Snippet[];
  /** The recognition language preference ("hi-IN"), only for the language tag of an empty or numeric text. */
  requested?: string;
};
export type TidyResult = {
  raw: string;
  /** Equals `raw` exactly when nothing changed. */
  text: string;
  changed: boolean;
  changes: TidyChange[];
  lang: PolicyLang;
  romanHindi: boolean;
};

/** A final transcript is a sentence or a few; anything longer is left exactly as heard. */
export const TIDY_MAX_CHARS = 8000;

/* ------------------------------------------------------------------ tokens */

type Tok = {
  lead: string;
  core: string;
  trail: string;
  /** Lower-case match key; empty for a held token. */
  key: string;
  /** Quoted, code, a link, or odd: never matched, never dropped, never changed. */
  hold: boolean;
  /** A line break token ("\n" or "\n\n"); empty for a word. */
  brk: "" | "\n" | "\n\n";
};

const PLACEHOLDER = /(\d+)/g;
const LEAD = /^[^\p{L}\p{M}\p{N}]*/u;
const CORE = /^(?:\d+|[\p{L}\p{M}\p{N}‌‍]+(?:['’.-][\p{L}\p{M}\p{N}‌‍]+)*)/u;
const PROTECTED: RegExp[] = [
  /```[\s\S]*?```|`[^`\n]*`/g,
  /"[^"\n]*"|“[^”\n]*”/g,
  /\bhttps?:\/\/\S+|\bwww\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[A-Za-z]:\\\S+/g,
  /\b[A-Za-z_]\w*\([^()\n]*\)|\b[a-z]+(?:_[a-z0-9]+)+\b/g,
];

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN_LOWER_START = /^[a-z]/;
const PAUSE = /[,;:—–…]|\.{2,}/;
const DEVANAGARI_DIGITS = /^[0-9०-९]+$/;

const holdTok = (text: string): Tok => ({
  lead: "",
  core: text,
  trail: "",
  key: "",
  hold: true,
  brk: "",
});

function parseToken(piece: string): Tok {
  const lead = LEAD.exec(piece)?.[0] ?? "";
  const rest = piece.slice(lead.length);
  const core = CORE.exec(rest)?.[0] ?? "";
  const trail = rest.slice(core.length);
  if (!core || /[\p{L}\p{N}]/u.test(trail)) return holdTok(piece);
  const placeholder = /^\d+$/.test(core);
  return {
    lead,
    core,
    trail,
    key: placeholder ? "" : core.toLowerCase().normalize("NFC"),
    hold: placeholder,
    brk: "",
  };
}

function tokenize(masked: string): Tok[] {
  const out: Tok[] = [];
  for (const piece of masked.split(/(\s+)/)) {
    if (!piece) continue;
    if (/^\s+$/.test(piece)) {
      const lines = (piece.match(/\n/g) ?? []).length;
      if (lines) out.push({ ...holdTok(""), hold: false, brk: lines > 1 ? "\n\n" : "\n" });
      continue;
    }
    out.push(parseToken(piece));
  }
  return out;
}

const text = (t: Tok): string => t.brk || `${t.lead}${t.core}${t.trail}`;

function render(toks: readonly Tok[]): string {
  let line = "";
  let space = false;
  for (const t of toks) {
    if (t.brk) {
      line += t.brk;
      space = false;
    } else {
      line += (space ? " " : "") + text(t);
      space = true;
    }
  }
  return line;
}

const terminal = (trail: string): boolean => /[.!?।॥]/.test(trail.replace(/\.{2,}|…/g, ""));
const pause = (trail: string): boolean => PAUSE.test(trail);
const isWord = (t: Tok | undefined): t is Tok => Boolean(t) && !t!.brk;

/** Protect quoted text, code, links, e-mail addresses and paths before any word is looked at. */
function mask(input: string, held: string[]): string {
  let line = input;
  for (const rule of PROTECTED) {
    line = line.replace(rule, (span) => `${held.push(span) - 1}`);
  }
  return line;
}

const unmask = (line: string, held: readonly string[]): string =>
  line.replace(PLACEHOLDER, (_m, i) => held[Number(i)] ?? "");

/** Capital first letter, only for a Latin lower-case start. */
function capitalised(core: string): string {
  return LATIN_LOWER_START.test(core) ? core.charAt(0).toUpperCase() + core.slice(1) : core;
}

/* ------------------------------------------------------------ number words */

const NUMBER_WORDS = new Map<string, number>();
const AMBIGUOUS_NUMBER_WORDS = new Set(["do"]);
for (let n = 1; n <= 20; n += 1) {
  NUMBER_WORDS.set(englishNumber(n), n);
  NUMBER_WORDS.set(hindiNumber(n), n);
}
for (const [word, n] of Object.entries({
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  chhah: 6,
  che: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
})) {
  NUMBER_WORDS.set(word, n);
}

function numberValue(t: Tok | undefined): number | null {
  if (!isWord(t) || t.hold || !t.key) return null;
  const word = NUMBER_WORDS.get(t.key);
  if (word !== undefined) return word;
  if (DEVANAGARI_DIGITS.test(t.key)) {
    const digits = [...t.key]
      .map((c) => (c >= "०" && c <= "९" ? c.charCodeAt(0) - 0x966 : c))
      .join("");
    return Number(digits);
  }
  return null;
}

/* -------------------------------------------------------- spoken punctuation */

type Symbol = "," | "?" | "!" | ":" | ";" | "STOP" | "\n" | "\n\n";
const SPOKEN: Array<{ words: string[]; out: Symbol }> = (
  [
    ["comma", ","],
    ["koma", ","],
    ["कॉमा", ","],
    ["कोमा", ","],
    ["अल्पविराम", ","],
    ["full stop", "STOP"],
    ["purn viram", "STOP"],
    ["poorn viram", "STOP"],
    ["purnviram", "STOP"],
    ["पूर्ण विराम", "STOP"],
    ["पूर्णविराम", "STOP"],
    ["question mark", "?"],
    ["prashn chinh", "?"],
    ["prashnchinh", "?"],
    ["प्रश्न चिह्न", "?"],
    ["प्रश्नचिह्न", "?"],
    ["प्रश्न चिन्ह", "?"],
    ["exclamation mark", "!"],
    ["exclamation point", "!"],
    ["विस्मयादिबोधक चिह्न", "!"],
    ["new line", "\n"],
    ["newline", "\n"],
    ["naya line", "\n"],
    ["nayi line", "\n"],
    ["nai line", "\n"],
    ["नई लाइन", "\n"],
    ["नयी लाइन", "\n"],
    ["नया लाइन", "\n"],
    ["नई पंक्ति", "\n"],
    ["new paragraph", "\n\n"],
    ["naya paragraph", "\n\n"],
    ["nayi paragraph", "\n\n"],
    ["नया पैराग्राफ", "\n\n"],
    ["नया अनुच्छेद", "\n\n"],
    ["नई पैराग्राफ", "\n\n"],
  ] as Array<[string, Symbol]>
)
  .map(([phrase, out]) => ({ words: phrase.split(" "), out }))
  .sort((a, b) => b.words.length - a.words.length);

/** The word before a spoken symbol that says the symbol is being talked about, not dictated. */
const MENTION_GUARD = new Set([
  "the",
  "a",
  "an",
  "word",
  "words",
  "say",
  "says",
  "said",
  "called",
  "type",
  "this",
  "that",
  "your",
  "my",
]);

function matchPhrase(src: readonly Tok[], at: number, words: readonly string[]): boolean {
  return words.every((w, k) => {
    const t = src[at + k];
    return isWord(t) && !t.hold && t.key === w;
  });
}

function spokenPunctuation(src: Tok[], log: TidyChange[]): Tok[] {
  const out: Tok[] = [];
  let cap = false;
  for (let i = 0; i < src.length;) {
    const prev = out[out.length - 1];
    const hit = SPOKEN.find((p) => matchPhrase(src, i, p.words));
    if (hit && isWord(prev) && !(prev.key && MENTION_GUARD.has(prev.key))) {
      const phrase = render(src.slice(i, i + hit.words.length));
      if (hit.out === "\n" || hit.out === "\n\n") {
        out.push({ ...holdTok(""), hold: false, brk: hit.out });
        log.push({ kind: "punctuation", from: phrase, to: hit.out === "\n" ? "↵" : "↵↵" });
        cap = true;
      } else {
        const symbol = hit.out === "STOP" ? (DEVANAGARI.test(prev.core) ? "।" : ".") : hit.out;
        const stops = symbol === "." || symbol === "।" || symbol === "?" || symbol === "!";
        if (stops) prev.trail = prev.trail.replace(/[,;:]+$/, "");
        if (!(stops && terminal(prev.trail)) && !prev.trail.endsWith(symbol)) prev.trail += symbol;
        log.push({ kind: "punctuation", from: phrase, to: symbol });
        cap = stops;
      }
      i += hit.words.length;
      continue;
    }
    const tok = src[i] as Tok;
    if (cap && isWord(tok) && !tok.hold && LATIN_LOWER_START.test(tok.core)) {
      const to = capitalised(tok.core);
      log.push({ kind: "case", from: tok.core, to });
      tok.core = to;
    }
    if (!tok.brk) cap = false;
    out.push(tok);
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ fillers */

const SOUND_FILLERS = new Set([
  "um",
  "umm",
  "uh",
  "uhh",
  "uhm",
  "er",
  "erm",
  "hmm",
  "hmmm",
  "mmm",
  "अम",
  "अम्म",
  "उम",
  "उम्म",
  "हम्म",
  "हम्मम",
]);
/** Words that are real words too: dropped only when the speaker set them off on both sides. */
const SET_OFF_FILLERS: string[][] = [
  ["you", "know"],
  ["like"],
  ["matlab"],
  ["woh"],
  ["wo"],
  ["मतलब"],
  ["वो"],
];

function fillers(src: Tok[], log: TidyChange[]): Tok[] {
  const out: Tok[] = [];
  let cap = false;
  const setOffBefore = (): boolean => {
    const prev = out[out.length - 1];
    return !prev || Boolean(prev.brk) || pause(prev.trail) || terminal(prev.trail);
  };
  for (let i = 0; i < src.length;) {
    const tok = src[i] as Tok;
    let len = 0;
    if (isWord(tok) && !tok.hold && /^[-—–…]*$/.test(tok.lead)) {
      if (SOUND_FILLERS.has(tok.key)) len = 1;
      else {
        const phrase = SET_OFF_FILLERS.find((p) => matchPhrase(src, i, p));
        const last = phrase ? src[i + phrase.length - 1] : undefined;
        if (phrase && last && setOffBefore() && (pause(last.trail) || terminal(last.trail)))
          len = phrase.length;
      }
    }
    if (len) {
      const gone = src.slice(i, i + len);
      const tail = (gone[gone.length - 1] as Tok).trail;
      const prev = out[out.length - 1];
      const atStart = !prev || Boolean(prev.brk) || terminal(prev.trail);
      if (isWord(prev) && terminal(tail) && !terminal(prev.trail)) {
        prev.trail = prev.trail.replace(/[,;:]+$/, "") + (tail.match(/[.!?।॥]+/)?.[0] ?? "");
      }
      if (atStart && /^\p{Lu}/u.test(tok.core)) cap = true;
      log.push({ kind: "filler", from: render(gone), to: "" });
      i += len;
      continue;
    }
    if (cap && isWord(tok) && !tok.hold && LATIN_LOWER_START.test(tok.core)) {
      const to = capitalised(tok.core);
      log.push({ kind: "case", from: tok.core, to });
      tok.core = to;
    }
    if (!tok.brk) cap = false;
    out.push(tok);
    i += 1;
  }
  return out;
}

/* ---------------------------------------------------------------- backtrack */

type Marker = { len: number };
const STRONG_MARKERS: string[][] = [
  ["scratch", "that"],
  ["no", "wait"],
  ["wait", "no"],
  ["sorry", "i", "mean"],
];
const PAUSED_MARKERS: string[][] = [
  ["actually"],
  ["i", "mean"],
  ["rather"],
  ["mera", "matlab"],
  ["मेरा", "मतलब"],
  ["nahi", "matlab"],
  ["nahin", "matlab"],
  ["नहीं", "मतलब"],
  ["दरअसल"],
];
const DOUBLE_NO = new Set(["no", "nahi", "nahin", "nahee", "नहीं", "नही"]);

/** Is a correction word group starting at `at`? `before` is the word just ahead of it (after earlier edits). */
function markerAt(src: readonly Tok[], at: number, before: Tok | undefined): Marker | null {
  const tok = src[at];
  if (!isWord(tok) || tok.hold || !/^[-—–…]*$/.test(tok.lead)) return null;
  const setOff = !before || pause(before.trail);
  const strong = STRONG_MARKERS.find((m) => matchPhrase(src, at, m));
  if (strong) return { len: strong.length };
  const second = src[at + 1];
  if (
    DOUBLE_NO.has(tok.key) &&
    isWord(second) &&
    !second.hold &&
    second.key === tok.key &&
    !second.trail
  )
    return { len: 2 };
  const soft = PAUSED_MARKERS.find((m) => matchPhrase(src, at, m));
  if (!soft) return null;
  const after = src[at + soft.length];
  const numbers = numberValue(before) !== null && numberValue(after) !== null;
  return setOff || numbers ? { len: soft.length } : null;
}

/** How many already-written words a correction replaces. 0 means the correction has nothing to replace. */
function replacedCount(out: readonly Tok[], fix: readonly Tok[]): number {
  let start = out.length;
  while (start > 0) {
    const t = out[start - 1] as Tok;
    if (t.brk || (start < out.length && terminal(t.trail))) break;
    start -= 1;
  }
  const clause = out.slice(start);
  if (!clause.length || clause.some((t) => t.hold)) return 0;
  const first = fix[0];
  if (first && !first.hold) {
    // The speaker said the phrase over again: "I'll come at two actually I'll come at three".
    for (let back = Math.min(clause.length, 8); back >= 2; back -= 1) {
      if ((clause[clause.length - back] as Tok).key === first.key) return back;
    }
  }
  let unit = 1;
  const last = clause[clause.length - 1] as Tok;
  if (numberValue(last) !== null) {
    while (
      unit < 3 &&
      unit < clause.length &&
      numberValue(clause[clause.length - 1 - unit]) !== null
    )
      unit += 1;
  } else if (first && /^\p{Lu}/u.test(last.core) && /^\p{Lu}/u.test(first.core)) {
    while (
      unit < 3 &&
      unit < clause.length - 1 &&
      /^\p{Lu}/u.test((clause[clause.length - 1 - unit] as Tok).core)
    )
      unit += 1;
  }
  return unit;
}

function backtrack(src: Tok[], log: TidyChange[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < src.length;) {
    const marker = markerAt(src, i, out[out.length - 1]);
    if (marker) {
      const start = i + marker.len;
      let end = start;
      for (; end < src.length; end += 1) {
        const t = src[end] as Tok;
        if (t.brk || (end > start && markerAt(src, end, src[end - 1]))) break;
        if (terminal(t.trail) || pause(t.trail)) {
          end += 1;
          break;
        }
      }
      const fix = src.slice(start, end);
      const count = fix.length ? replacedCount(out, fix) : 0;
      if (count) {
        const gone = out.splice(out.length - count, count);
        const first = fix[0] as Tok;
        if (/^\p{Lu}/u.test((gone[0] as Tok).core) && !first.hold && !first.brk)
          first.core = capitalised(first.core);
        log.push({
          kind: "backtrack",
          from: render([...gone, ...src.slice(i, start), ...fix]),
          to: render(fix),
        });
        out.push(...fix);
        i = end;
        continue;
      }
    }
    out.push(src[i] as Tok);
    i += 1;
  }
  return out;
}

/* -------------------------------------------------------------------- lists */

const LIST_WORDS = new Set(["list", "suchi", "soochi", "सूची", "लिस्ट"]);

function markerNumber(t: Tok | undefined, loose: boolean): number | null {
  const n = numberValue(t);
  if (n === null || !t || (loose && AMBIGUOUS_NUMBER_WORDS.has(t.key))) return null;
  return n;
}

/** Marker positions 1, 2, 3 ... after the list word at `at`; strict needs a pause or line break before each. */
function listMarkers(src: readonly Tok[], at: number, strict: boolean): number[] {
  const found: number[] = [];
  if (markerNumber(src[at + 1], false) !== 1) return found;
  found.push(at + 1);
  for (let j = at + 2; j < src.length; j += 1) {
    const t = src[j] as Tok;
    if (terminal((src[j - 1] as Tok).trail) || t.brk) {
      if (!t.brk) break;
      continue;
    }
    if (markerNumber(t, !strict) !== found.length + 1) continue;
    const before = src[j - 1] as Tok;
    if (strict && !(before.brk || pause(before.trail))) continue;
    if (j - (found[found.length - 1] as number) < 2) continue;
    found.push(j);
  }
  return found;
}

function lists(src: Tok[], log: TidyChange[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const tok = src[i] as Tok;
    if (!isWord(tok) || tok.hold || !LIST_WORDS.has(tok.key)) {
      out.push(tok);
      continue;
    }
    let marks = listMarkers(src, i, true);
    if (marks.length < 2) marks = listMarkers(src, i, false);
    if (marks.length < 2) {
      out.push(tok);
      continue;
    }
    let end = src.length;
    for (let j = (marks[marks.length - 1] as number) + 1; j < src.length; j += 1) {
      const t = src[j] as Tok;
      if (t.brk) {
        end = j;
        break;
      }
      if (terminal(t.trail)) {
        end = j + 1;
        break;
      }
    }
    const items = marks.map((mark, k) => {
      const stop = k + 1 < marks.length ? (marks[k + 1] as number) : end;
      return src.slice(mark + 1, stop);
    });
    if (items.some((item) => !item.length || item.some((t) => t.brk))) {
      out.push(tok);
      continue;
    }
    const head: Tok = { ...tok, trail: ":" };
    const made: Tok[] = [head];
    items.forEach((item, k) => {
      const words = item.map((t) => ({ ...t }));
      const tail = words[words.length - 1] as Tok;
      tail.trail = tail.trail.replace(/[,;.।]+$/, "");
      made.push({ ...holdTok(""), hold: false, brk: "\n" });
      made.push({ ...holdTok(`${k + 1}`), hold: false, trail: ".", key: "" }, ...words);
    });
    log.push({ kind: "list", from: render(src.slice(i, end)), to: render(made) });
    out.push(...made);
    i = end - 1;
  }
  return out;
}

/* ------------------------------------------------- dictionary and snippets */

/** Keep the heard casing for a lower-case written form: "FRIDAY" stays upper, "Friday" stays capitalised. */
function mirrorCase(source: string, write: string): string {
  if (write !== write.toLowerCase()) return write;
  if (source.length > 1 && source === source.toUpperCase() && source !== source.toLowerCase())
    return write.toUpperCase();
  if (/^\p{Lu}/u.test(source)) return write.charAt(0).toUpperCase() + write.slice(1);
  return write;
}

function replaceWords(
  src: Tok[],
  pairs: ReadonlyArray<{ words: string[]; write: string }>,
  kind: "dictionary" | "snippet",
  log: TidyChange[],
): Tok[] {
  if (!pairs.length) return src;
  const sorted = [...pairs].sort((a, b) => b.words.length - a.words.length);
  const out: Tok[] = [];
  for (let i = 0; i < src.length;) {
    const hit = sorted.find(
      (p) =>
        matchPhrase(src, i, p.words) &&
        src.slice(i, i + p.words.length - 1).every((t) => !pause(t.trail) && !terminal(t.trail)),
    );
    if (!hit) {
      out.push(src[i] as Tok);
      i += 1;
      continue;
    }
    const span = src.slice(i, i + hit.words.length);
    const first = span[0] as Tok;
    const last = span[span.length - 1] as Tok;
    const write = kind === "dictionary" ? mirrorCase(first.core, hit.write) : hit.write;
    const same = span.length === 1 && first.core === write;
    if (same) out.push(first);
    else {
      log.push({ kind, from: render(span), to: `${first.lead}${write}${last.trail}` });
      out.push({
        lead: first.lead,
        core: write,
        trail: last.trail,
        key: "",
        hold: kind === "snippet",
        brk: "",
      });
    }
    i += hit.words.length;
  }
  return out;
}

const wordsOf = (phrase: string): string[] =>
  phrase
    .toLowerCase()
    .normalize("NFC")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, ""))
    .filter(Boolean);

/* --------------------------------------------------------------------- main */

/**
 * Clean one finished transcript. Returns the text exactly as heard when nothing applies, so a clean sentence is
 * never reflowed. The diff list names every edit in the order it was made.
 */
export function tidyTranscript(input: string, options: TidyOptions = {}): TidyResult {
  const raw = typeof input === "string" ? input : "";
  const result = (cleaned: string, changes: TidyChange[]): TidyResult => {
    const policy = scriptPolicy(cleaned, options.requested ?? "");
    return {
      raw,
      text: cleaned,
      changed: changes.length > 0,
      changes,
      lang: policy.lang,
      romanHindi: policy.romanHindi,
    };
  };
  if (!raw.trim() || raw.length > TIDY_MAX_CHARS) return result(raw, []);

  const held: string[] = [];
  const log: TidyChange[] = [];
  let toks = tokenize(mask(raw.replace(/[]/g, ""), held));
  if (options.punctuation !== false) toks = spokenPunctuation(toks, log);
  if (options.fillers !== false) toks = fillers(toks, log);
  if (options.backtrack !== false) toks = backtrack(toks, log);
  if (options.lists !== false) toks = lists(toks, log);
  const entries = (options.dictionary ?? [])
    .map((e) => ({ words: wordsOf(e?.heard ?? ""), write: String(e?.write ?? "").trim() }))
    .filter((e) => e.words.length && e.write);
  toks = replaceWords(toks, entries, "dictionary", log);
  const snippets = (options.snippets ?? [])
    .map((s) => ({ words: wordsOf(s?.trigger ?? ""), write: String(s?.text ?? "") }))
    .filter((s) => s.words.length && s.write.trim());
  toks = replaceWords(toks, snippets, "snippet", log);

  if (!log.length) return result(raw, []);
  const show = (c: TidyChange): TidyChange => ({
    kind: c.kind,
    from: unmask(c.from, held),
    to: unmask(c.to, held),
  });
  return result(unmask(render(toks), held), log.map(show));
}

/* ------------------------------------------------------ learn a correction */

export type DictionaryProposal =
  | { ok: true; entry: DictionaryEntry }
  | { ok: false; reason: "same" | "empty" | "too-big" | "script-change" | "known" };

const coresOf = (line: string): string[] =>
  tokenize(line)
    .filter((t) => !t.brk && t.core && !t.hold)
    .map((t) => t.core);

/**
 * The owner fixed a heard line: propose one dictionary entry from the single changed run of words. It only proposes.
 * Nothing is saved here, and a change that would swap script (Latin for Devanagari or the reverse) is refused,
 * because FRIDAY never transliterates.
 */
export function proposeDictionaryEntry(
  heard: string,
  corrected: string,
  existing: readonly DictionaryEntry[] = [],
): DictionaryProposal {
  const a = coresOf(String(heard ?? ""));
  const b = coresOf(String(corrected ?? ""));
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const was = a.slice(head, a.length - tail);
  const now = b.slice(head, b.length - tail);
  if (!was.length && !now.length) return { ok: false, reason: "same" };
  if (!was.length || !now.length) return { ok: false, reason: "empty" };
  if (was.length > 3 || now.length > 3 || was.join(" ").length > 40 || now.join(" ").length > 40)
    return { ok: false, reason: "too-big" };
  if (DEVANAGARI.test(was.join("")) !== DEVANAGARI.test(now.join("")))
    return { ok: false, reason: "script-change" };
  const entry = { heard: was.join(" "), write: now.join(" ") };
  const known = existing.some((e) => wordsOf(e.heard).join(" ") === wordsOf(entry.heard).join(" "));
  return known ? { ok: false, reason: "known" } : { ok: true, entry };
}
