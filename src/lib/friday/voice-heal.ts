/**
 * One voice self-heal policy. Auto mode and the Voice buttons call this.
 * A class gets three attempts inside ten minutes, then one Needs-you line.
 */

export const HEAL_WINDOW_MS = 10 * 60 * 1000;
export const HEAL_MAX_ATTEMPTS = 3;

export const HEAL_CLASSES = [
  "stt-model-missing",
  "stt-blocked",
  "stt-checksum",
  "stt-dependency-incompatible",
  "stt-engine-crash",
  "mic-permission-denied",
  "mic-no-device",
  "mic-no-frames",
  "sleep-resume",
  "audio-context-suspended",
  "vad-too-quiet",
  "vad-too-noisy",
  "wake-model-missing",
  "tts-engine-fail",
  "kernel-down",
  "heard-queue-overflow",
] as const;

export type HealClass = (typeof HEAL_CLASSES)[number];

const ACTIONS: Record<HealClass, readonly string[]> = {
  "stt-model-missing": ["download-stt", "verify-stt", "next-stt-engine"],
  "stt-blocked": ["download-stt", "verify-stt", "next-stt-engine"],
  "stt-checksum": ["download-stt", "verify-stt", "next-stt-engine"],
  "stt-dependency-incompatible": ["reinstall-pinned-av", "restart-stt-worker", "next-stt-engine"],
  "stt-engine-crash": ["restart-stt-worker", "retry-segment", "next-stt-engine"],
  "mic-permission-denied": ["show-mic-privacy", "recheck-mic", "recheck-mic"],
  "mic-no-device": ["reopen-mic", "reopen-default-mic", "reopen-default-mic"],
  "mic-no-frames": ["reopen-mic", "reopen-default-mic", "reopen-default-mic"],
  "sleep-resume": ["reopen-mic", "reopen-default-mic", "reopen-default-mic"],
  "audio-context-suspended": [
    "resume-audio-context",
    "resume-audio-context",
    "resume-audio-context",
  ],
  "vad-too-quiet": ["recalibrate-vad", "raise-gain", "tell-owner-level"],
  "vad-too-noisy": ["recalibrate-vad", "recalibrate-vad", "tell-owner-level"],
  "wake-model-missing": ["restore-wake", "redownload-wake", "redownload-wake"],
  "tts-engine-fail": ["next-tts-engine", "reprobe-tts", "reprobe-tts"],
  "kernel-down": ["restart-kernel", "restart-kernel", "restart-kernel"],
  "heard-queue-overflow": ["drop-heard", "drop-heard", "drop-heard"],
};

const NEEDS: Record<HealClass, string> = {
  "stt-model-missing": "Needs you: the speech model did not install. [Fix voice]",
  "stt-blocked": "Needs you: the speech download is blocked. [Fix voice]",
  "stt-checksum": "Needs you: the speech model checksum did not match. [Fix voice]",
  "stt-dependency-incompatible":
    "Needs you: PyAV does not match faster-whisper. Press Fix voice to install av>=17.0.0,<19.",
  "stt-engine-crash": "Needs you: speech recognition stopped. [Fix voice]",
  "mic-permission-denied":
    "Needs you: Settings > Privacy > Microphone, allow desktop apps. [Reset microphone]",
  "mic-no-device": "Needs you: plug in a microphone or pick another input. [Reset microphone]",
  "mic-no-frames": "Needs you: the microphone opened but sent no audio. [Reset microphone]",
  "sleep-resume": "Needs you: listening did not return after sleep. [Reset microphone]",
  "audio-context-suspended": "Needs you: click FRIDAY once so audio can resume.",
  "vad-too-quiet": "Needs you: raise the Windows input level. [Reset microphone]",
  "vad-too-noisy": "Needs you: the room is too loud for a steady floor. [Reset microphone]",
  "wake-model-missing": "Needs you: the wake model is missing. [Recheck wake engine]",
  "tts-engine-fail": "Needs you: no voice could speak. [Fix voice]",
  "kernel-down": "Needs you: the local kernel did not restart. [Fix voice]",
  "heard-queue-overflow": "Needs you: heard lines were dropped. The counter is on the voice log.",
};

const FIXED: Record<HealClass, string> = {
  "stt-model-missing": "Fixed: speech model",
  "stt-blocked": "Fixed: speech download",
  "stt-checksum": "Fixed: speech model checksum",
  "stt-dependency-incompatible": "Fixed: speech decoder",
  "stt-engine-crash": "Fixed: speech recognition",
  "mic-permission-denied": "Fixed: microphone permission",
  "mic-no-device": "Fixed: microphone",
  "mic-no-frames": "Fixed: microphone frames",
  "sleep-resume": "Fixed: listening after sleep",
  "audio-context-suspended": "Fixed: audio",
  "vad-too-quiet": "Fixed: microphone level",
  "vad-too-noisy": "Fixed: noise floor",
  "wake-model-missing": "Fixed: wake engine",
  "tts-engine-fail": "Fixed: voice",
  "kernel-down": "Fixed: kernel",
  "heard-queue-overflow": "Fixed: heard queue",
};

export type HealMemory = {
  attempts: Partial<Record<HealClass, number[]>>;
  reported: Partial<Record<HealClass, boolean>>;
};

export function emptyHealMemory(): HealMemory {
  return { attempts: {}, reported: {} };
}

export function classifyVoiceFault(text: string): HealClass | "none" {
  const raw = String(text || "").toLowerCase();
  if (!raw) return "none";
  if (raw.includes("ipc budget expired")) return "none";
  if (raw.includes("checksum")) return "stt-checksum";
  if (raw.includes("dependency-incompatible") || raw.includes("metadata_errors"))
    return "stt-dependency-incompatible";
  if (raw.includes("not allowlisted") || raw.includes("blocked:")) return "stt-blocked";
  if (raw.includes("permission") && raw.includes("microphone")) return "mic-permission-denied";
  if (raw.includes("no audio frames") || raw.includes("zero frames")) return "mic-no-frames";
  if (raw.includes("sleep") || raw.includes("system resume")) return "sleep-resume";
  if (
    raw.includes("no microphone") ||
    raw.includes("no working microphone") ||
    raw.includes("no device") ||
    raw.includes("unplugged") ||
    raw.includes("reopening the microphone") ||
    raw.includes("microphone track")
  ) {
    return "mic-no-device";
  }
  if (raw.includes("audio context") || raw.includes("suspended")) return "audio-context-suspended";
  if (raw.includes("too quiet") || raw.includes("input level")) return "vad-too-quiet";
  if (raw.includes("too noisy") || raw.includes("noise floor")) return "vad-too-noisy";
  if (raw.includes("wake") && (raw.includes("missing") || raw.includes("corrupt")))
    return "wake-model-missing";
  if (raw.includes("tts") || raw.includes("could speak") || raw.includes("speech engine"))
    return "tts-engine-fail";
  if (raw.includes("kernel")) return "kernel-down";
  if (raw.includes("heard") && raw.includes("overflow")) return "heard-queue-overflow";
  if (raw.includes("worker") || raw.includes("timeout") || raw.includes("transcribe-failed"))
    return "stt-engine-crash";
  if (
    raw.includes("not verified") ||
    raw.includes("speech model") ||
    raw.includes("weights") ||
    raw.includes("fetch failed") ||
    raw.includes("offline")
  ) {
    return "stt-model-missing";
  }
  return "none";
}

function recent(stamps: number[] | undefined, now: number): number[] {
  return (stamps || []).filter((at) => now - at < HEAL_WINDOW_MS);
}

export function planVoiceHeal(input: {
  fault: string;
  now: number;
  memory?: HealMemory;
  auto: boolean;
  manual?: boolean;
}): {
  memory: HealMemory;
  action: string;
  report: string | null;
  retry: boolean;
  delayMs: number;
  fault: HealClass | "none";
} {
  const memory = input.memory || emptyHealMemory();
  const named = HEAL_CLASSES.includes(input.fault as HealClass)
    ? (input.fault as HealClass)
    : classifyVoiceFault(input.fault);
  if (!input.auto && !input.manual) {
    return { memory, action: "idle", report: null, retry: false, delayMs: 0, fault: named };
  }
  if (named === "none") {
    return { memory, action: "idle", report: null, retry: false, delayMs: 0, fault: named };
  }
  const stamps = recent(memory.attempts[named], input.now);
  if (stamps.length >= HEAL_MAX_ATTEMPTS) {
    const report = memory.reported[named] ? null : NEEDS[named];
    memory.attempts[named] = stamps;
    memory.reported[named] = true;
    return { memory, action: "needs-you", report, retry: false, delayMs: 0, fault: named };
  }
  const action = ACTIONS[named][Math.min(stamps.length, ACTIONS[named].length - 1)] || "needs-you";
  stamps.push(input.now);
  memory.attempts[named] = stamps;
  const delayMs = stamps.length <= 1 ? 0 : stamps.length === 2 ? 2000 : 8000;
  return { memory, action, report: null, retry: true, delayMs, fault: named };
}

/** A voice fault always lands on one class so recovery does not stop on unknown text. */
export function healFault(text: string): HealClass | "none" {
  if (
    String(text || "")
      .toLowerCase()
      .includes("ipc budget expired")
  )
    return "none";
  if (HEAL_CLASSES.includes(text as HealClass)) return text as HealClass;
  const named = classifyVoiceFault(text);
  if (named !== "none") return named;
  if (/not installed|speech recognition|faster-whisper|weights|model/i.test(text)) {
    return "stt-model-missing";
  }
  return "stt-engine-crash";
}

export function noteHealFixed(fault: HealClass | string): string {
  if (HEAL_CLASSES.includes(fault as HealClass)) return FIXED[fault as HealClass];
  return "Fixed: voice";
}

/** Raw installer and host errors stay on the status line. Captions get this. */
export function spokenRepairLine(message: string, friendly: string): string {
  if (
    /allowlist|fetch failed|checksum|https?:\/\/|ENOSPC|ECONN|traceback|sha256|not allowlisted|blocked:/i.test(
      message,
    )
  ) {
    return "My speech recognition is still starting, one moment";
  }
  return friendly;
}
