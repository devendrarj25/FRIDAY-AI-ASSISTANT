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

/** Follow-up chain: at most this many accepted turns after one real wake. */
export const FOLLOW_CHAIN_TURNS = 3;
/** The chain also ends this long after the real wake, whatever the turn count. */
export const FOLLOW_CHAIN_MS = 60_000;
/** Follow-up listening time per turn when the caller gives none. */
export const DEFAULT_FOLLOW_MS = 8_000;

export type FollowChainReason = "ok" | "turn-cap" | "time-cap" | "scene-active" | "invalid";

export interface FollowChainInput {
  turnsSinceWake: number;
  lastRealWakeAt: number;
  nowMs: number;
  sceneActive: boolean;
  followMs?: number;
}

export interface FollowChainResult {
  open: boolean;
  untilMs: number;
  reason: FollowChainReason;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Pure: may the follow-up listening window stay open without a new wake word? */
export function followUpChainAllows(input: FollowChainInput): FollowChainResult {
  const i = (input ?? {}) as Partial<FollowChainInput>;
  if (!finite(i.nowMs) || !finite(i.lastRealWakeAt) || !finite(i.turnsSinceWake)) {
    return { open: false, untilMs: finite(i.nowMs) ? i.nowMs : 0, reason: "invalid" };
  }
  const followMs = finite(i.followMs) && i.followMs > 0 ? i.followMs : DEFAULT_FOLLOW_MS;
  const untilMs = Math.min(i.nowMs + followMs, i.lastRealWakeAt + FOLLOW_CHAIN_MS);
  if (i.sceneActive === true) return { open: false, untilMs, reason: "scene-active" };
  if (i.turnsSinceWake >= FOLLOW_CHAIN_TURNS) return { open: false, untilMs, reason: "turn-cap" };
  if (i.nowMs - i.lastRealWakeAt >= FOLLOW_CHAIN_MS) {
    return { open: false, untilMs, reason: "time-cap" };
  }
  return { open: true, untilMs, reason: "ok" };
}

export interface FollowChainState {
  turnsSinceWake: number;
  lastRealWakeAt: number;
}

export type FollowChainEvent =
  { type: "real-wake"; atMs: number } | { type: "accepted-turn" } | { type: "reset" };

export const INITIAL_FOLLOW_CHAIN: FollowChainState = { turnsSinceWake: 0, lastRealWakeAt: 0 };

/** Pure reducer: engine, accepted-transcript, personal and push-to-talk wakes all send "real-wake". */
export function nextChainState(state: FollowChainState, event: FollowChainEvent): FollowChainState {
  const s: FollowChainState = {
    turnsSinceWake: finite(state?.turnsSinceWake) ? state.turnsSinceWake : 0,
    lastRealWakeAt: finite(state?.lastRealWakeAt) ? state.lastRealWakeAt : 0,
  };
  switch (event?.type) {
    case "real-wake":
      return {
        turnsSinceWake: 0,
        lastRealWakeAt: finite(event.atMs) ? event.atMs : s.lastRealWakeAt,
      };
    case "accepted-turn":
      return { ...s, turnsSinceWake: s.turnsSinceWake + 1 };
    case "reset":
      return { ...INITIAL_FOLLOW_CHAIN };
    default:
      return s;
  }
}
