import { readLocalState, writeState } from "./persist";

export type Correction = { from: string; to: string };

/**
 * What the owner corrected, kept across restarts: a word the recogniser keeps getting wrong should not have to
 * be taught again after every launch. The store is the same one `STORE` always was, now read from and saved to
 * local state. A secret is never kept (see `learnCorrection`).
 */
const KEY = "friday.asr-corrections.v1";
const STORE: Correction[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  const stored = readLocalState<Correction[]>(KEY);
  if (!Array.isArray(stored)) return;
  for (const row of stored.slice(-40)) {
    if (row && typeof row.from === "string" && typeof row.to === "string")
      STORE.push({ from: row.from, to: row.to });
  }
}

const save = () => writeState(KEY, STORE);

export function resetCorrections(): void {
  loaded = true;
  STORE.length = 0;
  save();
}

export function biasPrompt(vocab: readonly string[], base: string): string {
  const words = vocab
    .map((word) => String(word || "").trim())
    .filter((word) => word.length > 1 && word.length < 40)
    .slice(0, 24);
  if (!words.length) return base;
  return `${base} Names and apps: ${words.join(", ")}.`;
}

export function learnCorrection(heard: string, fixed: string): Correction | null {
  const from = String(heard || "")
    .trim()
    .toLowerCase();
  const to = String(fixed || "").trim();
  if (!from || !to || from === to.toLowerCase()) return null;
  if (/password|token|api[_-]?key/i.test(`${from} ${to}`)) return null;
  load();
  const row = { from, to };
  // The same mishearing taught again replaces the old fix instead of piling up.
  const at = STORE.findIndex((existing) => existing.from === from);
  if (at >= 0) STORE.splice(at, 1);
  STORE.push(row);
  if (STORE.length > 40) STORE.shift();
  save();
  return row;
}

export function applyCorrections(text: string, pairs?: readonly Correction[]): string {
  load();
  let next = String(text || "");
  const list = pairs ?? STORE;
  for (const pair of list) {
    if (!pair.from) continue;
    const escaped = pair.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(escaped, "ig"), pair.to);
  }
  return next;
}

export function languageId(text: string): "en" | "hi" | "hinglish" {
  const value = String(text || "");
  const devanagari = /[\u0900-\u097F]/.test(value);
  const latin = /[A-Za-z]/.test(value);
  if (devanagari && latin) return "hinglish";
  if (devanagari) return "hi";
  if (/\b(yaar|nahi|karo|baje|mujhe|kholo)\b/i.test(value)) return "hinglish";
  return "en";
}

/** What the speech model itself reported about an utterance. Any part may be missing. */
export type HeardQuality = {
  /** Average log probability per token of the chosen words: near 0 is sure, below -1 is a guess. */
  avgLogprob?: number | null;
  /** How sure the model was of the language it decoded in (0..1). */
  languageProbability?: number | null;
  language?: string;
};

/**
 * How far to trust what was heard. The words alone say little (a made-up sentence is as fluent as a real one), so the
 * model's own scores count: a weak per-token probability, or a weak language guess, lowers the number. With no scores
 * the text rule below is all there is.
 */
export function heardConfidence(text: string, quality?: HeardQuality | null): number {
  let value = utteranceConfidence(text);
  const lp = quality?.avgLogprob;
  if (typeof lp === "number") {
    if (lp <= -1.0) value = Math.min(value, 0.4);
    else if (lp <= -0.7) value = Math.min(value, 0.6);
    else if (lp <= -0.5) value = Math.min(value, 0.8);
  }
  const lang = quality?.languageProbability;
  if (typeof lang === "number") {
    if (lang < 0.7) value = Math.min(value, 0.6);
    else if (lang < 0.85) value = Math.min(value, 0.75);
  }
  return Math.round(value * 100) / 100;
}

/** One line for the diagnostics: what the model reported, and what was done about it. */
export function heardQualityLine(quality: HeardQuality | null | undefined, text = ""): string {
  if (!quality) return "no utterance heard yet";
  const lang = quality.language || "?";
  const prob =
    typeof quality.languageProbability === "number" ? quality.languageProbability.toFixed(2) : "?";
  const lp = typeof quality.avgLogprob === "number" ? quality.avgLogprob.toFixed(2) : "?";
  const sure = heardConfidence(text, quality);
  return `language ${lang} (${prob}) · token score ${lp} · trust ${sure.toFixed(2)}${
    sure < CONFIRM_BELOW ? " · read back before acting" : ""
  }`;
}

/**
 * A small speech model is the usual reason Hindi and Hinglish come out as other words. Say so when the owner's language
 * is not plain English and the model in use is tiny or base.
 */
export function speechModelHint(model: string, recognitionLang: string): string {
  const name =
    String(model || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop() ?? "";
  const small = /^(tiny|base)(\.en)?$/i.test(name);
  const lang = String(recognitionLang || "").toLowerCase();
  const mixed =
    !lang ||
    lang === "auto" ||
    lang === "mixed" ||
    lang.startsWith("hi") ||
    lang.startsWith("en-in");
  if (!small || !mixed) return "";
  return `the ${name} model is small for Hindi and Hinglish, so words can come out wrong: choose small or larger in Voice settings`;
}

/** Below this the words are read back before anything is done with them. */
export const CONFIRM_BELOW = 0.65;

/**
 * Should she read the words back and wait for a yes? Only for something she was about to act on, and only when the model
 * itself was unsure. A stop command is never held up.
 */
export function needsHeardConfirmation(
  text: string,
  quality: HeardQuality | null | undefined,
  isStop = false,
): boolean {
  if (isStop || !String(text || "").trim()) return false;
  return heardConfidence(text, quality) < CONFIRM_BELOW;
}

/** The read-back, in the language the words were in. */
export function heardReadBack(text: string): string {
  const clean = String(text || "")
    .trim()
    .slice(0, 90);
  const lang = languageId(clean);
  if (lang === "hi") return `क्या आपने कहा: “${clean}”?`;
  if (lang === "hinglish") return `Kya aapne kaha: “${clean}”? Haan ya nahi bolo.`;
  return `Did you say “${clean}”? Say yes or no.`;
}

/** A repeated word or a very long token is a weak read. Everything else is trusted. */
export function utteranceConfidence(text: string): number {
  const value = String(text || "").trim();
  if (/\b(\w+)\s+\1\b/i.test(value)) return 0.5;
  if (/\b\w{18,}\b/.test(value)) return 0.5;
  return 0.9;
}

/** Ask again only when the guess is weak and the phrase is short enough to repeat. */
export function confidenceRepeat(text: string, confidence: number): string | null {
  const clean = String(text || "").trim();
  if (!clean || confidence >= 0.72 || clean.length > 80) return null;
  if (confidence < 0.35) return null;
  return `Did you say “${clean.slice(0, 60)}”?`;
}
