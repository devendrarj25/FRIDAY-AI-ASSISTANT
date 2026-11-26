/**
 * FRIDAY · transcript script-policy checker.
 *
 * The policy (language-segmenter.ts `scriptPolicy`, FRIDAY_STATE "Deliberate design decisions"): Hindi is written in
 * Devanagari, English in Latin, and a transcript is never transliterated across scripts or translated. That module
 * tags a text; this one counts how often a recogniser broke the policy, so a bench can report it next to the word
 * error rate (the scorer reports a whole-sample script mismatch; this reports the individual words).
 *
 * Violations, per word, for the language the speaker was expected to use:
 *   · `roman-hindi-in-latin`    Hindi speech (Hindi or Hinglish) written in Latin letters. Only the sure Roman Hindi
 *                               of the Speech Prep lexicon counts; words English shares ("do", "main", "to") never do.
 *   · `english-in-devanagari`   an English word the lexicon knows, written in Devanagari ("मीटिंग" for "meeting").
 *   · `devanagari-in-english`   English speech holding any Devanagari word.
 *   · `mixed-script-word`       one word holding both scripts ("meetingको"); counted once, its parts are not.
 * Pure and conservative: a word the tables do not know is never a violation. Reuses the Speech Prep tables.
 */
import { ENGLISH_IN_HINDI, ROMAN_HINDI_STRONG, ROMAN_HINDI_WEAK } from "./speech-prep-lexicon";

export type ExpectedLang = "hi" | "en" | "hinglish";
export type ViolationKind =
  "roman-hindi-in-latin" | "english-in-devanagari" | "devanagari-in-english" | "mixed-script-word";

export const VIOLATION_KINDS: readonly ViolationKind[] = [
  "roman-hindi-in-latin",
  "english-in-devanagari",
  "devanagari-in-english",
  "mixed-script-word",
];

export type ScriptViolation = { kind: ViolationKind; word: string; index: number };

export type ScriptCheck = {
  expected: ExpectedLang;
  /** Letter words (Devanagari or Latin) checked; numbers and punctuation are not words. */
  words: number;
  violations: ScriptViolation[];
  counts: Record<ViolationKind, number>;
  clean: boolean;
};

export type ScriptSummary = {
  samples: number;
  /** Samples with at least one violation. */
  violating: number;
  words: number;
  violations: number;
  /** violations / words, 0 when there are no words. */
  rate: number;
  counts: Record<ViolationKind, number>;
};

const DEVANAGARI = /[ऀ-ॣॱ-ॿ]/u;
const LATIN = /[A-Za-z]/;
/** A chunk between spaces, minus the punctuation around it. */
const CHUNK = /[\p{L}\p{M}‌‍]+(?:['’][\p{L}]+)?/gu;

/** Nukta and chandrabindu folded, so "फ़ाइल" and "फाइल", "पाँच" and "पांच" compare equal. */
const fold = (s: string): string => s.normalize("NFC").replace(/[़‌‍]/g, "").replace(/ँ/g, "ं");

type Tables = { romanHindi: Set<string>; englishLoans: Set<string> };
let cached: Tables | null = null;

function pairs(source: string): [string, string][] {
  const words = source.split(/\s+/).filter(Boolean);
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < words.length; i += 2)
    out.push([words[i] as string, words[i + 1] as string]);
  return out;
}

/** Lexicon entries that are Hindi or Indian names, not English words: Devanagari is their right spelling. */
const NOT_ENGLISH = new Set(
  (
    "january february march april may june july august september october november december " +
    "delhi mumbai bangalore bengaluru chennai kolkata hyderabad pune jaipur lucknow india indian hindi english " +
    "hinglish aadhaar lakh lakhs yoga cough receipt wow"
  ).split(" "),
);
/** A shorter Devanagari word is too likely to be a real Hindi word ("बस", "की", "कट", "मेल"). */
const MIN_LOAN_LETTERS = 4;

function tables(): Tables {
  if (cached) return cached;
  const romanHindi = new Set(pairs(ROMAN_HINDI_STRONG).map(([latin]) => latin.toLowerCase()));
  // A Devanagari word that is also a real Hindi word is never called English.
  const hindi = new Set(
    [...pairs(ROMAN_HINDI_STRONG), ...pairs(ROMAN_HINDI_WEAK)].map(([, deva]) => fold(deva)),
  );
  const englishLoans = new Set(
    pairs(ENGLISH_IN_HINDI)
      .filter(([latin]) => !NOT_ENGLISH.has(latin))
      .map(([, deva]) => fold(deva))
      .filter((deva) => [...deva].length >= MIN_LOAN_LETTERS && !hindi.has(deva)),
  );
  cached = { romanHindi, englishLoans };
  return cached;
}

/** Accepts "hi", "hi-IN", "hi-Latn", "hinglish", "mixed", "en", "en-US"; anything else is English. */
export function expectedLang(value: string | undefined): ExpectedLang {
  const v = (value ?? "").toLowerCase().replace("_", "-");
  if (v === "hinglish" || v === "mixed" || v.startsWith("hi-latn")) return "hinglish";
  return v.startsWith("hi") ? "hi" : "en";
}

const emptyCounts = (): Record<ViolationKind, number> => ({
  "roman-hindi-in-latin": 0,
  "english-in-devanagari": 0,
  "devanagari-in-english": 0,
  "mixed-script-word": 0,
});

/** Check one transcript against the language it was spoken in. */
export function checkScriptPolicy(text: string, expected: string | undefined): ScriptCheck {
  const lang = expectedLang(expected);
  const { romanHindi, englishLoans } = tables();
  const violations: ScriptViolation[] = [];
  let words = 0;
  let index = 0;
  for (const match of (text ?? "").matchAll(CHUNK)) {
    const word = match[0];
    index += 1;
    words += 1;
    const deva = DEVANAGARI.test(word);
    const latin = LATIN.test(word);
    let kind: ViolationKind | null = null;
    if (deva && latin) kind = "mixed-script-word";
    else if (deva) {
      if (lang === "en") kind = "devanagari-in-english";
      else if (englishLoans.has(fold(word))) kind = "english-in-devanagari";
    } else if (latin && lang !== "en") {
      if (romanHindi.has(word.toLowerCase().replace(/['’].*$/, ""))) kind = "roman-hindi-in-latin";
    }
    if (kind) violations.push({ kind, word, index });
  }
  const counts = emptyCounts();
  for (const v of violations) counts[v.kind] += 1;
  return { expected: lang, words, violations, counts, clean: violations.length === 0 };
}

/** The bench total over many samples. */
export function summariseScriptChecks(checks: readonly ScriptCheck[]): ScriptSummary {
  const counts = emptyCounts();
  let words = 0;
  let violations = 0;
  let violating = 0;
  for (const check of checks) {
    words += check.words;
    violations += check.violations.length;
    if (!check.clean) violating += 1;
    for (const kind of VIOLATION_KINDS) counts[kind] += check.counts[kind];
  }
  return {
    samples: checks.length,
    violating,
    words,
    violations,
    rate: words ? violations / words : 0,
    counts,
  };
}

/** Convenience for a bench: check every `{ expected, text }` and total them. */
export function scriptViolationReport(
  samples: readonly { expected: string | undefined; text: string }[],
): ScriptSummary {
  return summariseScriptChecks(samples.map((s) => checkScriptPolicy(s.text, s.expected)));
}
