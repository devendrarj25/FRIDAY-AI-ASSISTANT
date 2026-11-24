/**
 * Push-to-talk inside Auto mode.
 *
 * Auto mode stays the only microphone session. The listen style decides which
 * utterances reach the transcriber:
 *   always        every utterance the VAD finds (today's behaviour, the default)
 *   push-to-talk  only speech that starts while the key is held, or while the
 *                 global toggle is on. Nothing else is transcribed.
 *
 * Hold works in the FRIDAY window (Ctrl+Space). The global shortcut
 * (Ctrl+Alt+Space) toggles, because a global shortcut reports a press and no
 * release. A turn opened this way is addressed to FRIDAY: no wake word needed.
 *
 * Quality of a hold:
 *   - The segment starts PRE_ROLL_MS (the one pre-roll of the capture ring) before the key went down, so a first
 *     syllable spoken as the finger lands is kept.
 *   - After release the capture runs on for a tail (default 350 ms, 100 to 800), so the last word is not cut,
 *     then the turn is finalised. The phase is "listening" while the key is down and "finishing" in the tail.
 *   - A tap shorter than PTT_TAP_MS is a slip and opens nothing. Key repeat does not restart a hold. Losing
 *     focus ends the hold. A hold whose key-up never arrived ends after PTT_HOLD_MAX_MS.
 *   - Mute, pause, Stop everything and leaving Auto call `pttCloseNow`: the hold and the tail end at once.
 *     `pttSetAllowed(false)` keeps a press from opening anything until Auto may listen again.
 */
import { PRE_ROLL_MS } from "./pcm-capture";
import { hangoverFrames } from "./speech-vad";

export type ListenStyle = "always" | "push-to-talk";
export type PttPhase = "idle" | "listening" | "finishing";

export const PTT_HOLD_KEY = "Ctrl+Space";
export const PTT_TOGGLE_ACCELERATOR = "Control+Alt+Space";
/** Speech that began just after release still belongs to the press. */
export const PTT_GRACE_MS = 1200;
/** A forgotten toggle closes itself. */
export const PTT_TOGGLE_MAX_MS = 60_000;
/** A press shorter than this is a slip of the finger and opens nothing. */
export const PTT_TAP_MS = 250;
/** A key-up that never came (focus lost to another app) ends the hold here. */
export const PTT_HOLD_MAX_MS = 120_000;
/** Capture that keeps running after release so the last word is whole. */
export const PTT_TAIL_DEFAULT_MS = 350;
export const PTT_TAIL_MIN_MS = 100;
export const PTT_TAIL_MAX_MS = 800;
/** The audio kept before the key went down is the capture ring's pre-roll, in one place. */
export const PTT_PRE_ROLL_MS = PRE_ROLL_MS;

type State = {
  held: boolean;
  pressedAt: number;
  releasedAt: number;
  toggledAt: number;
  taps: number;
};

const FRESH: State = { held: false, pressedAt: 0, releasedAt: 0, toggledAt: 0, taps: 0 };

let state: State = FRESH;
let tailMs = PTT_TAIL_DEFAULT_MS;
let allowed = true;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function normalizeListenStyle(value: unknown): ListenStyle {
  return value === "push-to-talk" ? "push-to-talk" : "always";
}

/** The release tail from a stored value: a number inside 100 to 800 ms, else the default. */
export function normalizePttTailMs(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return PTT_TAIL_DEFAULT_MS;
  return Math.min(PTT_TAIL_MAX_MS, Math.max(PTT_TAIL_MIN_MS, Math.round(n)));
}

export function setPttTailMs(value: unknown): number {
  tailMs = normalizePttTailMs(value);
  return tailMs;
}

/**
 * The tail in use. It is never shorter than the closing hangover of the language, so a Hindi pause inside a word
 * is not cut by a short tail (same frames as the VAD endpoint in `speech-vad.ts`, 10 ms each).
 */
export function pttTailMs(language = "en"): number {
  return Math.max(tailMs, hangoverFrames(language) * 10);
}

/** Auto may listen (not muted, not paused, not stopped). While false a press or toggle opens nothing. */
export function pttSetAllowed(value: boolean): void {
  if (allowed === value) return;
  allowed = value;
  if (!value) state = { ...FRESH, taps: state.taps };
  emit();
}

export function pttPress(now = Date.now()): void {
  if (!allowed || state.held) return;
  state = { ...state, held: true, pressedAt: now };
  emit();
}

export function pttRelease(now = Date.now()): void {
  if (!state.held) return;
  const heldMs = now - state.pressedAt;
  if (heldMs >= 0 && heldMs < PTT_TAP_MS) {
    state = { ...state, held: false, pressedAt: 0, taps: state.taps + 1 };
  } else {
    state = { ...state, held: false, releasedAt: now };
  }
  emit();
}

/** The window lost focus, so a key-up will not arrive: the hold ends like a release. */
export function pttFocusLost(now = Date.now()): void {
  pttRelease(now);
}

/** Global shortcut: one press opens, the next press closes. */
export function pttToggle(now = Date.now()): boolean {
  if (!allowed) return false;
  const open = !toggleOpen(now);
  state = { ...state, toggledAt: open ? now : 0, releasedAt: open ? state.releasedAt : now };
  emit();
  return open;
}

/** Mute, pause, Stop everything, leaving Auto: the hold, the toggle, the tail and the grace end now. */
export function pttCloseNow(): void {
  if (!state.held && state.toggledAt === 0 && state.releasedAt === 0) return;
  state = { ...FRESH, taps: state.taps };
  emit();
}

function toggleOpen(now: number): boolean {
  return state.toggledAt > 0 && now - state.toggledAt < PTT_TOGGLE_MAX_MS;
}

function holdLive(now: number): boolean {
  return state.held && now - state.pressedAt < PTT_HOLD_MAX_MS;
}

/** True while the talk key is down or the toggle is on. */
export function pttActive(now = Date.now()): boolean {
  return holdLive(now) || toggleOpen(now);
}

/** The moment the key, the toggle or a stuck hold last stopped counting, or 0. */
function lastClosedAt(): number {
  let closed = state.held ? 0 : state.releasedAt;
  if (state.held && state.pressedAt > 0)
    closed = Math.max(closed, state.pressedAt + PTT_HOLD_MAX_MS);
  if (state.toggledAt > 0) closed = Math.max(closed, state.toggledAt + PTT_TOGGLE_MAX_MS);
  return closed;
}

/** True from the key going down until the release tail is over: the segment stays open, then it is finalised. */
export function pttCapturing(now = Date.now(), language = "en"): boolean {
  if (pttActive(now)) return true;
  const closed = lastClosedAt();
  return closed > 0 && now >= closed && now - closed < pttTailMs(language);
}

/** The phase the voice status shows: listening while held, finishing in the tail, else idle. */
export function pttPhase(now = Date.now(), language = "en"): PttPhase {
  if (pttActive(now)) return "listening";
  return pttCapturing(now, language) ? "finishing" : "idle";
}

/** How long ago the key went down (0 when it is not down). A segment starts `PTT_PRE_ROLL_MS` before that. */
export function pttHeldForMs(now = Date.now()): number {
  return holdLive(now) ? Math.max(0, now - state.pressedAt) : 0;
}

/** Presses that were too short to count, since the page opened. */
export function pttTapsIgnored(): number {
  return state.taps;
}

/** May an utterance that starts now be transcribed? */
export function pttAdmits(style: ListenStyle, now = Date.now()): boolean {
  if (style !== "push-to-talk") return true;
  if (pttActive(now)) return true;
  return state.releasedAt > 0 && now - state.releasedAt <= PTT_GRACE_MS;
}

/** Ctrl+Space in the FRIDAY window. Plain Space stays free for typing. */
export function isHoldKey(event: { code?: string; key?: string; ctrlKey?: boolean }): boolean {
  return Boolean(event.ctrlKey) && (event.code === "Space" || event.key === " ");
}

export function subscribePtt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetPtt(): void {
  state = FRESH;
  allowed = true;
  emit();
}
