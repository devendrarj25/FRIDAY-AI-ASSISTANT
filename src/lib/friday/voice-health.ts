/**
 * FRIDAY · voice health for the self-check and for chat.
 *
 * Auto mode registers a provider of its live state (microphone, speech model,
 * heard and dropped counts, the last turn trace). The self-check and a chat
 * question about her own voice read that state, so the answer comes from the
 * running pipeline and not from a model's guess. Pure helpers, no I/O.
 */

import type { SelfProblem } from "./brain/self-diagnosis";

/** Live facts from the Auto voice session. Registered by assistant-mode. */
export type VoiceHealth = {
  mode: string;
  listening: boolean;
  paused: boolean;
  micReady: boolean;
  micDetail: string;
  sttReady: boolean;
  sttModel: string;
  sttError: string;
  heard: number;
  dropped: Record<string, number>;
  droppedTotal: number;
  ttsEngine: string;
  ttsError: string;
  /** "heard ✓ … → routed –" from the turn trace. */
  turnLine: string;
  stoppedAt: { stage: string; reason: string } | null;
};

let voiceHealthProvider: (() => VoiceHealth | null) | null = null;

/** Auto mode registers its live state here. Returns the unregister call. */
export function registerVoiceHealth(provider: () => VoiceHealth | null): () => void {
  voiceHealthProvider = provider;
  return () => {
    if (voiceHealthProvider === provider) voiceHealthProvider = null;
  };
}

export function currentVoiceHealth(): VoiceHealth | null {
  try {
    return voiceHealthProvider ? voiceHealthProvider() : null;
  } catch {
    return null;
  }
}

const EMPTY_FIX =
  "Whisper returned nothing for those clips. Run mic test; if it hears you, press fix voice in Voice diagnostics to reload the speech model.";

const DROP_FIX: Record<string, string> = {
  "no-speech":
    "The microphone sent audio with no speech in it. Run mic test in Voice diagnostics, raise the input level in Windows Sound settings, and speak closer to the mic.",
  empty: EMPTY_FIX,
  "too-short": "Clips were shorter than a word. Speak a full sentence after the wake word.",
  "denoise-skipped":
    "Noise removal was taking the voice out, so I used the original audio. Run mic test if this keeps happening.",
  "low-confidence":
    "Whisper was unsure of those clips. A larger Speech model size in Voice settings hears Hindi and Hinglish better.",
};

/** Problems and facts from the voice session. Pure, so it is testable. */
export function problemsFromVoiceHealth(health: VoiceHealth | null): {
  problems: SelfProblem[];
  facts: string[];
} {
  if (!health) return { problems: [], facts: [] };
  const problems: SelfProblem[] = [];
  const facts: string[] = [
    `Voice: ${health.mode} mode${health.listening ? ", listening" : ""}${health.paused ? ", paused" : ""}; speech model ${health.sttModel || "unknown"}; heard ${health.heard}, dropped ${health.droppedTotal}; spoken with ${health.ttsEngine || "no engine yet"}.`,
  ];
  if (health.mode !== "auto") {
    problems.push({
      id: "voice:not-auto",
      severity: "info",
      area: "voice",
      title: "Voice is off",
      detail: "Only Auto mode opens the microphone and speaks. Chat and Manual stay quiet.",
      fix: "Switch to Auto mode.",
    });
  }
  if (health.paused) {
    problems.push({
      id: "voice:paused",
      severity: "warning",
      area: "voice",
      title: "Listening is paused",
      detail: "The tray pause or Pause listening is on.",
      fix: "Press Pause listening again, or Resume from the tray.",
    });
  }
  if (!health.micReady) {
    problems.push({
      id: "voice:mic",
      severity: "critical",
      area: "voice",
      title: "No usable microphone",
      detail: health.micDetail || "The microphone did not open.",
      fix: "Check Windows Settings → Privacy → Microphone, then press reset microphone.",
    });
  }
  if (!health.sttReady) {
    problems.push({
      id: "voice:stt",
      severity: "critical",
      area: "voice",
      title: "Speech recognition is not ready",
      detail: health.sttError || "The speech model has not loaded.",
      fix: "Open Voice diagnostics and press fix voice.",
    });
  }
  if (health.droppedTotal >= 5 && health.droppedTotal > health.heard * 3) {
    const top = Object.entries(health.dropped).sort((a, b) => b[1] - a[1])[0];
    const code = top && top[1] > 0 ? top[0] : "empty";
    problems.push({
      id: "voice:drops",
      severity: "warning",
      area: "voice",
      title: "Most of what I heard was dropped",
      detail: `heard ${health.heard}, dropped ${health.droppedTotal}, mostly ${code}`,
      fix: DROP_FIX[code] ?? EMPTY_FIX,
    });
  }
  if (health.ttsError) {
    problems.push({
      id: "voice:tts",
      severity: "warning",
      area: "voice",
      title: "Speaking failed",
      detail: health.ttsError,
      fix: "Run speak test in Voice diagnostics; install a voice in Install Manager if none speaks.",
    });
  }
  if (health.stoppedAt) {
    facts.push(
      `Last spoken turn stopped at ${health.stoppedAt.stage}: ${health.stoppedAt.reason}.`,
    );
  }
  return { problems, facts };
}

/** How FRIDAY answers "why can't you talk in voice?" — from live state only. */
export function describeVoiceHealth(health: VoiceHealth | null): string {
  if (!health) {
    return "My voice session has not started on this screen yet. Switch to Auto mode, say something, then ask me again and I'll read the live pipeline.";
  }
  const { problems, facts } = problemsFromVoiceHealth(health);
  const lines: string[] = [];
  if (!problems.length) {
    lines.push("My voice pipeline looks healthy right now.");
  } else {
    lines.push("Here's what I see in my voice pipeline:");
    for (const problem of problems) {
      lines.push(`• [${problem.severity}] ${problem.title} — ${problem.detail}`);
      if (problem.fix) lines.push(`  Fix: ${problem.fix}`);
    }
  }
  lines.push("", ...facts);
  if (health.turnLine && health.turnLine !== "no turn yet") {
    lines.push(`Last turn: ${health.turnLine}`);
  }
  return lines.join("\n");
}
