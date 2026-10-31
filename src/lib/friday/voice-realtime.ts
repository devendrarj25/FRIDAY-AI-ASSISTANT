/**
 * FRIDAY · realtime voice experiment (opt-in)
 *
 * What "realtime" can honestly mean on the default voice stack, which has no torch and no speech-to-speech
 * model: the same listen, think and speak parts, overlapped tighter. With the switch on, an open conversation
 * closes a pause sooner, and the first spoken chunk may leave at a clause break instead of waiting for a full
 * sentence, so the first audio comes earlier while the answer is still streaming. Barge-in, mute, the pause
 * switch and Auto-mode-only microphone rules are unchanged: this only moves timing.
 *
 * Two other engines are listed so the Settings row can say why they are unavailable instead of pretending:
 * a local speech-to-speech model (needs an optional runtime and a GPU, neither shipped) and a cloud realtime
 * API (sends microphone audio off this PC, so it needs paid access, a key and privacy mode off).
 */

export type RealtimeEngineId = "pipeline-overlap" | "local-speech-to-speech" | "cloud-realtime";

export type RealtimeInput = {
  enabled: boolean;
  surface: "auto" | "manual";
  paused: boolean;
  gpuVramGb: number;
  s2sRuntimeInstalled: boolean;
  paidAccess: boolean;
  cloudKey: boolean;
  privacyMode: boolean;
};

export type RealtimeStatus = {
  active: boolean;
  engine: RealtimeEngineId | null;
  reasons: string[];
  unavailable: { engine: RealtimeEngineId; why: string }[];
};

export function realtimeStatus(input: RealtimeInput): RealtimeStatus {
  const unavailable: RealtimeStatus["unavailable"] = [];
  if (!input.s2sRuntimeInstalled || input.gpuVramGb < 12) {
    unavailable.push({
      engine: "local-speech-to-speech",
      why: !input.s2sRuntimeInstalled
        ? "no speech-to-speech runtime is installed (none ships with FRIDAY)"
        : "it needs a GPU with at least 12 GB of video memory",
    });
  }
  const cloudWhy = !input.paidAccess
    ? "paid access is off"
    : !input.cloudKey
      ? "no provider key is saved"
      : input.privacyMode
        ? "Keep speech on this PC is on, so microphone audio stays here"
        : "";
  if (cloudWhy) unavailable.push({ engine: "cloud-realtime", why: cloudWhy });

  const reasons: string[] = [];
  if (!input.enabled) reasons.push("the experiment is switched off");
  if (input.surface !== "auto") reasons.push("only Auto mode opens the microphone");
  if (input.paused) reasons.push("listening is paused");
  if (reasons.length) return { active: false, engine: null, reasons, unavailable };
  return { active: true, engine: "pipeline-overlap", reasons: [], unavailable };
}

export const EARLY_MIN_CHARS = 40;
const OPEN_SILENCE_SCALE = 0.7;
const SILENCE_FLOOR_MS = 280;

/** A shorter closing pause for an open conversation. The wake-word wait and an unfinished thought are left alone. */
export function realtimeSilenceMs(
  base: number,
  active: boolean,
  conversationOpen: boolean,
  incomplete: boolean,
): number {
  if (!active || !conversationOpen || incomplete) return base;
  return Math.max(SILENCE_FLOOR_MS, Math.round(base * OPEN_SILENCE_SCALE));
}

/**
 * The first chunk of a reply may end at a clause break once it is long enough to sound like a phrase. Later
 * chunks keep whole sentences. Returns the characters to speak and how many were consumed, or none.
 */
export function earlyClause(pending: string): { spoken: string; consumed: number } {
  const head = pending.slice(0, 160);
  const re = /[,;:—–](?=\s)/g;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(head))) {
    if (match.index + 1 >= EARLY_MIN_CHARS) {
      end = match.index + 1;
      break;
    }
  }
  if (end < 0) return { spoken: "", consumed: 0 };
  let consumed = end;
  while (consumed < pending.length && /\s/.test(pending[consumed] ?? "")) consumed += 1;
  return { spoken: pending.slice(0, end).trim(), consumed };
}
