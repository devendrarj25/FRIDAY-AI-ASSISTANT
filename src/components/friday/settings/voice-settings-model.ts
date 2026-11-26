/**
 * FRIDAY · Settings, Voice: what the page says about a few actions (pure).
 *
 * `VoiceSettings.tsx` only draws these answers. `deleteVoiceDataOutcome` reads the answer of the desktop's
 * "Delete voice data" (`electron/voice-privacy.cjs` clearVoiceData: ok, removed, bytes, failed, enrolled) and
 * says what really happened; nothing here touches a file, a store or the clock.
 */

/** The hint of a switch whose stored default is on (`DEFAULT_PREFERENCES.voice`). Hands-free is off by default and never uses it. */
export const ON_BY_DEFAULT_HINT = "On by default. Reversible.";

export type DeleteVoiceDataOutcome = {
  kind: "deleted" | "empty" | "failed";
  /** One short plain sentence for the toast. */
  message: string;
  /** The toast carries a Retry button. */
  retry: boolean;
};

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

const files = (n: number) => `${n} voice file${n === 1 ? "" : "s"}`;

/** The answer of the desktop's voice-data delete, as a toast. A missing, refused or partial answer is a failure with Retry. */
export function deleteVoiceDataOutcome(result: unknown): DeleteVoiceDataOutcome {
  const failedOutcome = (message: string): DeleteVoiceDataOutcome => ({
    kind: "failed",
    message,
    retry: true,
  });
  if (!result || typeof result !== "object") {
    return failedOutcome("Voice data could not be deleted: no answer from the desktop");
  }
  const answer = result as { ok?: unknown; removed?: unknown; failed?: unknown };
  if (answer.ok !== true) return failedOutcome("Voice data could not be deleted");
  const failed = count(answer.failed) ?? 0;
  const removed = count(answer.removed);
  if (failed > 0) {
    const gone = removed ? `Deleted ${files(removed)}, but ` : "";
    return failedOutcome(`${gone}${failed} could not be removed`);
  }
  if (removed === 0) return { kind: "empty", message: "Nothing to delete", retry: false };
  return {
    kind: "deleted",
    message: removed === null ? "Deleted voice data" : `Deleted ${files(removed)}`,
    retry: false,
  };
}

/** A rejected delete (the bridge threw): a failure with Retry that keeps the reason. */
export function deleteVoiceDataFailure(error: unknown): DeleteVoiceDataOutcome {
  const reason = String((error as Error)?.message ?? error);
  return { kind: "failed", message: `Could not delete voice data: ${reason}`, retry: true };
}
