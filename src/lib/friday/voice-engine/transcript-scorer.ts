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
 *
 * Beside that strict number sits the folded one (the second half of this file): both scripts are put on one
 * Roman skeleton and digits and number words become digits, so it measures hearing, while a separate count of
 * script-policy violations measures spelling. It also holds the latency and flicker metrics, the seeded
 * bootstrap and the regression gate. The Python twin is `kernel/stt_bench.py`; the vectors in
 * `core/fixtures/voice-eval/fold-vectors.json` pin the two together, key for key.
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
export function seeded(seed: number): () => number {
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

/* ------------------------------------------------------------------------------------------------
 * The folded scorer, latency, flicker, bootstrap and the regression gate (P0-bench).
 * Same algorithm, tables and tie-breaks as kernel/stt_bench.py.
 * ---------------------------------------------------------------------------------------------- */

/** Names the normaliser: a baseline made under another one is not comparable. */
export const FOLD_VERSION = "fold-1";
export const BOOTSTRAP_SEED = 7919;
export const BOOTSTRAP_DRAWS = 1000;
export const DEFAULT_MAX_WER_RISE = 0.02;
const EPS = 1e-9;

const VOWELS: Readonly<Record<string, string>> = {
  अ: "a",
  आ: "aa",
  इ: "i",
  ई: "ii",
  उ: "u",
  ऊ: "uu",
  ए: "e",
  ऐ: "ai",
  ओ: "o",
  औ: "au",
  ऑ: "o",
  ऋ: "ri",
};
const MATRAS: Readonly<Record<string, string>> = {
  "\u093e": "aa",
  "\u093f": "i",
  "\u0940": "ii",
  "\u0941": "u",
  "\u0942": "uu",
  "\u0947": "e",
  "\u0948": "ai",
  "\u094b": "o",
  "\u094c": "au",
  "\u0949": "o",
  "\u0943": "ri",
};
const CONSONANTS: Readonly<Record<string, string>> = {
  क: "k",
  ख: "kh",
  ग: "g",
  घ: "gh",
  ङ: "n",
  च: "ch",
  छ: "chh",
  ज: "j",
  झ: "jh",
  ञ: "n",
  ट: "t",
  ठ: "th",
  ड: "d",
  ढ: "dh",
  ण: "n",
  त: "t",
  थ: "th",
  द: "d",
  ध: "dh",
  न: "n",
  प: "p",
  फ: "ph",
  ब: "b",
  भ: "bh",
  म: "m",
  य: "y",
  र: "r",
  ल: "l",
  व: "v",
  श: "sh",
  ष: "sh",
  स: "s",
  ह: "h",
};
const VIRAMA = "\u094d";
const OTHER_DIGITS = /[\u0660-\u0669\u06f0-\u06f9\uff10-\uff19]/g;
/** Number words that mean one number only; "do" and "दो" (also "give") and "no"/"to" are left as words. */
const NUMBER_WORDS: ReadonlyMap<string, string> = new Map([
  ...["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map(
    (w, i) => [w, String(i)] as [string, string],
  ),
  ...Object.entries({
    शून्य: "0",
    एक: "1",
    तीन: "3",
    चार: "4",
    पांच: "5",
    पाँच: "5",
    छह: "6",
    छः: "6",
    सात: "7",
    आठ: "8",
    नौ: "9",
    दस: "10",
    shunya: "0",
    ek: "1",
    teen: "3",
    char: "4",
    panch: "5",
    paanch: "5",
    chhe: "6",
    chhah: "6",
    saat: "7",
    aath: "8",
    nau: "9",
    das: "10",
  }),
]);

/** Devanagari to a plain Roman spelling: the inherent "a" is written, but not at the end of a word. */
function romanise(word: string): string {
  const chars = [...word];
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]!;
    const next = chars[i + 1];
    if (CONSONANTS[c] !== undefined) {
      out += CONSONANTS[c];
      if (next === VIRAMA) i += 1;
      else if (next !== undefined && MATRAS[next] !== undefined) {
        out += MATRAS[next];
        i += 1;
      } else if (next !== undefined) out += "a";
    } else if (VOWELS[c] !== undefined) out += VOWELS[c];
    else if (c === "ं" || c === "ँ") out += "n";
    else if (c === "ः") out += "h";
    else if (MATRAS[c] !== undefined) out += MATRAS[c];
    else if (c !== VIRAMA) out += c;
  }
  return out;
}

function skeleton(word: string): string {
  const roman = DEVANAGARI.test(word) ? romanise(word) : word;
  return roman
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/w/g, "v")
    .replace(/z/g, "j")
    .replace(/ai|ei|ae/g, "e")
    .replace(/au|ou/g, "o")
    .replace(/ee|ii/g, "i")
    .replace(/oo|uu/g, "u")
    .replace(/([a-z])\1+/g, "$1");
}

/** One word on its fold: a number word is its digits, anything else is its spelling-tolerant Roman skeleton. */
export function foldToken(token: string): string {
  const word = token.toLowerCase();
  return NUMBER_WORDS.get(word) ?? skeleton(word);
}

function foldWords(text: string): string[] {
  return normaliseTranscript(text)
    .replace(OTHER_DIGITS, (d) => String(d.charCodeAt(0) & 0xf))
    .split(" ")
    .filter(Boolean);
}

export function foldTokens(text: string): string[] {
  return foldWords(text).map(foldToken);
}

function scriptClass(token: string): "devanagari" | "latin" | "none" {
  if (DEVANAGARI.test(token)) return "devanagari";
  return /[a-z]/.test(token) ? "latin" : "none";
}

type Op = { kind: "hit" | "sub" | "del" | "ins"; ref: number; hyp: number };

/** Ties go to a match or substitution first, then a deletion, then an insertion (as in Python). */
function align(ref: readonly string[], hyp: readonly string[]): Op[] {
  const n = ref.length;
  const m = hyp.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j += 1) d[0]![j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ kind: ref[i - 1] === hyp[j - 1] ? "hit" : "sub", ref: i - 1, hyp: j - 1 });
      i -= 1;
      j -= 1;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ kind: "del", ref: i - 1, hyp: -1 });
      i -= 1;
    } else {
      ops.push({ kind: "ins", ref: -1, hyp: j - 1 });
      j -= 1;
    }
  }
  return ops.reverse();
}

export type FoldedCounts = {
  words: number;
  edits: number;
  hits: number;
  subs: number;
  dels: number;
  ins: number;
  chars: number;
  charEdits: number;
  /** Word edits under the strict normaliser (no fold), so the strict and folded numbers sit side by side. */
  strictEdits: number;
  /** Words the fold says are the same that the reference writes in Devanagari and the hypothesis in Roman. */
  devanagariToLatin: number;
  /** The other way round: written in Roman in the reference, in Devanagari in the hypothesis. */
  latinToDevanagari: number;
  violations: number;
};

/** Everything the folded scores are made of for one utterance, as counts that add up across a corpus. */
export function foldedCounts(reference: string, hypothesis: string): FoldedCounts {
  const rawRef = foldWords(reference);
  const rawHyp = foldWords(hypothesis);
  const ref = rawRef.map(foldToken);
  const hyp = rawHyp.map(foldToken);
  const ops = align(ref, hyp);
  const count = (kind: Op["kind"]) => ops.filter((op) => op.kind === kind).length;
  let toLatin = 0;
  let toDeva = 0;
  for (const op of ops) {
    if (op.kind !== "hit") continue;
    const rs = scriptClass(rawRef[op.ref]!);
    const hs = scriptClass(rawHyp[op.hyp]!);
    if (rs === "devanagari" && hs === "latin") toLatin += 1;
    else if (rs === "latin" && hs === "devanagari") toDeva += 1;
  }
  const refChars = [...ref.join("")];
  const hypChars = [...hyp.join("")];
  const strictRef = normaliseTranscript(reference).split(" ").filter(Boolean);
  const strictHyp = normaliseTranscript(hypothesis).split(" ").filter(Boolean);
  return {
    words: ref.length,
    edits: ops.length - count("hit"),
    hits: count("hit"),
    subs: count("sub"),
    dels: count("del"),
    ins: count("ins"),
    chars: refChars.length,
    charEdits: editDistance(refChars, hypChars),
    strictEdits: editDistance(strictRef, strictHyp),
    devanagariToLatin: toLatin,
    latinToDevanagari: toDeva,
    violations: toLatin + toDeva,
  };
}

function ratio(edits: number, total: number): number {
  return total ? edits / total : edits ? 1 : 0;
}

export function foldedWordErrorRate(reference: string, hypothesis: string): number {
  const c = foldedCounts(reference, hypothesis);
  return ratio(c.edits, c.words);
}

export function foldedCharErrorRate(reference: string, hypothesis: string): number {
  const c = foldedCounts(reference, hypothesis);
  return ratio(c.charEdits, c.chars);
}

/** Match error rate: edits over hits plus edits, so it stays within 0 to 1 where a word error rate can pass 1. */
export function matchErrorRate(reference: string, hypothesis: string): number {
  const c = foldedCounts(reference, hypothesis);
  const span = c.hits + c.edits;
  return span ? c.edits / span : 0;
}

/* ---- latency from a timeline of events ------------------------------------------------------- */

export const EVENT_KINDS = ["speech_start", "partial", "speech_end", "endpoint", "final"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type LatencyTimeline = {
  /** Length of the audio. */
  audioMs: number;
  /** Busy time the engine spent, for the real-time factor. */
  computeMs?: number;
  /** Times on one monotonic clock, in milliseconds. */
  events: ReadonlyArray<{ t: number; kind: EventKind; text?: string }>;
};
export type LatencyMetrics = {
  timeToFirstPartialMs: number | null;
  /** Endpoint minus the true end of speech; negative means the speaker was cut off. */
  endpointLatencyMs: number | null;
  finalisationLagMs: number | null;
  rtf: number | null;
  prematureEndpoint: boolean;
  complete: boolean;
};

/** One utterance's timing from a timeline (a fake clock in tests). Throws on a timeline that cannot be read. */
export function latencyMetrics(timeline: LatencyTimeline): LatencyMetrics {
  let last: number | null = null;
  for (const e of timeline.events) {
    if (!EVENT_KINDS.includes(e.kind)) throw new Error(`unknown event kind ${String(e.kind)}`);
    if (typeof e.t !== "number" || !Number.isFinite(e.t))
      throw new Error("an event needs a numeric t");
    if (last !== null && e.t < last) throw new Error("the timeline runs backwards");
    last = e.t;
  }
  const first = (kind: EventKind): number | null =>
    timeline.events.find((e) => e.kind === kind)?.t ?? null;
  const start = first("speech_start");
  if (start === null) throw new Error("a timeline needs a speech_start event");
  const end = first("speech_end");
  const partial = first("partial");
  const endpoint = first("endpoint");
  const final = first("final");
  const { audioMs, computeMs } = timeline;
  return {
    timeToFirstPartialMs: partial === null ? null : partial - start,
    endpointLatencyMs: endpoint === null || end === null ? null : endpoint - end,
    finalisationLagMs: final === null || end === null ? null : final - end,
    rtf: audioMs > 0 && computeMs !== undefined ? computeMs / audioMs : null,
    prematureEndpoint: endpoint !== null && end !== null && endpoint < end,
    complete: final !== null,
  };
}

export type LatencySummary = {
  n: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  mean: number | null;
};

export function summariseLatency(values: ReadonlyArray<number | null>): LatencySummary {
  const got = values.filter((v): v is number => v !== null);
  if (!got.length) return { n: 0, p50: null, p90: null, p99: null, mean: null };
  return {
    n: got.length,
    p50: percentile(got, 50),
    p90: percentile(got, 90),
    p99: percentile(got, 99),
    mean: got.reduce((sum, v) => sum + v, 0) / got.length,
  };
}

export function aggregateLatency(timelines: readonly LatencyTimeline[]) {
  const per = timelines.map(latencyMetrics);
  return {
    utterances: per.length,
    timeToFirstPartialMs: summariseLatency(per.map((m) => m.timeToFirstPartialMs)),
    endpointLatencyMs: summariseLatency(per.map((m) => m.endpointLatencyMs)),
    finalisationLagMs: summariseLatency(per.map((m) => m.finalisationLagMs)),
    rtf: summariseLatency(per.map((m) => m.rtf)),
    prematureEndpoints: per.filter((m) => m.prematureEndpoint).length,
    unfinished: per.filter((m) => !m.complete).length,
  };
}

/* ---- flicker --------------------------------------------------------------------------------- */

export type FlickerMetrics = {
  shownWords: number;
  revisedWords: number;
  revisions: number;
  rate: number;
};

/**
 * How much shown text is taken back. Words are compared by position after `normaliseTranscript` (case and
 * punctuation are not flicker). A word counts as shown when it first appears at its position and as revised
 * when a later frame (the final text included) shows something else there, or nothing.
 */
export function flickerMetrics(partials: readonly string[], final?: string): FlickerMetrics {
  const frames = final === undefined ? partials : [...partials, final];
  let shown: string[] = [];
  let shownWords = 0;
  let revisedWords = 0;
  let revisions = 0;
  for (const frame of frames) {
    const tokens = normaliseTranscript(frame).split(" ").filter(Boolean);
    const changed = shown.filter((w, i) => i >= tokens.length || tokens[i] !== w).length;
    shownWords += tokens.filter((w, i) => i >= shown.length || shown[i] !== w).length;
    revisedWords += changed;
    if (changed) revisions += 1;
    shown = tokens;
  }
  return { shownWords, revisedWords, revisions, rate: shownWords ? revisedWords / shownWords : 0 };
}

export function aggregateFlicker(parts: readonly FlickerMetrics[]) {
  const shownWords = parts.reduce((sum, p) => sum + p.shownWords, 0);
  const revisedWords = parts.reduce((sum, p) => sum + p.revisedWords, 0);
  return {
    utterances: parts.length,
    shownWords,
    revisedWords,
    revisions: parts.reduce((sum, p) => sum + p.revisions, 0),
    rate: shownWords ? revisedWords / shownWords : 0,
  };
}

/* ---- corpus numbers, bootstrap and the regression gate --------------------------------------- */

type EditRow = { edits: number; words: number };
type BootstrapOptions = { seed?: number; draws?: number };

function rowsRatio(rows: readonly EditRow[]): number {
  return ratio(
    rows.reduce((sum, r) => sum + r.edits, 0),
    rows.reduce((sum, r) => sum + r.words, 0),
  );
}

/** Corpus rate (total edits over total words) with a 95% range from resampling the utterances; none below 2. */
export function bootstrapWer(rows: readonly EditRow[], options: BootstrapOptions = {}) {
  const estimate = rowsRatio(rows);
  if (rows.length < 2) return { estimate, low: null, high: null, n: rows.length };
  const next = seeded(options.seed ?? BOOTSTRAP_SEED);
  const n = rows.length;
  const out: number[] = [];
  for (let d = 0; d < (options.draws ?? BOOTSTRAP_DRAWS); d += 1) {
    out.push(rowsRatio(Array.from({ length: n }, () => rows[Math.floor(next() * n)]!)));
  }
  return { estimate, low: percentile(out, 2.5), high: percentile(out, 97.5), n };
}

export type PairedRow = EditRow & { id: string };
export type PairedResult = {
  delta: number;
  low: number | null;
  high: number | null;
  excludesZero: boolean;
  n: number;
};

/** Candidate minus baseline corpus rate over resampled utterances (the same picks for both runs). */
export function pairedBootstrap(
  baseline: readonly PairedRow[],
  candidate: readonly PairedRow[],
  options: BootstrapOptions = {},
): PairedResult {
  const ids = baseline.map((r) => r.id);
  const byId = new Map(candidate.map((r) => [r.id, r]));
  if (
    new Set(ids).size !== ids.length ||
    candidate.length !== byId.size ||
    ids.some((i) => !byId.has(i))
  ) {
    throw new Error("a paired comparison needs the same utterances in both runs");
  }
  const cand = ids.map((id) => byId.get(id)!);
  const delta = rowsRatio(cand) - rowsRatio(baseline);
  const n = baseline.length;
  if (n < 2) return { delta, low: null, high: null, excludesZero: false, n };
  const next = seeded(options.seed ?? BOOTSTRAP_SEED);
  const out: number[] = [];
  for (let d = 0; d < (options.draws ?? BOOTSTRAP_DRAWS); d += 1) {
    const picks = Array.from({ length: n }, () => Math.floor(next() * n));
    out.push(rowsRatio(picks.map((k) => cand[k]!)) - rowsRatio(picks.map((k) => baseline[k]!)));
  }
  const low = percentile(out, 2.5);
  const high = percentile(out, 97.5);
  return {
    delta,
    low,
    high,
    excludesZero: low !== null && high !== null && (low > EPS || high < -EPS),
    n,
  };
}

export type GateRow = PairedRow & { lang: string; violations?: number };
export type GateGroup = {
  baselineWer: number;
  candidateWer: number;
  delta: number;
  low: number | null;
  high: number | null;
  excludesZero: boolean;
  baselineViolations: number;
  candidateViolations: number;
  failed: boolean;
};

/**
 * Fail a candidate run against a baseline run over the same utterances. It fails when the folded WER is up by
 * more than `maxWerRise` AND the paired range excludes zero (a rise noise could explain does not fail), or when
 * the script-policy violations rose. The whole corpus and each language are judged, so one language cannot hide
 * in the total.
 */
export function regressionGate(
  baseline: readonly GateRow[],
  candidate: readonly GateRow[],
  options: BootstrapOptions & { maxWerRise?: number } = {},
): { pass: boolean; reasons: string[]; groups: Record<string, GateGroup> } {
  const sortedIds = (rows: readonly GateRow[]) => rows.map((r) => r.id).sort();
  if (JSON.stringify(sortedIds(baseline)) !== JSON.stringify(sortedIds(candidate))) {
    return { pass: false, reasons: ["the two runs must cover the same utterances"], groups: {} };
  }
  const maxRise = options.maxWerRise ?? DEFAULT_MAX_WER_RISE;
  const byId = new Map(candidate.map((r) => [r.id, r]));
  const langs = [...new Set(baseline.map((r) => r.lang))].sort();
  const groups: Record<string, GateGroup> = {};
  const reasons: string[] = [];
  for (const name of ["all", ...langs]) {
    const base = baseline.filter((r) => name === "all" || r.lang === name);
    const cand = base.map((r) => byId.get(r.id)!);
    const paired = pairedBootstrap(base, cand, options);
    const baseWords = base.reduce((sum, r) => sum + r.words, 0);
    const candWords = cand.reduce((sum, r) => sum + r.words, 0);
    const bv = base.reduce((sum, r) => sum + (r.violations ?? 0), 0);
    const cv = cand.reduce((sum, r) => sum + (r.violations ?? 0), 0);
    const werFailed = paired.delta > maxRise + EPS && paired.excludesZero;
    const violFailed = (candWords ? cv / candWords : 0) > (baseWords ? bv / baseWords : 0) + 1e-12;
    if (werFailed) {
      reasons.push(
        `${name}: folded WER up ${(paired.delta * 100).toFixed(1)} points (range ${((paired.low ?? 0) * 100).toFixed(1)} to ${((paired.high ?? 0) * 100).toFixed(1)}), limit ${(maxRise * 100).toFixed(1)}`,
      );
    }
    if (violFailed) reasons.push(`${name}: script-policy violations rose from ${bv} to ${cv}`);
    groups[name] = {
      baselineWer: rowsRatio(base),
      candidateWer: rowsRatio(cand),
      delta: paired.delta,
      low: paired.low,
      high: paired.high,
      excludesZero: paired.excludesZero,
      baselineViolations: bv,
      candidateViolations: cv,
      failed: werFailed || violFailed,
    };
  }
  return { pass: !reasons.length, reasons, groups };
}

/** Micro aggregation: totals first, then the rates, so a long sentence counts for more than a short one. */
export function aggregateCounts(
  rows: ReadonlyArray<FoldedCounts & { id?: string }>,
  options: BootstrapOptions = {},
) {
  const sum = (pick: (r: FoldedCounts) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const t = {
    words: sum((r) => r.words),
    edits: sum((r) => r.edits),
    hits: sum((r) => r.hits),
    subs: sum((r) => r.subs),
    dels: sum((r) => r.dels),
    ins: sum((r) => r.ins),
    chars: sum((r) => r.chars),
    charEdits: sum((r) => r.charEdits),
    strictEdits: sum((r) => r.strictEdits),
    devanagariToLatin: sum((r) => r.devanagariToLatin),
    latinToDevanagari: sum((r) => r.latinToDevanagari),
    violations: sum((r) => r.violations),
  };
  const ci = bootstrapWer(rows, options);
  const span = t.hits + t.edits;
  return {
    utterances: rows.length,
    ...t,
    strictWer: ratio(t.strictEdits, t.words),
    foldedWer: ratio(t.edits, t.words),
    foldedWerLow: ci.low,
    foldedWerHigh: ci.high,
    foldedCer: ratio(t.charEdits, t.chars),
    mer: span ? t.edits / span : 0,
    violationRate: t.words ? t.violations / t.words : 0,
  };
}
