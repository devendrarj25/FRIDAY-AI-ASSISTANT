/**
 * FRIDAY · local-model transcript clean-up guard (hidden, off by default, not wired yet).
 *
 * FRIDAY Tidy (`transcript-tidy.ts`) is the deterministic cleaner and always runs first. This module is an optional
 * second pass: a small LOCAL model, injected by the caller as `LocalClean`, may polish the Tidy text (spacing, a
 * missing danda, casing). The module owns only the guard around that call and imports no brain, no network and no
 * model, so a cloud route cannot exist here. It runs after the end of turn at the lowest priority: the command that
 * goes to the Brain is the Tidy or raw text, and the cleaned text only improves the shown caption and the saved
 * transcript line. A result that arrives after a newer turn started is dropped (`isStale`).
 *
 * The model output is data, never an instruction: it is accepted only when every check below holds, and otherwise the
 * Tidy text stays and `why` names the check. A line that looks private is never sent to the model.
 *   format    no bracket tags, URLs, code fences, hidden control marks or extra lines that Tidy did not have
 *   script    Hindi stays Devanagari and English stays Latin (the script policy is the same as before)
 *   digits    the digits are the same, in the same count
 *   numbers   the number words (five, पाँच, paanch) are the same, in the same count
 *   negation  not, nahi, नहीं, मत ... are the same, in the same count
 *   name      no new capitalised name appears
 *   length    the length ratio is between 0.7 and 1.4
 *   edits     at most 35 percent of the words changed
 * `changes` lists every replaced span and `undoCleanup` puts the Tidy spans back; `raw` is always the heard text.
 */
import { looksSensitive } from "./hotwords";
import { scriptPolicy } from "./language-segmenter";
import { checkScriptPolicy } from "./script-policy";

export type CleanLang = "hi" | "en" | "hinglish";
export type LocalClean = (input: {
  text: string;
  lang: CleanLang;
  timeoutMs: number;
}) => Promise<string | null>;

export type CleanupWhy =
  | "sensitive"
  | "short"
  | "long"
  | "timeout"
  | "error"
  | "stale"
  | "no-answer"
  | "format"
  | "script"
  | "digits"
  | "numbers"
  | "negation"
  | "name"
  | "length"
  | "edits";

export type CleanupChange = { from: string; to: string };
export type CleanupResult = {
  text: string;
  usedModel: boolean;
  reverted: boolean;
  why?: CleanupWhy;
  raw: string;
  changes: CleanupChange[];
};
export type CleanupOptions = {
  /** The setting. Anything but `true` is off by default; `false` is off explicitly. */
  enabled?: boolean;
  lang?: CleanLang;
  timeoutMs?: number;
  /** The caller's own privacy check (the brain classifier), added to the built-in one. A throw counts as private. */
  isSensitive?: (text: string) => boolean;
  /** True when a newer turn started; a late answer is then dropped. */
  isStale?: () => boolean;
};

export const CLEANUP_DEFAULT_TIMEOUT_MS = 2000;
export const CLEANUP_MIN_WORDS = 4;
/** A caption line, not a document: longer text is never sent to the model. */
export const CLEANUP_MAX_CHARS = 2000;
export const CLEANUP_LENGTH_MIN = 0.7;
export const CLEANUP_LENGTH_MAX = 1.4;
export const CLEANUP_EDIT_MAX = 0.35;
const TIMEOUT_CEILING_MS = 10_000;

const WORD = /[\p{L}\p{M}\p{Nd}]+(?:['’][\p{L}]+)?/gu;
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;

/** Nukta, joiners and chandrabindu folded, so "हज़ार" and "हजार", "पाँच" and "पांच" compare equal. */
const fold = (s: string): string =>
  s.normalize("NFC").toLowerCase().replace(/[़‌‍]/g, "").replace(/ँ/g, "ं").replace(/’/g, "'");
const words = (s: string): string[] => (s.match(WORD) ?? []).map(fold);

const asciiDigits = (s: string): string =>
  s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966));

const NUMBER_WORDS = new Set(
  (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen " +
    "eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand lakh crore million billion " +
    "ek teen char paanch panch chhe chheh saat aath nau das gyarah barah terah chaudah pandrah solah satrah atharah " +
    "unnis bees tees chalis pachas saath sattar assi nabbe sau hazaar hazar " +
    "एक दो तीन चार पांच छह छः सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस तीस चालीस " +
    "पचास साठ सत्तर अस्सी नब्बे सौ हजार लाख करोड"
  )
    .split(" ")
    .map(fold),
);

const NEGATIONS = new Set(
  (
    "not no never none nothing nobody nowhere neither nor cannot without dont doesnt didnt wont cant isnt arent wasnt " +
    "werent shouldnt couldnt wouldnt nahi nahin nhi mat bina " +
    "नहीं नही मत न बिना"
  )
    .split(" ")
    .map(fold),
);
const isNegation = (w: string): boolean => NEGATIONS.has(w) || w.endsWith("n't");

function counts(list: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  const ca = counts(a);
  const cb = counts(b);
  if (ca.size !== cb.size) return false;
  for (const [k, n] of ca) if (cb.get(k) !== n) return false;
  return true;
}

const BRACKETS = /[<>[\]{}]/;
const URLISH = /:\/\/|\bwww\.|\b[\w-]+\.(?:com|org|net|in|io|dev|app|co|me|ai)\b/i;
const FENCE = /`/;
/** A control character, a zero-width mark or a bidi override that could hide text from the owner. */
const HIDDEN_CODES = new Set([0x200b, 0x200e, 0x200f, 0xfeff]);
function hiddenMark(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 ? c !== 0x09 && c !== 0x0a && c !== 0x0d : false) return true;
    if (HIDDEN_CODES.has(c) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
      return true;
  }
  return false;
}
const lines = (s: string): number => (s.match(/\n/g) ?? []).length;

function formatBroken(tidy: string, out: string): boolean {
  const added = (re: RegExp): boolean => re.test(out) && !re.test(tidy);
  return (
    added(BRACKETS) ||
    added(URLISH) ||
    added(FENCE) ||
    (hiddenMark(out) && !hiddenMark(tidy)) ||
    lines(out) !== lines(tidy)
  );
}

type Signature = { lang: string; deva: boolean; latin: boolean; violations: number };
function signature(text: string, lang: CleanLang): Signature {
  return {
    lang: scriptPolicy(text).lang,
    deva: /[ऀ-ॣॱ-ॿ]/u.test(text),
    latin: /[A-Za-z]/.test(text),
    violations: checkScriptPolicy(text, lang).violations.length,
  };
}
function scriptChanged(tidy: string, out: string, lang: CleanLang): boolean {
  const a = signature(tidy, lang);
  const b = signature(out, lang);
  return (
    a.lang !== b.lang || a.deva !== b.deva || a.latin !== b.latin || b.violations > a.violations
  );
}

function newName(tidy: string, out: string): boolean {
  const known = new Set(words(tidy));
  return (out.match(WORD) ?? []).some((w) => /^[A-Z]/.test(w) && !known.has(fold(w)));
}

/** Word-level Levenshtein distance. */
function editDistance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, (prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** Why the model text must not replace Tidy, or null when it may. */
function refusal(tidy: string, out: string, lang: CleanLang): CleanupWhy | null {
  if (formatBroken(tidy, out)) return "format";
  if (scriptChanged(tidy, out, lang)) return "script";
  const digits = (s: string): string[] => (s.match(NUMBER) ?? []).map(asciiDigits);
  if (!sameMultiset(digits(tidy), digits(out))) return "digits";
  const a = words(tidy);
  const b = words(out);
  if (
    !sameMultiset(
      a.filter((w) => NUMBER_WORDS.has(w)),
      b.filter((w) => NUMBER_WORDS.has(w)),
    )
  )
    return "numbers";
  if (!sameMultiset(a.filter(isNegation), b.filter(isNegation))) return "negation";
  if (newName(tidy, out)) return "name";
  const ratio = out.length / Math.max(1, tidy.length);
  if (ratio < CLEANUP_LENGTH_MIN || ratio > CLEANUP_LENGTH_MAX) return "length";
  if (editDistance(a, b) / Math.max(1, a.length, b.length) > CLEANUP_EDIT_MAX) return "edits";
  return null;
}

type Chunk = { text: string; start: number; end: number };
const chunks = (s: string): Chunk[] =>
  [...s.matchAll(/\S+/g)].map((m) => ({
    text: m[0],
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));

/** The replaced spans, as exact substrings. A pure insert or delete carries one neighbouring word so `to` is never empty. */
function diffSpans(tidy: string, out: string): CleanupChange[] {
  if (tidy === out) return [];
  const a = chunks(tidy);
  const b = chunks(out);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[i]!.text === b[j]!.text
          ? (lcs[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }
  type Run = { a0: number; a1: number; b0: number; b1: number };
  const runs: Run[] = [];
  let i = 0;
  let j = 0;
  let open: Run | null = null;
  const close = (): void => {
    if (open) runs.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.text === b[j]!.text) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    open ??= { a0: i, a1: i, b0: j, b1: j };
    if (j >= m || (i < n && (lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0))) i += 1;
    else j += 1;
    open.a1 = i;
    open.b1 = j;
  }
  close();
  for (const r of runs) {
    if (r.a0 < r.a1 && r.b0 < r.b1) continue;
    if (r.a0 > 0) {
      r.a0 -= 1;
      r.b0 -= 1;
    } else {
      r.a1 += 1;
      r.b1 += 1;
    }
  }
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.a0 <= last.a1) {
      last.a1 = Math.max(last.a1, r.a1);
      last.b1 = Math.max(last.b1, r.b1);
    } else merged.push({ ...r });
  }
  const spans = merged.map((r) => ({
    from: tidy.slice(a[r.a0]!.start, a[r.a1 - 1]!.end),
    to: out.slice(b[r.b0]!.start, b[r.b1 - 1]!.end),
  }));
  // Only spacing differs: one span that holds the whole line.
  return spans.length > 0 ? spans : [{ from: tidy, to: out }];
}

/** Put the Tidy spans back, in order. Returns the text unchanged when a span cannot be found. */
export function undoCleanup(text: string, changes: readonly CleanupChange[]): string {
  let result = text;
  let cursor = 0;
  for (const c of changes) {
    const at = c.to ? result.indexOf(c.to, cursor) : -1;
    if (at < 0) return text;
    result = result.slice(0, at) + c.from + result.slice(at + c.to.length);
    cursor = at + c.from.length;
  }
  return result;
}

const TIMEOUT = Symbol("timeout");
const FAILED = Symbol("failed");

function race(run: LocalClean, text: string, lang: CleanLang, ms: number) {
  return new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve(TIMEOUT), ms);
    const done = (v: unknown): void => {
      clearTimeout(timer);
      resolve(v);
    };
    try {
      Promise.resolve(run({ text, lang, timeoutMs: ms })).then(done, () => done(FAILED));
    } catch {
      done(FAILED);
    }
  });
}

function privateLine(text: string, injected: CleanupOptions["isSensitive"]): boolean {
  if (looksSensitive(text)) return true;
  if (!injected) return false;
  try {
    return injected(text) !== false;
  } catch {
    return true;
  }
}

function languageOf(tidy: string): CleanLang {
  const p = scriptPolicy(tidy);
  return p.lang === "hi" ? "hi" : p.lang === "mixed" || p.romanHindi ? "hinglish" : "en";
}

/**
 * Polish the Tidy text with an injected local model, or keep it. `raw` is the heard text, `tidy` the FRIDAY Tidy
 * text; the result never carries anything the guard did not check, and `raw` is always returned as given.
 */
export async function cleanWithLocalModel(
  raw: string,
  tidy: string,
  run: LocalClean | null,
  opts: CleanupOptions = {},
): Promise<CleanupResult> {
  const keep = (reverted: boolean, usedModel: boolean, why?: CleanupWhy): CleanupResult => ({
    text: tidy,
    usedModel,
    reverted,
    ...(why ? { why } : {}),
    raw,
    changes: [],
  });
  if (!run || opts.enabled === false) return keep(false, false);
  const line = String(tidy ?? "");
  if (privateLine(line, opts.isSensitive) || privateLine(String(raw ?? ""), opts.isSensitive))
    return keep(true, false, "sensitive");
  if (words(line).length < CLEANUP_MIN_WORDS) return keep(true, false, "short");
  if (line.length > CLEANUP_MAX_CHARS) return keep(true, false, "long");
  const lang = opts.lang ?? languageOf(line);
  const asked = Number(opts.timeoutMs);
  const ms = Math.min(
    TIMEOUT_CEILING_MS,
    Number.isFinite(asked) && asked > 0 ? asked : CLEANUP_DEFAULT_TIMEOUT_MS,
  );
  const answer = await race(run, line, lang, ms);
  if (answer === TIMEOUT) return keep(true, true, "timeout");
  if (answer === FAILED) return keep(true, true, "error");
  if (opts.isStale?.()) return keep(true, true, "stale");
  const out = typeof answer === "string" ? answer.trim() : "";
  if (!out) return keep(true, true, "no-answer");
  if (out === line) return keep(false, true);
  const why = refusal(line, out, lang);
  if (why) return keep(true, true, why);
  return { text: out, usedModel: true, reverted: false, raw, changes: diffSpans(line, out) };
}
