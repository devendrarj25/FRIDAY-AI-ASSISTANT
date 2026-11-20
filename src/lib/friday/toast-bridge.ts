/**
 * FRIDAY · toast → notification bridge
 *
 * Corner popups are transient by design; the notification centre is the place
 * the owner can come back to. Every toast FRIDAY raises anywhere in the app is
 * therefore mirrored into the notification store, with the same title, detail
 * and a stable id so a repeated toast refreshes one entry instead of stacking.
 *
 * sonner exports a single shared `toast` object, so wrapping its methods once
 * captures every existing call site without touching any of them — no message
 * text changes.
 *
 * It is also where the corner popups are kept few. A popup interrupts, so it is for what needs the owner right now:
 * a failure, a warning, something with a button, and the answer to something the owner just did. Everything else
 * (a file the watcher noticed, a background refresh, a status at start-up) is still written to the notification
 * centre, silently. The decision is `decidePopup`, a pure function the tests read.
 */

import { toast } from "sonner";
import { isBootHolding, whenBootDone } from "./desktop";
import { notifications, type NotifyLevel } from "./notifications";

type AnyFn = (...args: unknown[]) => unknown;

let installed = false;

/* ----------------------------------------------------------------- popup policy */

/** The owner counts as having just done something this long after a click or a key (ms). */
export const ACTION_WINDOW_MS = 8000;
/** After the boot screen has gone, system chatter stays out of the corner for this long (ms). */
export const SETTLE_MS = 20_000;
/** The same popup is not raised again within this long (ms). */
export const REPEAT_MS = 30_000;
/** At most this many popups that are not failures in any ten seconds. */
export const BURST_LIMIT = 2;

export type PopupInput = {
  level: NotifyLevel;
  /** A button on the toast (Restart now, Undo, Open): the owner is asked to do something. */
  hasAction: boolean;
  /** Milliseconds since the owner last clicked or pressed a key (Infinity when they have not). */
  sinceInputMs: number;
  /** The boot screen is up. */
  booting: boolean;
  /** Milliseconds since the boot screen went (Infinity when it never showed). */
  sinceBootMs: number;
  /** Milliseconds since the same popup was raised (Infinity when it was not). */
  sinceSameMs: number;
  /** How many popups that are not failures were raised in the last ten seconds. */
  recentBurst: number;
};

/** Pure: does this toast pop up in the corner (true) or go only to the notification centre (false)? */
export function decidePopup(input: PopupInput): boolean {
  if (input.sinceSameMs < REPEAT_MS) return false;
  const failure = input.level === "error" || input.level === "warn";
  if (failure) return !(input.booting && input.level === "warn");
  if (input.hasAction) return !input.booting;
  if (input.booting || input.sinceBootMs < SETTLE_MS) return false;
  if (input.sinceInputMs > ACTION_WINDOW_MS) return false;
  return input.recentBurst < BURST_LIMIT;
}

let lastInputAt = 0;
let bootDoneAt = 0;
const raisedAt = new Map<string, number>();
const burst: number[] = [];
const shownIds = new Set<string>();
const quietIds = new Set<string>();
let quietCounter = 0;

function watchInput(): void {
  const mark = () => {
    lastInputAt = Date.now();
  };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, mark, { capture: true, passive: true });
  }
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function record(level: NotifyLevel, message: unknown, options: unknown): void {
  const title = text(message).trim();
  if (!title) return; // JSX/custom toasts carry no readable text to store.
  const opts = (options ?? {}) as {
    id?: string | number;
    description?: unknown;
    duration?: number;
  };
  const id = opts.id != null ? `toast:${String(opts.id)}` : `toast:${level}:${title}`;
  notifications.push({
    id,
    level,
    title,
    detail: text(opts.description),
    source: "App",
  });
}

function shouldPopUp(level: NotifyLevel, message: unknown, options: unknown): boolean {
  const opts = (options ?? {}) as { id?: string | number; description?: unknown; action?: unknown };
  const id = opts.id != null ? String(opts.id) : "";
  const failure = level === "error" || level === "warn";
  // An update to a toast that is already on screen (a progress toast finishing) stays on screen; one that was kept
  // out of the corner stays out unless it became a failure.
  if (id && shownIds.has(id)) return true;
  if (id && quietIds.has(id) && !failure) return false;
  const now = Date.now();
  const key = `${level}|${text(message)}|${text(opts.description)}`;
  const last = raisedAt.get(key);
  while (burst.length && now - (burst[0] ?? 0) > 10_000) burst.shift();
  const decision = decidePopup({
    level,
    hasAction: Boolean(opts.action),
    sinceInputMs: lastInputAt ? now - lastInputAt : Number.POSITIVE_INFINITY,
    booting: isBootHolding(),
    sinceBootMs: bootDoneAt ? now - bootDoneAt : Number.POSITIVE_INFINITY,
    sinceSameMs: last === undefined ? Number.POSITIVE_INFINITY : now - last,
    recentBurst: burst.length,
  });
  if (decision) {
    raisedAt.set(key, now);
    if (!failure) burst.push(now);
    if (raisedAt.size > 200) raisedAt.delete(raisedAt.keys().next().value as string);
  }
  return decision;
}

/** Idempotent — safe to call from every mount. */
export function installToastMirror(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  watchInput();
  whenBootDone(() => {
    bootDoneAt = Date.now();
  });

  const levels: Record<string, NotifyLevel> = {
    success: "success",
    error: "error",
    warning: "warn",
    info: "info",
    message: "info",
    loading: "info",
  };

  const target = toast as unknown as Record<string, AnyFn>;
  for (const [method, level] of Object.entries(levels)) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = ((message: unknown, options: unknown) => {
      // Progress toasts are replaced within a second — do not log those.
      if (method !== "loading") {
        try {
          record(level, message, options);
        } catch {
          /* never let logging break a toast */
        }
      }
      let popUp = true;
      try {
        popUp = shouldPopUp(level, message, options);
      } catch {
        /* a broken policy never hides a toast */
      }
      const opts = (options ?? {}) as { id?: string | number };
      if (!popUp) {
        quietCounter += 1;
        const id = opts.id ?? `quiet-${quietCounter}`;
        quietIds.add(String(id));
        return id;
      }
      const shown = original(message, options);
      if (opts.id != null) shownIds.add(String(opts.id));
      return shown;
    }) as AnyFn;
  }
}
