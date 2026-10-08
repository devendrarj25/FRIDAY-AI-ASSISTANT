import { persistentRetryDelayMs } from "./bounded-retry";
import { pickPhrase } from "./phrase-bank";

/** A failure is spoken once per cause for this session. The screen keeps the detail. */
export function mayAnnounce(cause: string, spoken: ReadonlySet<string>): boolean {
  return !spoken.has(cause);
}

export function recoveryDelayMs(attempt: number): number {
  return persistentRetryDelayMs(attempt);
}

export function failureCause(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("not installed") || text.includes("python") || text.includes("import"))
    return "install";
  if (text.includes("permission")) return "permission";
  if (text.includes("exclusive")) return "exclusive";
  if (text.includes("another") || text.includes("holding")) return "busy";
  if (text.includes("no audio") || text.includes("no working microphone")) return "device";
  return "voice";
}

export function voiceFailureLine(cause: string, salt: number): string {
  const lang = salt % 2 === 0 ? "en" : "hinglish";
  return pickPhrase({
    lang,
    emotion: "confusion",
    intensity: "low",
    context: "work",
    kind: "repair",
  });
}

/** Listening starts again after a spoken reply. */
export function resumeAfterSpokenReply(input: { mode: string; paused: boolean }): boolean {
  return input.mode === "auto" && input.paused !== true;
}

export function shouldRetryNow(trigger: string): boolean {
  return (
    trigger === "install-finished" ||
    trigger === "model-ready" ||
    trigger === "settings" ||
    trigger === "device" ||
    trigger === "focus" ||
    trigger === "toggle" ||
    trigger === "fix-voice"
  );
}
