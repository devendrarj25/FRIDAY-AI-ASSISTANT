/**
 * An unhandled promise rejection is a failed action nobody reported. Show it
 * as a toast (which the toast bridge also keeps in the notification centre)
 * instead of leaving a silent failure. Cancelled requests are not errors.
 */
import { toast } from "sonner";
import { isExpectedClientAbort } from "../client-abort";

const WINDOW_MS = 5000;

/** The readable one-line text for a rejection reason, or null to stay quiet. */
export function rejectionMessage(reason: unknown): string | null {
  if (reason == null) return null;
  if (isExpectedClientAbort(reason)) return null;
  const name = (reason as { name?: unknown }).name;
  if (name === "AbortError") return null;
  const text =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : typeof (reason as { message?: unknown }).message === "string"
          ? String((reason as { message: string }).message)
          : "";
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "An action failed without a message.";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

export function installRejectionToast(
  target: Pick<Window, "addEventListener" | "removeEventListener"> | null = typeof window ===
  "undefined"
    ? null
    : window,
  show: (title: string, description: string) => void = (title, description) =>
    void toast.error(title, { description, id: `rejection:${description}` }),
  now: () => number = () => Date.now(),
): () => void {
  if (!target) return () => undefined;
  const last = new Map<string, number>();
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    const message = rejectionMessage(reason);
    if (!message) return;
    const t = now();
    const prev = last.get(message);
    if (prev !== undefined && t - prev < WINDOW_MS) return;
    last.set(message, t);
    show("An action failed", message);
  };
  target.addEventListener("unhandledrejection", onRejection);
  return () => target.removeEventListener("unhandledrejection", onRejection);
}
