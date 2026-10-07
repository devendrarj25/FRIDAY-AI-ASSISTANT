/**
 * FRIDAY · voice attention window.
 *
 * How long Auto Mode keeps accepting follow-ups after a wake word, before the
 * owner has to call her again. It used to be a hard-coded constant inside
 * assistant-mode.ts; it is now one owner-visible setting living in the same
 * preferences store the Settings page writes, so chat, voice and any
 * conversational change all read exactly the same number.
 */
import { preferences } from "./preferences";

export const ATTENTION_FIELD = "attentionWindow";
export const DEFAULT_ATTENTION_SEC = 45;
export const MIN_ATTENTION_SEC = 10;
export const MAX_ATTENTION_SEC = 300;

export function clampAttentionSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ATTENTION_SEC;
  return Math.min(MAX_ATTENTION_SEC, Math.max(MIN_ATTENTION_SEC, Math.round(value)));
}

/** The live setting in seconds — always a usable number. */
export function attentionWindowSeconds(): number {
  try {
    const raw = preferences.getSnapshot().fields[ATTENTION_FIELD];
    const parsed = Number.parseInt(String(raw ?? ""), 10);
    return Number.isNaN(parsed) ? DEFAULT_ATTENTION_SEC : clampAttentionSeconds(parsed);
  } catch {
    return DEFAULT_ATTENTION_SEC;
  }
}

/** The same value in milliseconds, for the voice session timers. */
export const attentionWindowMs = (): number => attentionWindowSeconds() * 1000;
