/**
 * FRIDAY · what is said when a turn fails
 *
 * The raw error is not the answer. This turns it into one plain sentence (`speakError`), chooses the next step
 * from the signals the failure carries (`chooseRecovery`: never a blind retry of something dangerous, a bounded
 * retry for a timeout, a different model when the model is the problem) and, when no model can be reached at all,
 * gives the honest handoff that says what she can still do. A line the owner caused ("Stopped by you.") is left alone.
 */

import { handoffMessage } from "./baseline-responder";
import { brainError, speakError } from "./errors";
import { chooseRecovery, type RecoveryKind } from "./self-diagnosis";

const NEXT: Record<RecoveryKind, string> = {
  retry: "I can try once more.",
  fallback: "I will use a safer way if you ask again.",
  "switch-model": "Another model may answer it: pick one in Models.",
  "switch-capability": "Another path may work; tell me and I will try it.",
  research: "I should look this up again before I answer.",
  replan: "Part of it did not finish; ask me to continue and I will plan the rest.",
  ask: "I need you to decide this one.",
  stop: "I stopped here and will not retry on my own.",
};

const NO_MODEL =
  /\b(no (?:model|engine)|none is reachable|not reachable|not connected|stopped responding)\b/i;
const TIMEOUT = /\b(time(?:d)?[ -]?out|took too long)\b/i;

export function failureText(
  error: string,
  options: { attempts?: number; dangerous?: boolean } = {},
): string {
  const raw = String(error || "").trim();
  if (!raw || /^stopped by you\.?$/i.test(raw)) return raw || "Stopped.";
  if (NO_MODEL.test(raw) && /\b(model|engine|ai service)\b/i.test(raw)) return handoffMessage(raw);
  const sentence = speakError(
    brainError({
      component: "brain-engine",
      error: raw,
      recoverability: "ask-user",
      userAction: "",
    }),
  ).trim();
  const choice = chooseRecovery({
    failure: raw,
    attempts: options.attempts ?? 0,
    timeout: TIMEOUT.test(raw),
    dangerous: options.dangerous ?? false,
  });
  return `${sentence} ${NEXT[choice.kind]}`.trim();
}
