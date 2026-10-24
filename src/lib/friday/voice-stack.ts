/**
 * The voice stack as one short list for the Models page: what Auto mode is doing
 * right now (from the running session) next to which voice files are on this PC
 * and which speech size Task routing names. Pure, so it is testable.
 */
import type { VoiceHealth } from "./voice-health";

export type VoiceLine = {
  label: string;
  value: string;
  status: string;
  tone: "accent" | "primary" | "warning" | "destructive" | "muted";
};

export function voiceStackLines(input: {
  health: VoiceHealth | null;
  speechAssigned: string | null;
  /** Voice model name -> its files are on disk. */
  installed: Record<string, boolean>;
}): VoiceLine[] {
  const { health, speechAssigned, installed } = input;
  const lines: VoiceLine[] = [];
  if (!health) {
    lines.push({
      label: "Auto mode",
      value: "not running, so there is no live microphone or speech state to show",
      status: "Idle",
      tone: "muted",
    });
  } else {
    lines.push({
      label: "Auto mode",
      value: health.paused ? "paused" : health.listening ? "listening" : "on, not listening",
      status: health.paused ? "Paused" : health.listening ? "Listening" : "Idle",
      tone: health.paused ? "warning" : health.listening ? "primary" : "muted",
    });
    lines.push({
      label: "Microphone",
      value: health.micDetail || (health.micReady ? "ready" : "not ready"),
      status: health.micReady ? "Ready" : "Not ready",
      tone: health.micReady ? "accent" : "destructive",
    });
    lines.push({
      label: "Speech to text",
      value: health.sttReady
        ? `${health.sttModel || "speech model"} loaded`
        : health.sttError || "the speech model is not loaded yet",
      status: health.sttReady ? "Ready" : "Not ready",
      tone: health.sttReady ? "accent" : "destructive",
    });
    lines.push({
      label: "Speaks with",
      value: health.ttsError
        ? `${health.ttsEngine || "no engine"} — ${health.ttsError}`
        : health.ttsEngine || "not started",
      status: health.ttsError ? "Problem" : health.ttsEngine ? "Ready" : "Idle",
      tone: health.ttsError ? "warning" : health.ttsEngine ? "accent" : "muted",
    });
    lines.push({
      label: "Heard",
      value: `${health.heard} heard, ${health.droppedTotal} dropped`,
      status: health.droppedTotal > health.heard && health.heard > 0 ? "Check" : "OK",
      tone: health.droppedTotal > health.heard && health.heard > 0 ? "warning" : "accent",
    });
  }
  lines.push({
    label: "Task routing → Speech",
    value: speechAssigned
      ? `${speechAssigned} (also Settings → Voice → Speech model size)`
      : "Auto: voice mode picks the size",
    status: speechAssigned ? "Pinned" : "Auto",
    tone: "primary",
  });
  const names = Object.keys(installed);
  const have = names.filter((name) => installed[name]);
  lines.push({
    label: "Voice files on this PC",
    value: names.map((name) => `${installed[name] ? "✓" : "✗"} ${name}`).join("  "),
    status: `${have.length} of ${names.length}`,
    tone: have.length === 0 ? "destructive" : have.length === names.length ? "accent" : "warning",
  });
  return lines;
}
