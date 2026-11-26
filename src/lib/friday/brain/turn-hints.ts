/**
 * FRIDAY · heard-turn hints for the Brain: the small, pure rules behind two things only.
 *
 *  1. Which language and script the reply should use, mirroring how the owner just spoke (Hindi in Devanagari,
 *     English in Latin, a mixed line answered in the same mix).
 *  2. A short clarifying question, instead of acting, when the ear was not sure what it heard.
 *
 * The hints are metadata about the words, never part of them, and they carry no authority: nothing here can
 * approve, confirm, unlock or widen anything, and the only effect of a hint is to say less or ask once. Only the
 * five fields below are ever read; any other property on the object the caller hands in is ignored, so a richer
 * turn record can be passed as it is and the rest never travels. Nothing here reads a store, a clock or the window.
 */

/** Below this ear confidence (0 to 1) a heard line is not acted on: the owner is asked once. Tunable. */
export const TURN_CONFIDENCE_FLOOR = 0.45;

/** A clipped line (cut at the length cap) may have lost words, so it needs this much more certainty. */
export const CLIPPED_FLOOR_BONUS = 0.1;

/** After one clarifying question the next turn is taken as heard, so the owner is never asked twice in a row. */
export const CLARIFY_WINDOW_MS = 30_000;

/** Beyond this share of the minority script the line is a real mix and is answered in a mix. */
export const MIX_REPLY_SHARE = 0.15;

const HEARD_ECHO_CHARS = 80;

export type TurnHintLang = "hi" | "en" | "hi-en" | "";

/** The five fields the Brain accepts. Every one is optional input metadata. */
export type TurnHints = {
  lang: TurnHintLang;
  mix: number;
  confidence: number | null;
  eager: boolean;
  clipped: boolean;
};

const LANGS: readonly TurnHintLang[] = ["hi", "en", "hi-en", ""];

/** Copy the five known fields out of whatever came in, with safe types. Anything else is dropped. */
export function cleanTurnHints(raw: unknown): TurnHints | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const lang = LANGS.includes(source["lang"] as TurnHintLang)
    ? (source["lang"] as TurnHintLang)
    : "";
  const mixValue = source["mix"];
  const mix =
    typeof mixValue === "number" && Number.isFinite(mixValue)
      ? Math.max(0, Math.min(1, mixValue))
      : 0;
  const confidenceValue = source["confidence"];
  const confidence =
    typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
      ? Math.max(0, Math.min(1, confidenceValue))
      : null;
  return {
    lang,
    mix,
    confidence,
    eager: source["eager"] === true,
    clipped: source["clipped"] === true,
  };
}

/**
 * The reply-language line for this turn, or "" when the hints say nothing usable or the owner pinned a reply
 * language in Settings (a pinned choice always wins over what one line sounded like).
 */
export function replyLanguageLine(hints: TurnHints | null, pinned: boolean): string {
  if (!hints || pinned) return "";
  if (hints.lang === "hi-en") {
    return hints.mix >= MIX_REPLY_SHARE
      ? "Reply language for this turn: the owner mixed Hindi and English, so answer in the same natural Hindi and English mix. Write Hindi words in Devanagari and English words in Latin, and never transliterate either. Keep technical terms, paths, commands and code in English."
      : "Reply language for this turn: the owner spoke mostly one language with a few words of the other. Answer in that main language and keep the few borrowed words as they were said.";
  }
  if (hints.lang === "hi") {
    return "Reply language for this turn: Hindi, written in Devanagari. Keep technical terms, paths, commands and code in English.";
  }
  if (hints.lang === "en") {
    return "Reply language for this turn: English, written in Latin script.";
  }
  return "";
}

/** True when the ear was not sure enough for this line to be acted on. An unknown confidence never blocks. */
export function needsClarification(
  hints: TurnHints | null,
  floor: number = TURN_CONFIDENCE_FLOOR,
): boolean {
  if (!hints || hints.confidence === null) return false;
  const bar = hints.clipped ? Math.min(1, floor + CLIPPED_FLOOR_BONUS) : floor;
  return hints.confidence < bar;
}

/** One short question in the owner's language: what was heard, and a request to say it again. */
export function clarificationLine(hints: TurnHints | null, heard: string): string {
  const trimmed = String(heard ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const echo =
    trimmed.length > HEARD_ECHO_CHARS
      ? `${trimmed.slice(0, HEARD_ECHO_CHARS).trimEnd()}…`
      : trimmed;
  const hindi = hints?.lang === "hi" || hints?.lang === "hi-en";
  if (hindi) {
    return echo
      ? `मुझे ठीक से सुनाई नहीं दिया। क्या आपने कहा: “${echo}”? कृपया एक बार फिर बताइए।`
      : "मुझे ठीक से सुनाई नहीं दिया। कृपया एक बार फिर बताइए।";
  }
  return echo
    ? `I didn't catch that clearly. Did you say “${echo}”? Please say it once more.`
    : "I didn't catch that clearly. Please say it once more.";
}
