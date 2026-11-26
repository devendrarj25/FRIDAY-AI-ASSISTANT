/**
 * End-of-turn tuning, pure. Two small pieces for the turn engine:
 *
 * - `eotHoldFrames(text, expect)` says how many extra 80 ms frames of quiet to wait before
 *   a turn is closed. A sentence that stops on "aur" or "and" is not finished; a digit run
 *   may go on; a bare "haan" to a yes/no question is.
 * - `CalibrationRing` keeps the last turns' wait and false-cut outcome and nudges the base
 *   wait by one frame at a time, clamped, so FRIDAY adapts to how this owner speaks.
 *
 * No clock, no timers, no storage here: the caller owns when to push and where to save.
 */
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

/** A word after which a speaker nearly always goes on (Latin and Devanagari). */
const DANGLING = new Set([
  "aur",
  "ki",
  "ke",
  "ko",
  "toh",
  "matlab",
  "ya",
  "jaise",
  "kyunki",
  "lekin",
  "and",
  "or",
  "the",
  "of",
  "to",
  "um",
  "uh",
  "hmm",
  "so",
  "but",
  "और",
  "की",
  "के",
  "को",
  "तो",
  "मतलब",
  "या",
  "लेकिन",
]);

const YES_NO = new Set([
  "haan",
  "han",
  "nahi",
  "nahin",
  "ji",
  "yes",
  "no",
  "ok",
  "okay",
  "theek",
  "thik",
  "हाँ",
  "हां",
  "नहीं",
  "नही",
  "जी",
  "ठीक",
]);

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
export function eotHoldFrames(text: string, expect?: TurnExpect): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const word = lastWord(trimmed);
  if (word === "") return 0;
  if (expect === "yesno" && YES_NO.has(word)) return Math.max(YESNO_FAST_FRAMES, -4);
  if (SENTENCE_END.test(trimmed)) return 0;
  if (DANGLING.has(word)) return DANGLING_HOLD_FRAMES;
  if (expect === "number" && (/\d$/u.test(word) || NUMBER_WORDS.has(word))) {
    return NUMBER_HOLD_FRAMES;
  }
  return 0;
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
