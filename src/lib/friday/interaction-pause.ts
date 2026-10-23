/**
 * While the owner types or scrolls, the ambient light holds still.
 *
 * The drifting light sits under blurred chrome, so each frame of it makes the
 * blur layers recomposite. Pausing it for the moment of input keeps typing and
 * scrolling smooth on any GPU, and it resumes by itself right after. The class
 * is only a hook for CSS (`html.friday-busy body::before`); nothing else
 * changes, and no timer runs while the page is idle.
 */

export const BUSY_CLASS = "friday-busy";
const TYPING_IDLE_MS = 900;
const SCROLL_IDLE_MS = 350;

type Env = {
  root: { classList: { add(c: string): void; remove(c: string): void } };
  target: {
    addEventListener(type: string, fn: (e: Event) => void, opts?: unknown): void;
    removeEventListener(type: string, fn: (e: Event) => void, opts?: unknown): void;
  };
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
};

/** True for keyboard input that lands in a field the owner is typing into. */
export function isTypingTarget(node: unknown): boolean {
  const el = node as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el?.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}

export function installInteractionPause(env?: Env): () => void {
  const e: Env | null =
    env ??
    (typeof document === "undefined"
      ? null
      : {
          root: document.documentElement,
          target: document,
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        });
  if (!e) return () => undefined;
  let handle: unknown = null;
  const hold = (ms: number) => {
    e.root.classList.add(BUSY_CLASS);
    if (handle !== null) e.clearTimer(handle);
    handle = e.setTimer(() => {
      handle = null;
      e.root.classList.remove(BUSY_CLASS);
    }, ms);
  };
  const onKey = (ev: Event) => {
    if (isTypingTarget(ev.target)) hold(TYPING_IDLE_MS);
  };
  const onScroll = () => hold(SCROLL_IDLE_MS);
  e.target.addEventListener("keydown", onKey, true);
  e.target.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    e.target.removeEventListener("keydown", onKey, true);
    e.target.removeEventListener("scroll", onScroll, { capture: true });
    if (handle !== null) e.clearTimer(handle);
    e.root.classList.remove(BUSY_CLASS);
  };
}
