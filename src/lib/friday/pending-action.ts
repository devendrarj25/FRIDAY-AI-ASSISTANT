/**
 * Pending state for an action. A click handler that returns a promise puts
 * its button in a pending state (spinner, disabled, no second submit) until
 * the promise settles; a rejection becomes an error toast instead of a silent
 * failure. Handlers that return nothing behave exactly as before.
 */
import { toast } from "sonner";
import { rejectionMessage } from "./rejection-toast";

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Follow `result`: call `done` when it settles, and report a failure through
 * `fail` (default: an error toast named after the control).
 */
export function followPending(
  result: PromiseLike<unknown>,
  done: () => void,
  label: string,
  fail: (title: string, description: string) => void = (title, description) =>
    void toast.error(title, { description }),
): void {
  Promise.resolve(result).then(done, (error: unknown) => {
    done();
    const message = rejectionMessage(error);
    if (message) fail(label ? `${label} failed` : "That action failed", message);
  });
}
