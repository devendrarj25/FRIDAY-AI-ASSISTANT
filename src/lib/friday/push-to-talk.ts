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
 */

export type ListenStyle = "always" | "push-to-talk";

export const PTT_HOLD_KEY = "Ctrl+Space";
export const PTT_TOGGLE_ACCELERATOR = "Control+Alt+Space";
/** Speech that began just after release still belongs to the press. */
export const PTT_GRACE_MS = 1200;
/** A forgotten toggle closes itself. */
export const PTT_TOGGLE_MAX_MS = 60_000;

type State = { held: boolean; releasedAt: number; toggledAt: number };

let state: State = { held: false, releasedAt: 0, toggledAt: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function normalizeListenStyle(value: unknown): ListenStyle {
  return value === "push-to-talk" ? "push-to-talk" : "always";
}

export function pttPress(): void {
  if (state.held) return;
  state = { ...state, held: true };
  emit();
}

export function pttRelease(now = Date.now()): void {
  if (!state.held) return;
  state = { ...state, held: false, releasedAt: now };
  emit();
}

/** Global shortcut: one press opens, the next press closes. */
export function pttToggle(now = Date.now()): boolean {
  const open = !toggleOpen(now);
  state = { ...state, toggledAt: open ? now : 0, releasedAt: open ? state.releasedAt : now };
  emit();
  return open;
}

function toggleOpen(now: number): boolean {
  return state.toggledAt > 0 && now - state.toggledAt < PTT_TOGGLE_MAX_MS;
}

/** True while the talk key is down or the toggle is on. */
export function pttActive(now = Date.now()): boolean {
  return state.held || toggleOpen(now);
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
  state = { held: false, releasedAt: 0, toggledAt: 0 };
  emit();
}
