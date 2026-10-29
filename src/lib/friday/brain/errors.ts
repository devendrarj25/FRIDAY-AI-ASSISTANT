/**
 * FRIDAY · structured brain errors
 *
 * Internal records for recovery. User-facing text stays short and natural.
 * Nothing here claims a task succeeded.
 */

export type BrainErrorSeverity = "info" | "warning" | "error" | "fatal";

export type BrainError = {
  component: string;
  error: string;
  cause: string;
  severity: BrainErrorSeverity;
  recoverability: "retry" | "fallback" | "ask-user" | "stop";
  retry: boolean;
  fallback: string | null;
  userAction: string;
};

export function brainError(
  partial: Partial<BrainError> & Pick<BrainError, "component" | "error">,
): BrainError {
  return {
    cause: partial.cause ?? partial.error,
    severity: partial.severity ?? "error",
    recoverability: partial.recoverability ?? "ask-user",
    retry: partial.retry ?? false,
    fallback: partial.fallback ?? null,
    userAction: partial.userAction ?? "Try again, or say what you wanted in a different way.",
    ...partial,
    component: partial.component,
    error: partial.error,
  };
}

/** One plain sentence for chat/voice. Never "Something went wrong." */
export function speakError(err: BrainError): string {
  if (err.fallback) return err.fallback;
  if (err.recoverability === "retry") return `${err.error} I'll try another way.`;
  if (err.recoverability === "ask-user") return `${err.error} ${err.userAction}`;
  return err.error;
}
