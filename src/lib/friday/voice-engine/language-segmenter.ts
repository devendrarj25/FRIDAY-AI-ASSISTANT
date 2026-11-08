/**
 * FRIDAY · language and script spans for speech (renderer mirror of `kernel/language_segmenter.py`).
 *
 * Mixed Hindi and English is never "unsupported". A sentence is cut by script into a few phrase-sized spans, each
 * tagged with the voice language that reads it (`hi` for Devanagari, `en` for Latin), in written order. A run
 * shorter than MIN_SPAN_WORDS folds into its neighbour so a lone English noun inside a Hindi clause is not a
 * request of its own, and the span count is bounded. `chunkForSpeech` then groups sentences into speakable
 * chunks: never one chunk per word, the first chunk may end at a clause break so audio starts early.
 */

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
  "dr mr mrs ms prof sr jr st vs etc approx no fig eg ie am pm inc ltd co".split(" "),
);

/**
 * Does this text end with a dot that is not the end of a sentence: an abbreviation (Dr., p.m., e.g.), an initial
 * (the "J." of "J. K. Rowling") or a bare list number ("3.")? Used wherever a reply is cut into sentences, so a
 * cut never lands inside a name, a time or a numbered list.
 */
export function endsInOpenDot(text: string): boolean {
  const t = (text ?? "").replace(/\s+$/, "");
  if (!t.endsWith(".")) return false;
  const before = t.slice(0, -1);
  const word = /([A-Za-z.]+)$/.exec(before)?.[1] ?? "";
  const bare = word.replace(/\./g, "").toLowerCase();
  if (bare && ABBREVIATIONS.has(bare)) return true;
  if (/(?:^|[\s(])[A-Z]$/.test(before) && !/(?:^|[\s(])I$/.test(before)) return true;
  if (/(?:^|\n)\s*\d{1,2}$/.test(before)) return true;
  return false;
}

/** Cut text into sentences, putting a piece that ends in an open dot back with the one after it. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const raw of (text ?? "").split(SENTENCE_END)) {
    const piece = carry ? `${carry} ${raw}` : raw;
    if (endsInOpenDot(piece) && !raw.endsWith("\n")) {
      carry = piece;
      continue;
    }
    carry = "";
    out.push(piece);
  }
  if (carry) out.push(carry);
  return out;
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
