export type Correction = { from: string; to: string };

const STORE: Correction[] = [];

export function resetCorrections(): void {
  STORE.length = 0;
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
  const row = { from, to };
  STORE.push(row);
  if (STORE.length > 40) STORE.shift();
  return row;
}

export function applyCorrections(text: string, pairs: readonly Correction[] = STORE): string {
  let next = String(text || "");
  for (const pair of pairs) {
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
