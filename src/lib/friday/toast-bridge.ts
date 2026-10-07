/**
 * FRIDAY · toast → notification bridge
 *
 * Corner popups are transient by design; the notification centre is the place
 * the owner can come back to. Every toast FRIDAY raises anywhere in the app is
 * therefore mirrored into the notification store, with the same title, detail
 * and a stable id so a repeated toast refreshes one entry instead of stacking.
 *
 * sonner exports a single shared `toast` object, so wrapping its methods once
 * captures every existing call site without touching any of them — no UI, no
 * behaviour and no message text changes.
 */

import { toast } from "sonner";
import { notifications, type NotifyLevel } from "./notifications";

type AnyFn = (...args: unknown[]) => unknown;

let installed = false;

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

/** Idempotent — safe to call from every mount. */
export function installToastMirror(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

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
      return original(message, options);
    }) as AnyFn;
  }
}
