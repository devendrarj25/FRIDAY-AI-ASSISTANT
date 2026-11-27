/**
 * FRIDAY · a small closed word lexicon for Hindi and English mixed in one sentence.
 *
 * Pure and table-driven: no model, no network, no clock. It answers two questions about a transcript:
 *   1. Which words are Hindi and which are English (`labelLanguages`)? Used to find the language-switch positions.
 *   2. What does the text look like under the script policy (`fixScript`)? Hindi words in Devanagari, English words
 *      in Latin, whatever the engine wrote: a sure Roman Hindi word becomes Devanagari, a Devanagari-spelled English
 *      loanword (डिस्क्रिप्शन) goes back to Latin (description).
 *
 * Only words in the tables change. An unknown word is never guessed at and never touched. A word that is both a
 * Hindi and an English word (do, main, to, me, hai ...) stays as written unless a word next to it is surely Hindi.
 *
 * The scorer folds both sides through `fixScript` before its Roman skeleton fold, which is how the T-WER number is
 * made (`transcript-scorer.ts`). The Python twin is `kernel/stt_bench.py`; `lexiconLines()` is hashed by both test
 * suites against `core/fixtures/voice-eval/twer-vectors.json`, so the two tables cannot drift apart.
 * The text layer may call `fixScript` too; it is not wired into the renderer here.
 */

export const LEXICON_VERSION: string = lexiconJson.version;

import lexiconJson from "../../../../config/hinglish-lexicon.json" with { type: "json" };

export type ScriptPolicy = "codemix" | "hindi" | "english";
export type WordLanguage = "hi" | "en" | "none";

type Pair = readonly [string, string];
type WordTable = { hindi: string[]; devanagari: string[]; english: string[] };

/** The word tables live in config/hinglish-lexicon.json; the kernel reads the same file (kernel/hinglish_lexicon.py). */
const DATA = lexiconJson as unknown as {
  version: string;
  thresholds: { romanHinglishShare: number; shortTurnWords: number };
  sureHindi: Pair[];
  sureHindiAdded: Pair[];
  ambiguous: Pair[];
  loanwords: Pair[];
  tailWords: WordTable;
  backchannel: WordTable;
};

/** Roman Hindi spellings (separated by "|") that mean one Hindi word and nothing in English, then its Devanagari. */
const SURE_HINDI: ReadonlyArray<Pair> = DATA.sureHindi;
/** Sure Hindi words added after the scorer's digest was pinned: they label and fix like the rest. */
const SURE_HINDI_ADDED: ReadonlyArray<Pair> = DATA.sureHindiAdded;
/** Words that are Hindi and English at once: they turn Devanagari only when a word beside them is surely Hindi. */
const AMBIGUOUS: ReadonlyArray<Pair> = DATA.ambiguous;
/** English loanwords: the Latin word, then the Devanagari spellings an engine writes for it (separated by "|"). */
const LOANWORDS: ReadonlyArray<Pair> = DATA.loanwords;

const wordSet = (t: WordTable): ReadonlySet<string> =>
  new Set([...t.hindi, ...t.devanagari, ...t.english].map((w) => w.normalize("NFC").toLowerCase()));

/** A word after which a speaker nearly always goes on (Roman Hindi, Devanagari, English). Lower case, NFC. */
export const DANGLING_TAIL_WORDS: ReadonlySet<string> = wordSet(DATA.tailWords);
/** A short answer or acknowledgement (haan, nahi, ji, theek, achha, hmm). Lower case, NFC. */
export const BACKCHANNEL_WORDS: ReadonlySet<string> = wordSet(DATA.backchannel);

const DEVANAGARI = /[ऀ-ॿ]/;
const LETTER = /\p{L}/u;
const EDGE = /^([^\p{L}\p{M}\p{N}]*)(.*?)([^\p{L}\p{M}\p{N}]*)$/su;

/** A word on its lexicon key: NFC, lower case, the nukta dropped and the chandrabindu written as the anusvara. */
export function lexiconKey(word: string): string {
  return word.normalize("NFC").toLowerCase().replace(/़/g, "").replace(/ँ/g, "ं");
}

const sureHindi = new Map<string, string>();
const ambiguous = new Map<string, string>();
const loanwords = new Map<string, string>();
for (const [variants, devanagari] of SURE_HINDI) {
  for (const v of variants.split("|")) sureHindi.set(v, devanagari);
}
for (const [variants, devanagari] of SURE_HINDI_ADDED) {
  for (const v of variants.split("|")) sureHindi.set(v, devanagari);
}
for (const [roman, devanagari] of AMBIGUOUS) ambiguous.set(roman, devanagari);
for (const [latin, spellings] of LOANWORDS) {
  for (const s of spellings.split("|")) loanwords.set(lexiconKey(s), latin);
}

/**
 * One line per table entry of the scored tables (sure Hindi with the added words, ambiguous, loanwords), in a fixed
 * order, so two implementations can compare a hash of their tables. `kernel/stt_bench.py` builds the same lines
 * from `kernel/hinglish_lexicon.py`.
 */
export function lexiconLines(): string[] {
  const lines: string[] = [];
  for (const [k, v] of sureHindi) lines.push(`sure|${k}|${v}`);
  for (const [k, v] of ambiguous) lines.push(`ambiguous|${k}|${v}`);
  for (const [k, v] of loanwords) lines.push(`loan|${k}|${v}`);
  return lines.sort();
}

/** Every table of config/hinglish-lexicon.json as sorted lines; `kernel/hinglish_lexicon.py` builds the same lines. */
export function lexiconDataLines(): string[] {
  const lines = lexiconLines();
  for (const [group, table] of [
    ["tail", DATA.tailWords],
    ["backchannel", DATA.backchannel],
  ] as const) {
    for (const w of [...table.hindi, ...table.devanagari, ...table.english]) {
      lines.push(`${group}|${w.normalize("NFC").toLowerCase()}`);
    }
  }
  return [...new Set(lines)].sort();
}

type Kind = { lang: WordLanguage; deva?: string; latin?: string; maybe?: boolean };

function firstPass(core: string): Kind {
  if (!LETTER.test(core)) return { lang: "none" };
  const key = lexiconKey(core);
  if (DEVANAGARI.test(key)) {
    const latin = loanwords.get(key);
    return latin !== undefined ? { lang: "en", latin } : { lang: "hi" };
  }
  const sure = sureHindi.get(key);
  if (sure !== undefined) return { lang: "hi", deva: sure };
  const maybe = ambiguous.get(key);
  if (maybe !== undefined) return { lang: "en", deva: maybe, maybe: true };
  return { lang: "en" };
}

/** Each word of a token list (words already stripped of punctuation) as Hindi, English or neither (digits). */
function classify(cores: readonly string[]): Kind[] {
  const first = cores.map(firstPass);
  return first.map((kind, i) => {
    if (!kind.maybe) return kind;
    const hindiBeside = first[i - 1]?.lang === "hi" || first[i + 1]?.lang === "hi";
    return hindiBeside ? { lang: "hi", deva: kind.deva! } : { lang: "en" as const };
  });
}

/** Hindi, English or none for each word. A Devanagari loanword is English, a sure Roman Hindi word is Hindi. */
export function labelLanguages(cores: readonly string[]): WordLanguage[] {
  return classify(cores).map((k) => k.lang);
}

/** The words of `cores` rewritten to the policy; every other word is returned as it came. */
export function fixCores(cores: readonly string[], policy: ScriptPolicy = "codemix"): string[] {
  const toDevanagari = policy !== "english";
  const toLatin = policy !== "hindi";
  return classify(cores).map((kind, i) => {
    const core = cores[i]!;
    if (toDevanagari && kind.lang === "hi" && kind.deva !== undefined) return kind.deva;
    if (toLatin && kind.lang === "en" && kind.latin !== undefined) return kind.latin;
    return core;
  });
}

/**
 * Put a transcript on the script policy: `codemix` writes Hindi words in Devanagari and English words in Latin;
 * `hindi` only turns Roman Hindi into Devanagari; `english` only turns Devanagari loanwords back into Latin.
 * Spacing and the punctuation around a word are kept; a word that is not in the tables is left exactly as it was.
 */
export function fixScript(text: string, expectedPolicy: ScriptPolicy = "codemix"): string {
  const pieces = String(text).split(/(\s+)/);
  const slots: Array<{ at: number; lead: string; core: string; tail: string }> = [];
  pieces.forEach((piece, at) => {
    if (!piece || /^\s+$/.test(piece)) return;
    const m = EDGE.exec(piece)!;
    slots.push({ at, lead: m[1]!, core: m[2]!, tail: m[3]! });
  });
  const fixed = fixCores(
    slots.map((s) => s.core),
    expectedPolicy,
  );
  slots.forEach((s, i) => {
    pieces[s.at] = s.lead + fixed[i]! + s.tail;
  });
  return pieces.join("");
}

/** Share of a Latin line's words that must be Hindi in the lexicon for the line to count as romanised Hinglish. */
export const ROMAN_HINGLISH_SHARE: number = DATA.thresholds.romanHinglishShare;
/** A line with fewer words than this is too short to judge: the speech engine's declared language is kept. */
export const SHORT_TURN_WORDS: number = DATA.thresholds.shortTurnWords;

export type TurnLanguageRead = { lang: "hi" | "en" | "hi-en" | ""; romanised: boolean };

/**
 * The language of one turn, shared by the Brain's reply-language hint and her own short lines. Devanagari is Hindi,
 * both scripts are Hinglish, and Latin text whose words are at least `ROMAN_HINGLISH_SHARE` sure Roman Hindi is
 * romanised Hinglish (`romanised: true`); a declared Hindi or Hinglish ear is kept as it was said. Lines under
 * `SHORT_TURN_WORDS` words and lines without letters keep the declared language.
 */
export function detectTurnLanguage(
  text: string,
  declared: "hi" | "en" | "hi-en" | "" = "",
): TurnLanguageRead {
  let deva = 0;
  let latin = 0;
  for (const ch of String(text)) {
    if (DEVANAGARI.test(ch)) deva += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
  }
  if (deva > 0 && latin > 0) return { lang: "hi-en", romanised: false };
  if (deva > 0) return { lang: "hi", romanised: false };
  if (latin === 0) return { lang: declared, romanised: false };
  const cores: string[] = [];
  for (const piece of String(text).split(/\s+/)) {
    const core = EDGE.exec(piece)?.[2] ?? "";
    if (LETTER.test(core)) cores.push(core);
  }
  if (cores.length < SHORT_TURN_WORDS) return { lang: declared || "en", romanised: false };
  const hindi = labelLanguages(cores).filter((l) => l === "hi").length;
  if (hindi / cores.length >= ROMAN_HINGLISH_SHARE) {
    return {
      lang: declared === "hi" || declared === "hi-en" ? declared : "hi-en",
      romanised: true,
    };
  }
  return { lang: declared === "hi" || declared === "hi-en" ? declared : "en", romanised: false };
}
