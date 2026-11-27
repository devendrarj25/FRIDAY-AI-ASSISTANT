/**
 * End-of-turn tuning, pure. Two small pieces for the turn engine:
 *
 * - `eotHoldFrames(text, expect)` says how many extra 80 ms frames of quiet to wait before
 *   a turn is closed. A sentence that stops on "aur" or "and" is not finished; a digit run
 *   may go on; a bare "haan" to a yes/no question is.
 * - `CalibrationRing` keeps the last turns' wait and false-cut outcome and nudges the base
 *   wait by one frame at a time, clamped, so FRIDAY adapts to how this owner speaks.
 *   `CalibrationBook` keeps one ring per language (English, Hindi, Hinglish).
 *
 * The language only ever adds waiting for an unfinished thought; `maxWaitFramesFor` is the
 * ceiling on any hold (2.4 s, 4 s for a dictation or an open answer).
 *
 * No clock, no timers, no storage here: the caller owns when to push and where to save.
 */
import { BACKCHANNEL_WORDS, DANGLING_TAIL_WORDS } from "./hinglish-lexicon";
import type { TurnExpect } from "./turn-engine";

export const DANGLING_HOLD_FRAMES = 6;
export const NUMBER_HOLD_FRAMES = 4;
export const YESNO_FAST_FRAMES = -4;

export const MIN_BASE_FRAMES = 4;
export const MAX_BASE_FRAMES = 10;
export const CALIBRATION_CAP = 200;
export const CALIBRATION_MIN_SAMPLES = 20;
export const FALSE_CUT_RAISE_ABOVE = 0.05;
export const FALSE_CUT_LOWER_BELOW = 0.01;
export const LOWER_P50_ABOVE_MS = 480;

export type EotLang = "en" | "hi" | "hinglish";
export const EOT_LANGS: readonly EotLang[] = ["en", "hi", "hinglish"];
/** Extra base frames for a language: Hindi and Hinglish speakers pause longer inside a thought. */
export const LANG_BASE_OFFSET: Readonly<Record<EotLang, number>> = { en: 0, hi: 2, hinglish: 2 };
/** Extra quiet frames a dictation or an open answer may have: the owner is composing. */
export const DICTATION_EAGER_FRAMES = 4;
/** Longest quiet wait in frames (30 x 80 ms = 2.4 s) before a turn is closed whatever the prior says. */
export const MAX_WAIT_FRAMES = 30;
export const MIN_MAX_WAIT_FRAMES = 15;
export const MAX_MAX_WAIT_FRAMES = 50;
const DICTATION_MAX_WAIT_EXTRA = MAX_MAX_WAIT_FRAMES - MAX_WAIT_FRAMES;

/** A thinking sound: in the backchannel list, but a thought is not an answer, so it holds the turn open. */
const THINKING = new Set(["hmm", "हम्म"]);

const NUMBER_WORDS = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "hundred",
  "thousand",
  "ek",
  "do",
  "teen",
  "char",
  "chaar",
  "paanch",
  "panch",
  "chhe",
  "chhah",
  "saat",
  "aath",
  "nau",
  "das",
  "bees",
  "tees",
  "pachas",
  "sau",
  "hazaar",
  "lakh",
  "शून्य",
  "एक",
  "दो",
  "तीन",
  "चार",
  "पाँच",
  "पांच",
  "छह",
  "छः",
  "छे",
  "सात",
  "आठ",
  "नौ",
  "दस",
  "बीस",
  "तीस",
  "पचास",
  "सौ",
  "हज़ार",
  "हजार",
  "लाख",
]);

const SENTENCE_END = /[.?!।॥…]["')\]]*$/u;
const NOT_WORD = /[^\p{L}\p{N}\p{M}]+/gu;

function lastWord(text: string): string {
  const parts = text.normalize("NFC").trim().split(/\s+/u);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const w = (parts[i] ?? "").replace(NOT_WORD, "").toLowerCase();
    if (w !== "") return w;
  }
  return "";
}

/**
 * Extra quiet frames (80 ms each) to wait on top of the base. Positive holds the turn open,
 * negative (never below -4) closes it sooner. A finished sentence mark cancels the holds; a
 * bare yes/no answer to a yes/no question still closes fast with its mark.
 */
export function eotHoldFrames(text: string, expect?: TurnExpect, lang?: EotLang): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const word = lastWord(trimmed);
  if (word === "") return 0;
  if (expect === "yesno" && BACKCHANNEL_WORDS.has(word) && !THINKING.has(word)) {
    return Math.max(YESNO_FAST_FRAMES, -4);
  }
  if (SENTENCE_END.test(trimmed)) return 0;
  if (DANGLING_TAIL_WORDS.has(word) || THINKING.has(word)) {
    return DANGLING_HOLD_FRAMES + (lang ? (LANG_BASE_OFFSET[lang] ?? 0) : 0);
  }
  if (expect === "number" && (/\d$/u.test(word) || NUMBER_WORDS.has(word))) {
    return NUMBER_HOLD_FRAMES;
  }
  return 0;
}

/** The base wait for a language: the offset added, never past MAX_BASE_FRAMES + 2, never below the base. */
export function withLangOffset(base: number, lang?: EotLang): number {
  const offset = lang ? (LANG_BASE_OFFSET[lang] ?? 0) : 0;
  return Math.max(base, Math.min(base + offset, MAX_BASE_FRAMES + 2));
}

/** Extra base frames for the kind of answer expected (dictation and open take longer). */
export function eotEagerFrames(expect?: TurnExpect): number {
  return expect === "dictation" || expect === "open" ? DICTATION_EAGER_FRAMES : 0;
}

/** The longest quiet wait, in frames, for the answer expected, clamped to 1.2..4 s. */
export function maxWaitFramesFor(
  expect?: TurnExpect,
  configured: number = MAX_WAIT_FRAMES,
): number {
  const base = Number.isFinite(configured) ? Math.trunc(configured) : MAX_WAIT_FRAMES;
  const extra = expect === "dictation" || expect === "open" ? DICTATION_MAX_WAIT_EXTRA : 0;
  return Math.min(MAX_MAX_WAIT_FRAMES, Math.max(MIN_MAX_WAIT_FRAMES, base + extra));
}

export type CalibrationSample = { eotWaitMs: number; falseCut: boolean };
export type CalibrationJson = { v: 1; samples: CalibrationSample[] };

function validSample(x: unknown): x is CalibrationSample {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["eotWaitMs"] === "number" &&
    Number.isFinite(o["eotWaitMs"]) &&
    typeof o["falseCut"] === "boolean"
  );
}

/** The last `cap` turns' end-of-turn wait and whether the cut was a false one. */
export class CalibrationRing {
  private samples: CalibrationSample[] = [];

  constructor(private readonly cap: number = CALIBRATION_CAP) {}

  push(sample: CalibrationSample): void {
    if (!validSample(sample)) return;
    this.samples.push({ eotWaitMs: Math.max(0, sample.eotWaitMs), falseCut: sample.falseCut });
    while (this.samples.length > this.cap) this.samples.shift();
  }

  size(): number {
    return this.samples.length;
  }

  /** The base wait (in frames) to use next: one frame up, one frame down, or unchanged. */
  suggestedBaseFrames(cur: number): number {
    const n = this.samples.length;
    if (n < CALIBRATION_MIN_SAMPLES) return cur;
    const rate = this.samples.filter((s) => s.falseCut).length / n;
    let next = cur;
    if (rate > FALSE_CUT_RAISE_ABOVE) {
      next = cur + 1;
    } else if (rate < FALSE_CUT_LOWER_BELOW) {
      const waits = this.samples.map((s) => s.eotWaitMs).sort((a, b) => a - b);
      const p50 = waits[Math.floor((n - 1) / 2)] ?? 0;
      if (p50 > LOWER_P50_ABOVE_MS) next = cur - 1;
    }
    return Math.min(MAX_BASE_FRAMES, Math.max(MIN_BASE_FRAMES, next));
  }

  toJSON(): CalibrationJson {
    return { v: 1, samples: this.samples.map((s) => ({ ...s })) };
  }

  /** Any bad shape, one bad sample included, loads as an empty ring. */
  static fromJSON(x: unknown, cap: number = CALIBRATION_CAP): CalibrationRing {
    const ring = new CalibrationRing(cap);
    if (typeof x !== "object" || x === null) return ring;
    const o = x as Record<string, unknown>;
    const list = o["samples"];
    if (o["v"] !== 1 || !Array.isArray(list) || !list.every(validSample)) return ring;
    for (const s of list) ring.push(s);
    return ring;
  }
}

export type CalibrationBookJson = { v: 2; rings: Record<EotLang, CalibrationSample[]> };

/** One ring per language: a language moves its own base only after its own 20 samples. */
export class CalibrationBook {
  private readonly rings: Record<EotLang, CalibrationRing> = {
    en: new CalibrationRing(),
    hi: new CalibrationRing(),
    hinglish: new CalibrationRing(),
  };

  push(lang: EotLang, sample: CalibrationSample): void {
    this.rings[lang]?.push(sample);
  }

  size(lang: EotLang): number {
    return this.rings[lang]?.size() ?? 0;
  }

  /** The base wait (frames) for this language's own samples, without the language offset. */
  suggestedBaseFrames(lang: EotLang, cur: number): number {
    return this.rings[lang]?.suggestedBaseFrames(cur) ?? cur;
  }

  /** The base wait to run with: this language's suggestion plus its offset. */
  baseFramesFor(lang: EotLang, cur: number): number {
    return withLangOffset(this.suggestedBaseFrames(lang, cur), lang);
  }

  toJSON(): CalibrationBookJson {
    return {
      v: 2,
      rings: {
        en: this.rings.en.toJSON().samples,
        hi: this.rings.hi.toJSON().samples,
        hinglish: this.rings.hinglish.toJSON().samples,
      },
    };
  }

  /** Any bad shape, one bad ring included, loads as an empty book. */
  static fromJSON(x: unknown): CalibrationBook {
    const book = new CalibrationBook();
    if (typeof x !== "object" || x === null) return book;
    const o = x as Record<string, unknown>;
    const rings = o["rings"];
    if (o["v"] !== 2 || typeof rings !== "object" || rings === null) return book;
    const r = rings as Record<string, unknown>;
    const loaded = new Map<EotLang, CalibrationSample[]>();
    for (const lang of EOT_LANGS) {
      const list = r[lang] ?? [];
      if (!Array.isArray(list) || !list.every(validSample)) return book;
      loaded.set(lang, list);
    }
    for (const [lang, list] of loaded) for (const s of list) book.push(lang, s);
    return book;
  }
}
