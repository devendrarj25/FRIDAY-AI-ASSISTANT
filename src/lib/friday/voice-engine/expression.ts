/**
 * FRIDAY · spoken expression: a little life in each clause.
 *
 * The same sentence reads differently as a question, an apology, a greeting or good news. This looks at one
 * clause (English, Hindi in Devanagari, or Hinglish in Latin letters) and returns small, bounded changes to the
 * speaking rate, pitch and volume, plus the pause that should follow it. The changes are multipliers on top of
 * the owner's own voice settings, kept within a few percent so the voice stays the same person and never
 * sounds exaggerated. Pure text in, numbers out.
 */

export type Expression = {
  kind: "question" | "exclaim" | "empathy" | "greeting" | "thanks" | "short" | "plain";
  rate: number;
  pitch: number;
  volume: number;
  /** Silence after this clause, in ms. */
  pauseAfterMs: number;
};

const QUESTION_LEAD =
  /^\s*(kya|kaise|kaisa|kaisi|kyun|kyu|kab|kahan|kaun|kitna|kitne|kitni|kis|kaunsa|what|why|how|when|where|who|which|can|could|would|do|does|did|is|are|क्या|कैसे|कैसा|कैसी|क्यों|कब|कहाँ|कहां|कौन|कितना|कितने|कितनी)\b/i;
const EMPATHY =
  /\b(sorry|apologi[sz]e|afsos|maaf|maafi|khed|dukh|unfortunately|i'?m sorry|sad|takleef|pareshan)\b|माफ़?|दुख|अफ़?सोस|खेद|परेशान/i;
const GREETING =
  /\b(namaste|namaskar|hello|hi there|hey|good (morning|evening|afternoon)|welcome|suprabhat|shubh)\b|नमस्ते|नमस्कार|स्वागत|शुभ/i;
const THANKS =
  /\b(thank you|thanks|shukriya|dhanyavad|dhanyawad|meherbani)\b|शुक्रिया|धन्यवाद|मेहरबानी/i;
const GOOD_NEWS =
  /\b(done|ready|great|perfect|wonderful|congratulations|badhai|mubarak|zabardast)\b|बधाई|मुबारक|शानदार/i;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));
const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** Silence that follows the closing mark of a clause. */
export function pauseAfter(text: string): number {
  const tail = text.trim().slice(-1);
  if (tail === "?") return 180;
  if (tail === "." || tail === "!" || tail === "।" || tail === "…") return 150;
  if (tail === ";" || tail === ":" || tail === "—") return 110;
  if (tail === ",") return 60;
  return 0;
}

export function expressionFor(text: string): Expression {
  const clause = text.trim();
  const base = { rate: 1, pitch: 1, volume: 1, pauseAfterMs: pauseAfter(clause) };
  if (!clause) return { kind: "plain", ...base };
  const question = /\?\s*$/.test(clause) || QUESTION_LEAD.test(clause);
  if (EMPATHY.test(clause)) {
    return {
      kind: "empathy",
      ...base,
      rate: 0.93,
      pitch: 0.97,
      volume: 0.94,
      pauseAfterMs: base.pauseAfterMs + 40,
    };
  }
  if (question && /\?\s*$/.test(clause)) {
    return { kind: "question", ...base, rate: 1, pitch: 1.04 };
  }
  if (/!\s*$/.test(clause) || GOOD_NEWS.test(clause)) {
    return { kind: "exclaim", ...base, rate: 1.04, pitch: 1.05, volume: 1.02 };
  }
  if (GREETING.test(clause)) return { kind: "greeting", ...base, rate: 0.98, pitch: 1.03 };
  if (THANKS.test(clause))
    return { kind: "thanks", ...base, rate: 0.97, pitch: 1.02, volume: 0.97 };
  if (wordCount(clause) <= 3) return { kind: "short", ...base, rate: 1.03 };
  return { kind: "plain", ...base };
}

/** Apply an expression to the owner's settings, never leaving a safe range. */
export function applyExpression(
  tuning: { rate: number; pitch: number; volume: number },
  expression: Expression,
): { rate: number; pitch: number; volume: number } {
  return {
    rate: clamp(tuning.rate * expression.rate, 0.6, 1.6),
    pitch: clamp(tuning.pitch * expression.pitch, 0.5, 1.6),
    volume: clamp(tuning.volume * expression.volume, 0, 1),
  };
}
