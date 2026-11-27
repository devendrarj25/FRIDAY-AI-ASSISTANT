/**
 * FRIDAY · Auto window transcript states: what to say (pure).
 *
 * `VoiceTranscript` (empty state), `ConfirmationCard` (countdown) and `VoiceDownloadBar` (retry) only draw
 * these answers. Nothing here reads a store, a device or the clock.
 */
import { modelById } from "@/lib/friday/model-catalog";

/** How long a spoken command waits for yes or no when the caller names no window. */
export const CONFIRM_TTL_MS = 30_000;

export type EmptyTranscriptInput = {
  wakeWord?: string;
  handsFree?: boolean;
  muted?: boolean;
  paused?: boolean;
  error?: string | null;
};

/** The line shown before anything was heard. It never invites speech the microphone cannot hear. */
export function emptyTranscriptLine(input: EmptyTranscriptInput): string {
  const error = (input.error ?? "").trim();
  if (error) return error;
  if (input.paused) return "Listening is paused from the tray. Resume it to talk to FRIDAY.";
  if (input.muted) return "Voice is muted. Unmute it to hear FRIDAY and talk to her.";
  if (input.handsFree)
    return "Nothing heard yet. Hands-free is on, so just say what you need, no wake word.";
  const word = (input.wakeWord ?? "").trim() || "FRIDAY";
  return `Nothing heard yet. Say “${word}” followed by what you need.`;
}

export type ConfirmCountdown = {
  /** Whole seconds left, never below zero. */
  seconds: number;
  expired: boolean;
  label: string;
};

/** Seconds left on a spoken command's approval, from when it was asked. */
export function confirmCountdown(
  askedAt: number,
  now: number,
  ttlMs: number = CONFIRM_TTL_MS,
): ConfirmCountdown {
  const window = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : CONFIRM_TTL_MS;
  const left = Number.isFinite(askedAt) && Number.isFinite(now) ? askedAt + window - now : 0;
  const seconds = left > 0 ? Math.min(Math.ceil(window / 1000), Math.ceil(left / 1000)) : 0;
  const expired = seconds <= 0;
  return {
    seconds,
    expired,
    label: expired ? "Approval expired. Ask again to run it." : `Say yes or no · ${seconds} s left`,
  };
}

/** The catalog id a failed speech download installs again, or null when it names nothing installable. */
export function downloadRetryId(model: string): string | null {
  const name = model.trim();
  if (!name) return null;
  if (modelById.has(name)) return name;
  const speech = `faster-whisper-${name}`;
  return modelById.has(speech) ? speech : null;
}
