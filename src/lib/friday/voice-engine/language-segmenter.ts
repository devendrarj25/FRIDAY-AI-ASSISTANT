/**
 * FRIDAY · language and script spans for speech (renderer mirror of `kernel/language_segmenter.py`).
 *
 * Mixed Hindi and English is never "unsupported". A sentence is cut by script into a few phrase-sized spans, each
 * tagged with the voice language that reads it (`hi` for Devanagari, `en` for Latin), in written order. A run
 * shorter than MIN_SPAN_WORDS folds into its neighbour so a lone English noun inside a Hindi clause is not a
 * request of its own, and the span count is bounded. `chunkForSpeech` then groups sentences into speakable
 * chunks: never one chunk per word, the first chunk may end at a clause break so audio starts early.
 */

import { labelLanguages, lexiconKey } from "./hinglish-lexicon";

export type SpeechLang = "hi" | "en";
export type Script = "devanagari" | "latin" | "neutral";
export type Span = { text: string; lang: SpeechLang; script: Script };

export const MIN_SPAN_WORDS = 2;
export const MAX_SPANS = 8;

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z]/;
const WORD = /[\wऀ-ॿ]+/g;

/** Common Hindi written in Latin letters. A hint only: script cannot tell Roman Hindi from English. */
const ROMAN_HINDI = new Set(
  (
    "aap ab abhi acha accha aur bahut baat bhi chahiye dena do haan hai hain ho hoga hum ka kaam kab kaise kaun " +
    "kar karo kare karna kya ke ki ko kuch kyun mai main mera meri mere mujhe nahi nahin naam par pehle phir " +
    "raha rahi ruko ruk se suno tum tumhe tumhara ye yeh wo woh yahan wahan zara jao jaao batao bata bana banao " +
    "bhej bhejo dekho khol kholo band dikhao lo"
  ).split(" "),
);

function scriptOf(ch: string): Script {
  if (DEVANAGARI.test(ch)) return "devanagari";
  if (LATIN.test(ch)) return "latin";
  return "neutral";
}

const langOf = (script: Script): SpeechLang => (script === "devanagari" ? "hi" : "en");
const wordCount = (text: string): number => (text.match(WORD) ?? []).length;

/** Share (0..1) of the Latin words that are common Hindi vocabulary. */
export function romanHindiRatio(text: string): number {
  const words = (text.match(/[A-Za-z]+/g) ?? []).map((w) => w.toLowerCase());
  if (!words.length) return 0;
  return words.filter((w) => ROMAN_HINDI.has(w)).length / words.length;
}

/** One language for the whole text: the script with more letters wins. */
export function dominantLang(text: string, requested = ""): SpeechLang {
  let deva = 0;
  let latin = 0;
  for (const ch of text) {
    if (DEVANAGARI.test(ch)) deva += 1;
    else if (LATIN.test(ch)) latin += 1;
  }
  if (deva || latin) return deva >= latin ? "hi" : "en";
  return requested.toLowerCase().replace("_", "-").startsWith("hi") ? "hi" : "en";
}

function rawRuns(text: string): { text: string; script: Script }[] {
  const runs: { text: string; script: Script }[] = [];
  for (const ch of text) {
    const script = scriptOf(ch);
    const last = runs[runs.length - 1];
    if (!last) {
      runs.push({ text: ch, script });
    } else if (script === "neutral" || script === last.script || last.script === "neutral") {
      last.text += ch;
      if (last.script === "neutral" && script !== "neutral") last.script = script;
    } else {
      runs.push({ text: ch, script });
    }
  }
  return runs;
}

export function segment(text: string, requested = ""): Span[] {
  const cleaned = (text ?? "").trim();
  if (!cleaned) return [];
  const spans: Span[] = rawRuns(cleaned).map((r) => ({
    text: r.text,
    lang: langOf(r.script),
    script: r.script,
  }));
  if (spans.every((s) => s.script === "neutral")) {
    return [{ text: cleaned, lang: dominantLang(cleaned, requested), script: "neutral" }];
  }
  const merged: Span[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && (wordCount(span.text) < MIN_SPAN_WORDS || prev.lang === span.lang)) {
      merged[merged.length - 1] = { ...prev, text: prev.text + span.text };
    } else merged.push(span);
  }
  const first = merged[0];
  const second = merged[1];
  if (first && second && wordCount(first.text) < MIN_SPAN_WORDS) {
    merged.splice(0, 2, { ...second, text: first.text + second.text });
  }
  const joined: Span[] = [];
  for (const span of merged) {
    const prev = joined[joined.length - 1];
    if (prev && prev.lang === span.lang)
      joined[joined.length - 1] = { ...prev, text: prev.text + span.text };
    else joined.push(span);
  }
  if (joined.length > MAX_SPANS) {
    const last = joined[MAX_SPANS - 1] as Span;
    const tail = joined
      .slice(MAX_SPANS - 1)
      .map((s) => s.text)
      .join("");
    joined.splice(MAX_SPANS - 1, joined.length, { ...last, text: tail });
  }
  return joined.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

export type SpeechChunk = { text: string; lang: SpeechLang; spans: Span[] };

export type ChunkOptions = {
  /** Upper bound for one chunk, in characters. */
  maxChars?: number;
  /** The first chunk may end at a clause break once this long, so audio starts early. */
  firstMinChars?: number;
  requested?: string;
};

const SENTENCE_END = /(?<=[.!?।॥\n])\s+/u;

/** Words that end in a dot without ending the sentence. A cut after one would be spoken as "Please ask Dr." */
const ABBREVIATIONS = new Set(
  "dr mr mrs ms prof sr jr st vs etc approx no fig eg ie am pm inc ltd co rs govt dept डॉ प्रो".split(
    " ",
  ),
);

/** Only the end of a text decides whether its last dot is open, so a check never reads more than this. */
const TAIL_WINDOW = 64;

/**
 * Is the last dot of `tail` (the end of a text, trailing space already cut, at most TAIL_WINDOW characters) open?
 * `whole` says the tail is the entire text, so a start-of-text anchor means the start of the text.
 */
function openDotTail(tail: string, whole: boolean): boolean {
  if (!tail.endsWith(".")) return false;
  const before = tail.slice(0, -1);
  const word = /([\u0900-\u097FA-Za-z.]+)$/.exec(before)?.[1] ?? "";
  // A word that fills a cut window may be the end of something longer: not an abbreviation.
  if (word && (whole || word.length < before.length)) {
    if (ABBREVIATIONS.has(word.replace(/\./g, "").toLowerCase())) return true;
    if (/^[A-Za-z](?:\.[A-Za-z])+$/.test(word)) return true; // U.S., a.m., e.g.
  }
  if (/(?:^|[\s(])[A-Z]$/.test(before) && !/(?:^|[\s(])I$/.test(before)) return true;
  if (/\n\s*[0-9]{1,2}$/.test(before)) return true;
  return whole && /^\s*[0-9]{1,2}$/.test(before);
}

/**
 * Does this text end with a dot that is not the end of a sentence: an abbreviation (Dr., Rs., p.m., e.g.), an initial
 * (the "J." of "J. K. Rowling") or a bare list number ("3.")? Used wherever a reply is cut into sentences, so a
 * cut never lands inside a name, a time or a numbered list. Reads only the last few characters: O(1) per call.
 */
export function endsInOpenDot(text: string): boolean {
  const t = (text ?? "").trimEnd();
  return openDotTail(t.slice(-TAIL_WINDOW), t.length <= TAIL_WINDOW);
}

/** Cut text into sentences, putting a piece that ends in an open dot back with the one after it. One pass. */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let carry = "";
  let tail = "";
  let length = 0;
  for (const raw of text.split(SENTENCE_END)) {
    const joined = carry ? `${tail} ${raw}` : raw;
    const cut = joined.trimEnd();
    tail = cut.slice(-TAIL_WINDOW);
    length = (carry ? length + 1 : 0) + raw.length;
    const piece = carry ? `${carry} ${raw}` : raw;
    const trimmedLength = length - (joined.length - cut.length);
    if (openDotTail(tail, trimmedLength <= TAIL_WINDOW) && !raw.endsWith("\n")) {
      carry = piece;
      continue;
    }
    carry = "";
    out.push(piece);
  }
  if (carry) out.push(carry);
  return out;
}

/**
 * The one splitter for text that is about to be spoken: trimmed sentences in written order. A dot between digits
 * (2,500.50, 32.5, v1.2.5.8, ₹3.5), an abbreviation (Dr.) and an initial never end a sentence, because a cut needs
 * white space after the mark. Used by the spoken-line trimmers, so no caller re-implements it and re-joins halves.
 */
export function splitSpokenSentences(text: string): string[] {
  return splitSentences(text ?? "")
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const CLAUSE_BREAK = /(?<=[,;:—–])\s+/u;

/**
 * Split a reply into speakable chunks in written order. A sentence stays whole when it fits; a longer one breaks
 * at clause marks, then at a space. A chunk carries the language that reads most of it and its script spans.
 */
export function chunkForSpeech(text: string, options: ChunkOptions = {}): SpeechChunk[] {
  const maxChars = Math.max(40, options.maxChars ?? 220);
  const firstMin = Math.max(20, options.firstMinChars ?? 40);
  const pieces: string[] = [];
  for (const sentence of splitSentences(text ?? "")) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxChars) {
      pieces.push(trimmed);
      continue;
    }
    let buffer = "";
    for (const clause of trimmed.split(CLAUSE_BREAK)) {
      if (buffer && buffer.length + clause.length + 1 > maxChars) {
        pieces.push(buffer);
        buffer = "";
      }
      if (clause.length > maxChars) {
        if (buffer) pieces.push(buffer);
        buffer = "";
        let rest = clause;
        while (rest.length > maxChars) {
          const space = rest.lastIndexOf(" ", maxChars);
          const cut = space > maxChars / 2 ? space : maxChars;
          pieces.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if (rest) buffer = rest;
        continue;
      }
      buffer = buffer ? `${buffer} ${clause}` : clause;
    }
    if (buffer) pieces.push(buffer);
  }
  const chunks: SpeechChunk[] = [];
  const first = pieces[0];
  if (first && first.length > firstMin * 2) {
    // Start audio early: end the first chunk at the first clause break that makes it a phrase.
    const clauses = first.split(CLAUSE_BREAK);
    let head = "";
    let used = 0;
    while (used < clauses.length - 1 && head.length < firstMin) {
      head = head ? `${head} ${clauses[used]}` : (clauses[used] ?? "");
      used += 1;
    }
    if (used < clauses.length && head.length >= firstMin) {
      pieces.splice(0, 1, head, clauses.slice(used).join(" "));
    }
  }
  for (const piece of pieces) {
    const spans = segment(piece, options.requested ?? "");
    if (!spans.length) continue;
    chunks.push({ text: piece, lang: dominantLang(piece, options.requested ?? ""), spans });
  }
  return chunks;
}

/** The most one local speech call reads (the Supertonic runtime cuts at 500 characters). */
export const SPEECH_CALL_MAX_CHARS = 400;

/**
 * A reply that fits one speech call stays one piece (so short answers sound exactly as before). A longer one is
 * cut into chunks in written order, so the end of a long answer is spoken instead of being cut off.
 */
export function splitLongSpeech(text: string, maxChars = SPEECH_CALL_MAX_CHARS): string[] {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= maxChars) return trimmed ? [trimmed] : [];
  return chunkForSpeech(trimmed, { maxChars, firstMinChars: maxChars }).map((c) => c.text);
}

/* ---- Transcript script policy (mirror of `script_policy` in kernel/language_segmenter.py) ---- */

export type PolicyLang = "hi" | "en" | "mixed";
export type PolicyScript = "devanagari" | "latin" | "roman-hindi" | "mixed" | "neutral";
export type WordKind = "hi" | "en" | "roman-hindi" | "number";
export type PolicyWord = { text: string; kind: WordKind };
export type PolicySegment = {
  text: string;
  lang: PolicyLang;
  script: PolicyScript;
  words: PolicyWord[];
};
export type ScriptPolicy = {
  text: string;
  lang: PolicyLang;
  romanHindi: boolean;
  segments: PolicySegment[];
};

/** A Devanagari word, a Latin word (apostrophes inside stay), or a number. The danda is punctuation, not a letter. */
const POLICY_WORD = /[ऀ-ॣॱ-ॿ]+|[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9०-९]+(?:[.,][0-9०-९]+)*/g;

/** A Latin segment reads as Roman Hindi when at least two of its words are common Hindi and they are half or more. */
function isRomanHindi(latin: string[]): boolean {
  const hits = latin.filter((w) => ROMAN_HINDI.has(w.toLowerCase().replace(/['’].*$/, ""))).length;
  return hits >= 2 && hits * 2 >= latin.length;
}

/**
 * Script policy for a transcript: Hindi stays in Devanagari, English words and names stay in Latin, and the text is
 * returned exactly as spoken. Each segment (a sentence) is tagged hi, en or mixed. Hindi written in Latin letters is
 * never turned into Devanagari without a model: it is reported as `roman-hindi` so speech or recognition can decide.
 */
export function scriptPolicy(text: string, requested = ""): ScriptPolicy {
  const cleaned = (text ?? "").trim();
  const fallback: PolicyLang = requested.toLowerCase().replace("_", "-").startsWith("hi")
    ? "hi"
    : "en";
  const segments: PolicySegment[] = [];
  // A line is a break, and so is a sentence end that is not an abbreviation, an initial or a time (Dr. Sharma).
  for (const piece of cleaned ? cleaned.split("\n").flatMap(splitSentences) : []) {
    const seg = piece.trim();
    if (!seg) continue;
    const found = seg.match(POLICY_WORD) ?? [];
    const latin = found.filter((w) => LATIN.test(w));
    const roman = latin.length > 0 && isRomanHindi(latin);
    const words: PolicyWord[] = found.map((w) => {
      if (DEVANAGARI.test(w) && !/[०-९]/.test(w)) return { text: w, kind: "hi" };
      if (LATIN.test(w)) {
        const hindi = roman && ROMAN_HINDI.has(w.toLowerCase().replace(/['’].*$/, ""));
        return { text: w, kind: hindi ? "roman-hindi" : "en" };
      }
      return { text: w, kind: "number" };
    });
    const hasHi = words.some((w) => w.kind === "hi");
    const hasEn = words.some((w) => w.kind === "en" || w.kind === "roman-hindi");
    const lang: PolicyLang = hasHi && hasEn ? "mixed" : hasHi ? "hi" : hasEn ? "en" : fallback;
    const script: PolicyScript =
      hasHi && hasEn
        ? "mixed"
        : hasHi
          ? "devanagari"
          : roman
            ? "roman-hindi"
            : hasEn
              ? "latin"
              : "neutral";
    segments.push({ text: seg, lang, script, words });
  }
  const langs = new Set(segments.map((s) => s.lang));
  const lang: PolicyLang =
    langs.size > 1 || langs.has("mixed") ? "mixed" : (segments[0]?.lang ?? fallback);
  return {
    text: cleaned,
    lang,
    romanHindi: segments.some(
      (s) => s.script === "roman-hindi" || s.words.some((w) => w.kind === "roman-hindi"),
    ),
    segments,
  };
}

// ---- Codemix spans -----------------------------------------------------------------------------------------------
// One finer cut than `segment` above: script first, then the Hinglish lexicon for Roman words, and numbers and
// punctuation as spans of their own, so the speech front end can treat each run (Devanagari path, English path,
// Roman Hindi, number expansion) on its own. The spans rejoin to the input minus zero-width characters.

export type CodemixScript = "deva" | "latn" | "digits" | "punct";
export type CodemixLang = "hi" | "en" | "num" | "other";
export type CodemixSpan = {
  text: string;
  script: CodemixScript;
  lang: CodemixLang;
  /** Hindi written in Latin letters: a Roman word the lexicon (or the grammar list below) knows as Hindi. */
  romanisedHindi: boolean;
};

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const TOKEN = /(\p{Nd}+(?:[.,:]\p{Nd}+)*)|([\p{L}\p{M}]+(?:['\u2019][\p{L}\p{M}]+)*)|(\s+)|(.)/gsu;
const IN_DEVANAGARI = /[\u0900-\u097F]/;
const IN_LATIN = /\p{Script=Latin}/u;
const IS_MARK = /\p{M}/u;

/**
 * Roman Hindi grammar words the Hinglish lexicon does not list (it holds the unambiguous vocabulary). They are Hindi
 * only; a word English shares ("do", "main") stays out. When the lexicon resolves an ambiguous word it sees these as
 * sure Hindi neighbours.
 */
const ROMAN_HINDI_GRAMMAR = new Set(
  (
    "ek teen char paanch baat kar kare karen karein karni karne karta karti karte kholni kholna kholne hota hoti hote hoga hogi " +
    "wala wali vala vali liye lie kuchh kyaa chahta chahti sakta sakti sakte milega milegi dena dedo diya " +
    "lena lo le liya"
  ).split(" "),
);

/** The text without zero-width characters (ZWSP, ZWNJ, ZWJ, word joiner, byte-order mark). */
export function stripZeroWidth(text: string): string {
  return String(text ?? "").replace(ZERO_WIDTH, "");
}

type Piece =
  | { kind: "word"; text: string; script: "deva" | "latn" | "other" }
  | { kind: "num"; text: string }
  | { kind: "neutral"; text: string; visible: boolean };

function wordPieces(word: string): Piece[] {
  const out: Piece[] = [];
  let cls: "deva" | "latn" | "other" = "other";
  let run = "";
  for (const ch of word) {
    const next: "deva" | "latn" | "other" = IN_DEVANAGARI.test(ch)
      ? "deva"
      : IN_LATIN.test(ch)
        ? "latn"
        : (IS_MARK.test(ch) || ch === "'" || ch === "\u2019") && run
          ? cls
          : "other";
    if (run && next !== cls) {
      out.push({ kind: "word", text: run, script: cls });
      run = "";
    }
    cls = next;
    run += ch;
  }
  if (run) out.push({ kind: "word", text: run, script: cls });
  return out;
}

function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  for (const m of text.matchAll(TOKEN)) {
    if (m[1] !== undefined) out.push({ kind: "num", text: m[1] });
    else if (m[2] !== undefined) out.push(...wordPieces(m[2]));
    else if (m[3] !== undefined) out.push({ kind: "neutral", text: m[3], visible: false });
    else out.push({ kind: "neutral", text: m[4] ?? "", visible: true });
  }
  return out;
}

const grammarKey = (word: string): string => lexiconKey(word).replace(/['\u2019].*$/, "");

/** Hindi or English for each Devanagari or Latin word, in order; Devanagari is Hindi, a Roman word by the lexicon. */
function wordLangs(words: readonly Piece[]): Array<{ lang: "hi" | "en"; roman: boolean }> {
  const grammar = words.map(
    (w) => w.kind === "word" && w.script === "latn" && ROMAN_HINDI_GRAMMAR.has(grammarKey(w.text)),
  );
  // A grammar word counts as sure Hindi when the lexicon decides an ambiguous word beside it.
  const cores = words.map((w, i) => (grammar[i] ? "kya" : w.text));
  const labels = labelLanguages(cores);
  return words.map((w, i) => {
    if (w.kind === "word" && w.script === "deva") return { lang: "hi", roman: false };
    const hindi = grammar[i] || labels[i] === "hi";
    return { lang: hindi ? "hi" : "en", roman: hindi };
  });
}

/**
 * Cut a Hinglish string into maximal same-language spans. A Devanagari word is Hindi; a Latin word is Hindi only when
 * the lexicon says so (`romanisedHindi`), otherwise English; digit runs (`10:30`, `3.5`, `1,000`, Devanagari digits)
 * are number spans; a letter of another script is `other`. Whitespace and punctuation join the span they sit in, hang
 * on the span before a change of language, or form a `punct` span of their own at the very start or in a text with
 * no words. Empty and whitespace-only text give no spans. Pure; the spans rejoin to the input minus zero-width marks.
 */
export function segmentCodemix(text: string): CodemixSpan[] {
  const clean = stripZeroWidth(text);
  if (!clean.trim()) return [];
  const all = pieces(clean);
  const wordsOnly = all.filter((p) => p.kind === "word" && p.script !== "other");
  const langs = wordLangs(wordsOnly);
  const spans: CodemixSpan[] = [];
  let pending = "";
  let wordAt = 0;
  for (const p of all) {
    if (p.kind === "neutral") {
      pending += p.text;
      continue;
    }
    let next: CodemixSpan;
    if (p.kind === "num") {
      next = { text: p.text, script: "digits", lang: "num", romanisedHindi: false };
    } else if (p.script === "other") {
      next = { text: p.text, script: "punct", lang: "other", romanisedHindi: false };
    } else {
      const l = langs[wordAt++]!;
      next = {
        text: p.text,
        script: p.script,
        lang: l.lang,
        romanisedHindi: l.roman,
      };
    }
    const last = spans[spans.length - 1];
    if (
      last &&
      last.lang === next.lang &&
      last.script === next.script &&
      last.romanisedHindi === next.romanisedHindi
    ) {
      last.text += pending + next.text;
    } else if (last) {
      last.text += pending;
      spans.push(next);
    } else if (pending.trim()) {
      spans.push({ text: pending, script: "punct", lang: "other", romanisedHindi: false });
      spans.push(next);
    } else {
      next.text = pending + next.text;
      spans.push(next);
    }
    pending = "";
  }
  const tail = spans[spans.length - 1];
  if (tail) tail.text += pending;
  else if (pending.trim()) {
    spans.push({ text: pending, script: "punct", lang: "other", romanisedHindi: false });
  }
  return spans;
}
