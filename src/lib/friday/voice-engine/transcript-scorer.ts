/**
 * FRIDAY · how well a recogniser heard, scored offline.
 *
 * Pure: it takes the reference text, what the engine heard and (optionally) how long that took, and
 * returns word and character error, the confidence range, the script mismatch and the latency against
 * the turn budget. No audio, no model, no network, no clock. The normaliser is the same as the Python
 * one in `kernel/stt_bench.py` (a shared fixture pins them together), so a number from the owner's own
 * recordings and a number from here are comparable.
 *
 * A reference written in Devanagari and a hypothesis written in Roman letters are different strings
 * (script policy: the text stays as heard), so that case is counted as wrong and also reported on its own
 * as a script mismatch, so the spelling is not mistaken for a hearing error.
 */
import { wilson } from "../self/eval-stats";
import { LATENCY_BUDGET_MS } from "./latency-monitor";

export type SpeechLang = "hi" | "en" | "hinglish";
export type ScoredSample = {
  id: string;
  lang: SpeechLang;
  reference: string;
  hypothesis: string;
  /** Milliseconds from the end of speech to the final text, when it was measured. */
  ms?: number;
};

const DEVANAGARI_DIGIT = /[०-९]/g;
const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z]/;

/**
 * NFC, lower case, Devanagari digits to ASCII, the nukta dropped (फ़ and फ are one spelling), punctuation and
 * symbols (and the danda) to a space.
 */
export function normaliseTranscript(text: string): string {
  const folded = String(text)
    .normalize("NFC")
    .toLowerCase()
    .replace(DEVANAGARI_DIGIT, (digit) => String(digit.charCodeAt(0) - 0x0966))
    .replace(/\u093c/g, "")
    .replace(/[।॥]/g, " ");
  return folded
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The fewest single-word or single-character edits that turn `hypothesis` into `reference`. */
export function editDistance(reference: readonly string[], hypothesis: readonly string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const substitute = (previous[j - 1] ?? 0) + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitute));
    }
    previous = current;
  }
  return previous[hypothesis.length] ?? 0;
}

export function wordCounts(
  reference: string,
  hypothesis: string,
): { edits: number; words: number } {
  const ref = normaliseTranscript(reference).split(" ").filter(Boolean);
  const hyp = normaliseTranscript(hypothesis).split(" ").filter(Boolean);
  return { edits: editDistance(ref, hyp), words: ref.length };
}

/** Edits per reference word. An empty reference scores 0 when nothing was heard and 1 otherwise. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const { edits, words } = wordCounts(reference, hypothesis);
  if (!words) return edits ? 1 : 0;
  return edits / words;
}

export function charErrorRate(reference: string, hypothesis: string): number {
  const ref = [...normaliseTranscript(reference).replace(/ /g, "")];
  const hyp = [...normaliseTranscript(hypothesis).replace(/ /g, "")];
  if (!ref.length) return hyp.length ? 1 : 0;
  return editDistance(ref, hyp) / ref.length;
}

export type Script = "devanagari" | "latin" | "mixed" | "none";

/** The script most of the letters are written in; "mixed" when neither has at least 80%. */
export function dominantScript(text: string): Script {
  let deva = 0;
  let latin = 0;
  for (const char of normaliseTranscript(text)) {
    if (DEVANAGARI.test(char)) deva += 1;
    else if (LATIN.test(char)) latin += 1;
  }
  const letters = deva + latin;
  if (!letters) return "none";
  if (deva / letters >= 0.8) return "devanagari";
  if (latin / letters >= 0.8) return "latin";
  return "mixed";
}

/** A hypothesis in a whole other script than a pure reference: spelling, not hearing. */
export function scriptMismatch(reference: string, hypothesis: string): boolean {
  const ref = dominantScript(reference);
  const hyp = dominantScript(hypothesis);
  return (ref === "devanagari" && hyp === "latin") || (ref === "latin" && hyp === "devanagari");
}

/** A small deterministic generator, so a confidence range is the same on every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of a list of numbers. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

type Rate = { edits: number; total: number };
type Range95 = { low: number; high: number };

export type GroupScore = {
  samples: number;
  referenceWords: number;
  wordEdits: number;
  /** Total edits over total reference words: long sentences count for more than short ones. */
  corpusWer: number;
  /** 95% range from resampling the sentences (seeded), or null with fewer than 2 samples. */
  corpusWerRange: { low: number; high: number } | null;
  meanCer: number;
  /** Letters of the normalised references (spaces ignored) and the character edits over them. */
  referenceChars: number;
  charEdits: number;
  /** Total character edits over total reference letters, with the same seeded 95% resampled range. */
  corpusCer: number;
  corpusCerRange: Range95 | null;
  /** Sentences heard exactly, with the 95% Wilson interval for that rate. */
  exact: number;
  exactRate: number;
  exactRange: { low: number; high: number };
  scriptMismatches: number;
  latency: {
    measured: number;
    p50: number | null;
    p95: number | null;
    withinBudget: number;
  } | null;
};

const RESAMPLES = 400;

function charCounts(reference: string, hypothesis: string): Rate {
  const ref = [...normaliseTranscript(reference).replace(/ /g, "")];
  const hyp = [...normaliseTranscript(hypothesis).replace(/ /g, "")];
  return { edits: editDistance(ref, hyp), total: ref.length };
}

function rate(rows: readonly Rate[]): number {
  const e = rows.reduce((sum, c) => sum + c.edits, 0);
  const t = rows.reduce((sum, c) => sum + c.total, 0);
  return t ? e / t : e ? 1 : 0;
}

/** 95% range of an edit rate from resampling the sentences with a seeded generator; null below 2 sentences. */
function resampledRange(rows: readonly Rate[], seed: number): Range95 | null {
  if (rows.length < 2) return null;
  const next = seeded(seed);
  const draws: number[] = [];
  for (let r = 0; r < RESAMPLES; r += 1) {
    draws.push(rate(rows.map(() => rows[Math.floor(next() * rows.length)]!)));
  }
  return { low: percentile(draws, 2.5) ?? 0, high: percentile(draws, 97.5) ?? 0 };
}

function scoreGroup(samples: readonly ScoredSample[], budgetMs: number): GroupScore {
  const counts = samples.map((s) => wordCounts(s.reference, s.hypothesis));
  const edits = counts.reduce((sum, c) => sum + c.edits, 0);
  const words = counts.reduce((sum, c) => sum + c.words, 0);
  const wordRows = counts.map((c) => ({ edits: c.edits, total: c.words }));
  const charRows = samples.map((s) => charCounts(s.reference, s.hypothesis));
  const range = resampledRange(wordRows, samples.length * 7919 + words);
  const charTotal = charRows.reduce((sum, c) => sum + c.total, 0);
  const exact = samples.filter(
    (s) => normaliseTranscript(s.reference) === normaliseTranscript(s.hypothesis),
  ).length;
  const times = samples.flatMap((s) => (typeof s.ms === "number" ? [s.ms] : []));
  return {
    samples: samples.length,
    referenceWords: words,
    wordEdits: edits,
    corpusWer: rate(wordRows),
    corpusWerRange: range,
    meanCer: samples.length
      ? samples.reduce((sum, s) => sum + charErrorRate(s.reference, s.hypothesis), 0) /
        samples.length
      : 0,
    referenceChars: charTotal,
    charEdits: charRows.reduce((sum, c) => sum + c.edits, 0),
    corpusCer: rate(charRows),
    corpusCerRange: resampledRange(charRows, samples.length * 6151 + charTotal),
    exact,
    exactRate: samples.length ? exact / samples.length : 0,
    exactRange: wilson(exact, samples.length),
    scriptMismatches: samples.filter((s) => scriptMismatch(s.reference, s.hypothesis)).length,
    latency: times.length
      ? {
          measured: times.length,
          p50: percentile(times, 50),
          p95: percentile(times, 95),
          withinBudget: times.filter((ms) => ms <= budgetMs).length,
        }
      : null,
  };
}

/** What the owner expects a recogniser to reach. A target to be measured against, never a claim. */
export const WER_TARGETS: Readonly<Record<SpeechLang, number>> = {
  en: 0.1,
  hi: 0.2,
  hinglish: 0.25,
};

export type EngineReport = {
  overall: GroupScore;
  byLang: Partial<Record<SpeechLang, GroupScore>>;
  /** For each language scored: is the corpus WER at or under its target, and is the range under it too. */
  verdicts: Partial<Record<SpeechLang, "within" | "uncertain" | "over">>;
};

/** Score one engine over a set of samples, split by language. */
export function scoreEngine(
  samples: readonly ScoredSample[],
  options: { budgetMs?: number } = {},
): EngineReport {
  const budgetMs = options.budgetMs ?? LATENCY_BUDGET_MS;
  const byLang: EngineReport["byLang"] = {};
  const verdicts: EngineReport["verdicts"] = {};
  for (const lang of ["en", "hi", "hinglish"] as const) {
    const group = samples.filter((s) => s.lang === lang);
    if (!group.length) continue;
    const score = scoreGroup(group, budgetMs);
    byLang[lang] = score;
    const target = WER_TARGETS[lang];
    verdicts[lang] =
      score.corpusWer > target
        ? "over"
        : score.corpusWerRange && score.corpusWerRange.high > target
          ? "uncertain"
          : "within";
  }
  return { overall: scoreGroup(samples, budgetMs), byLang, verdicts };
}

/** Rank engines by overall corpus WER, then by p95 latency; an engine with no samples ranks last. */
export function rankEngines(
  engines: Readonly<Record<string, readonly ScoredSample[]>>,
  options: { budgetMs?: number } = {},
): Array<{ engine: string; report: EngineReport }> {
  return Object.entries(engines)
    .map(([engine, samples]) => ({ engine, report: scoreEngine(samples, options) }))
    .sort((a, b) => {
      const aw = a.report.overall.samples ? a.report.overall.corpusWer : 9;
      const bw = b.report.overall.samples ? b.report.overall.corpusWer : 9;
      return (
        aw - bw ||
        (a.report.overall.latency?.p95 ?? 1e9) - (b.report.overall.latency?.p95 ?? 1e9) ||
        a.engine.localeCompare(b.engine)
      );
    });
}
