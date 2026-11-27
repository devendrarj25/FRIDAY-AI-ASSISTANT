/**
 * FRIDAY · Auto window live status: what the bar says (pure).
 *
 * `PhaseChip`, `LatencyChip` and `VoiceLevelMeter` only draw these answers. Nothing here reads a store, a device
 * or the clock.
 */
import { stateLabel, type VoicePhase, type VoiceState } from "@/lib/friday/voice-state";
import { LATENCY_BUDGET_MS, type LatencySummary } from "@/lib/friday/voice-engine/latency-monitor";

/** One short word for a state ("Listening for the command"), never the raw enum and never a trailing ellipsis. */
export function plainStateLabel(state: VoiceState): string {
  return stateLabel(state).replace(/[\s…]+$/u, "");
}

export type PhaseChipKey =
  "listening" | "hearing" | "thinking" | "speaking" | "confirm" | "stopped";

export type PhaseChipModel = {
  key: PhaseChipKey;
  label: string;
  /** What the chip is for the eye; the label alone always carries the meaning. */
  tone: "idle" | "active" | "warn" | "stopped";
  /** The fuller state line, for the tooltip. */
  title: string;
};

/**
 * The one phase chip, from `state.phase`. A command waiting for the owner's yes or no wins over thinking and
 * listening (the spoken question itself still reads Speaking); an off, paused or failed engine reads Stopped.
 */
export function phaseChipModel(input: {
  phase: VoicePhase;
  voiceState: VoiceState;
  pending: boolean;
}): PhaseChipModel {
  const title = plainStateLabel(input.voiceState);
  const { phase } = input;
  if (phase === "off" || phase === "unavailable")
    return { key: "stopped", label: "Stopped", tone: "stopped", title };
  if (phase !== "speaking" && (input.pending || input.voiceState === "WAITING_CONFIRMATION"))
    return { key: "confirm", label: "Waiting for yes or no", tone: "warn", title };
  switch (phase) {
    case "speaking":
      return { key: "speaking", label: "Speaking", tone: "active", title };
    case "thinking":
      return { key: "thinking", label: "Thinking", tone: "active", title };
    case "hearing":
      return { key: "hearing", label: "Hearing you", tone: "active", title };
    default:
      return { key: "listening", label: "Listening", tone: "idle", title };
  }
}

export type LatencyChipModel = { label: string; overBudget: boolean };

/** The last finished turn's time to first sound, or null when no turn was measured (then nothing is drawn). */
export function latencyChipModel(
  summary: Pick<LatencySummary, "last"> | null | undefined,
  budgetMs: number = LATENCY_BUDGET_MS,
): LatencyChipModel | null {
  const ms = summary?.last;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const rounded = Math.round(ms);
  return { label: `Last turn ${rounded} ms`, overBudget: rounded > budgetMs };
}

/** What shows as the live "you" line: the words so far, or a placeholder while speech is being picked up. */
export function interimPlaceholder(interim: string, voiceState: VoiceState): string {
  if (interim.trim()) return interim;
  if (voiceState === "SPEECH_DETECTED") return "listening…";
  if (voiceState === "TRANSCRIBING") return "transcribing…";
  return "";
}

/** Reduced motion shows the level in this many steps instead of a smooth bar. */
export const METER_STEPS = 4;

/**
 * The bar's fill, 0..1, from the gate's RMS level (speech sits well below 1, so the root lifts it into view).
 * Under reduced motion the fill moves in whole steps and never wiggles.
 */
export function meterScale(level: number, reducedMotion: boolean): number {
  const raw = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const lifted = Math.min(1, Math.sqrt(raw) * 1.6);
  if (!reducedMotion) return Math.round(lifted * 100) / 100;
  return Math.ceil(lifted * METER_STEPS) / METER_STEPS;
}
