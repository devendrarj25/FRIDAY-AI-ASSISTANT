/**
 * Voice session policy for the one Auto Mode loop.
 *
 * The microphone, speech recognition, and spoken replies run only while Auto
 * (voice) mode is on. Manual and chat never open the mic and never speak.
 * Auto mode is the hands-free conversation: a real utterance is a turn. The
 * stored hands-free flag still starts false; when the owner has turned that
 * control off, the wake word is required again. This module does not approve
 * execution.
 */

export type VoiceSurface = "auto" | "manual";

/** True only when Auto mode may capture the microphone. */
export function microphoneAllowed(mode: VoiceSurface, paused: boolean): boolean {
  return mode === "auto" && !paused;
}

/** True only when Auto mode may speak a reply. Output mute is a separate switch. */
export function spokenReplyAllowed(mode: VoiceSurface, muted: boolean): boolean {
  return mode === "auto" && !muted;
}

/**
 * Whether a transcript is a turn.
 * A stop word is always taken in an open Auto session so "stop" cuts playback.
 * Otherwise a wake match, an open attention window, or a real sentence counts.
 * `wakeWordRequired` is set only when the owner saved Hands-free off.
 */
export function acceptsVoiceTurn(input: {
  mode: VoiceSurface;
  paused: boolean;
  wakeMatched: boolean;
  awake: boolean;
  handsFree: boolean;
  wakeWordRequired: boolean;
  words: number;
  stop: boolean;
}): boolean {
  if (!microphoneAllowed(input.mode, input.paused)) return false;
  if (input.stop) return true;
  if (input.wakeMatched || input.awake) return true;
  if (input.wakeWordRequired && !input.handsFree) return false;
  return input.words >= 2;
}

/**
 * Trailing silence before an utterance is closed.
 * The open conversation ends a pause sooner. Waiting for the wake word waits
 * longer so a name is not cut off. A transcript that still looks mid-thought
 * waits longer, and that wait is capped so a bad partial cannot hold the mic.
 */
export function endpointSilenceMs(
  conversationOpen: boolean,
  transcript = "",
  turnProbability: number | null = null,
): number {
  const base = conversationOpen ? 420 : 700;
  const textWait = utteranceIncomplete(transcript) ? Math.min(1600, base + 780) : base;
  // A low semantic score may wait longer. It never cuts a pause the text already asked for.
  if (
    typeof turnProbability === "number" &&
    Number.isFinite(turnProbability) &&
    turnProbability < 0.5
  ) {
    return Math.min(1600, Math.max(textWait, base + 780));
  }
  return textWait;
}

/**
 * Lower other apps only while FRIDAY is speaking, and never during quiet hours.
 * Quiet hours already reduce FRIDAY's own volume.
 */
export function shouldDuck(input: {
  enabled: boolean;
  speaking: boolean;
  quiet: boolean;
}): boolean {
  return input.enabled === true && input.speaking === true && input.quiet !== true;
}

/**
 * Extra speaker signal. A missing voiceprint does not block ordinary speech,
 * and this result never approves an action.
 */
export function speakerDecision(input: {
  similarity: number | null;
  enrolled: boolean;
  sensitive: boolean;
}): { allow: boolean; execute: false; reason: string } {
  if (!input.sensitive) return { allow: true, execute: false, reason: "ordinary" };
  if (!input.enrolled || input.similarity == null)
    return { allow: true, execute: false, reason: "no-voiceprint" };
  if (input.similarity < 0.75) return { allow: false, execute: false, reason: "speaker-mismatch" };
  return { allow: true, execute: false, reason: "speaker-match" };
}

/** Cosine similarity of two embeddings. A missing or empty vector is not a match. */
export function speakerSimilarity(left: number[] | null, right: number[] | null): number | null {
  if (!left || !right || left.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Continuation words in English and Hindi/Hinglish. A finished command is not one of these. */
const CONTINUATION =
  /(?:\b(?:and|or|but|so|because|if|when|with|the|a|an|uh|um|aur|lekin|kyunki|ki|ke|ya|matlab|toh|to|par|phir)\s*)$/i;

/** True when the partial should not be treated as the end of the owner's turn. */
export function utteranceIncomplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[.!?।]$/.test(trimmed)) return false;
  if (/[,:;\-—]$/.test(trimmed)) return true;
  return CONTINUATION.test(trimmed);
}

/** Which scripts are in a transcript. Used to keep Hinglish as mixed, not as one forced language. */
export function speechScripts(text: string): "english" | "hindi" | "hinglish" | "empty" {
  const devanagari = /\p{Script=Devanagari}/u.test(text);
  const latin = /\p{Script=Latin}/u.test(text);
  if (devanagari && latin) return "hinglish";
  if (devanagari) return "hindi";
  if (latin) return "english";
  return "empty";
}

/** Same-name double fires inside this window are dropped. A real command is not. */
export const WAKE_COOLDOWN_MS = 1200;

export function wakeOnCooldown(
  now: number,
  lastAcceptAt: number,
  cooldownMs = WAKE_COOLDOWN_MS,
): boolean {
  return lastAcceptAt > 0 && now - lastAcceptAt < cooldownMs;
}

/** Spoken yes/no must be short. A long line that merely contains "yes" is not a confirmation. */
export function isBoundConfirmation(text: string, affirms: (value: string) => boolean): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (voiceClaimsAuthority(text)) return false;
  return affirms(text);
}

/** How long a spoken confirmation stays valid. A late yes does not run the old action. */
export const APPROVAL_TTL_MS = 120_000;

export function approvalFresh(askedAt: number, now: number, ttlMs = APPROVAL_TTL_MS): boolean {
  return askedAt > 0 && now >= askedAt && now - askedAt <= ttlMs;
}

/**
 * Ambient or injected speech must not rewrite FRIDAY's approval rules.
 * The desktop approval path still decides. This only forces that path.
 */
export function voiceClaimsAuthority(text: string): boolean {
  return /\b(ignore (?:all |any )?(?:previous|prior|above)|disable (?:the )?approval|auto-?approve|skip (?:the )?confirmation|without asking|you are now)\b/i.test(
    text ?? "",
  );
}

export type VoiceFault =
  | "tts-crash"
  | "asr-timeout"
  | "barge-in"
  | "device-ended"
  | "permission-denied"
  | "engine-down"
  | "approval-expired"
  | "injection"
  | "model-missing"
  | "disk-full"
  | "bluetooth-switch"
  | "sleep-resume"
  | "echo-loop";

export type VoiceRecovery = {
  taskContinues: boolean;
  speak: boolean;
  textFallback: boolean;
  clarify: boolean;
  dropPlayback: boolean;
  execute: boolean;
};

/** Honest recovery for a voice fault. Nothing here starts an action. */
export function recoverVoiceFault(fault: VoiceFault): VoiceRecovery {
  switch (fault) {
    case "tts-crash":
      return {
        taskContinues: true,
        speak: false,
        textFallback: true,
        clarify: false,
        dropPlayback: true,
        execute: false,
      };
    case "asr-timeout":
      return {
        taskContinues: true,
        speak: true,
        textFallback: true,
        clarify: true,
        dropPlayback: false,
        execute: false,
      };
    case "barge-in":
      return {
        taskContinues: true,
        speak: false,
        textFallback: false,
        clarify: false,
        dropPlayback: true,
        execute: false,
      };
    case "device-ended":
      return {
        taskContinues: true,
        speak: false,
        textFallback: true,
        clarify: false,
        dropPlayback: false,
        execute: false,
      };
    case "permission-denied":
      return {
        taskContinues: false,
        speak: false,
        textFallback: true,
        clarify: false,
        dropPlayback: true,
        execute: false,
      };
    case "engine-down":
      return {
        taskContinues: false,
        speak: false,
        textFallback: true,
        clarify: true,
        dropPlayback: false,
        execute: false,
      };
    case "approval-expired":
      return {
        taskContinues: false,
        speak: true,
        textFallback: true,
        clarify: true,
        dropPlayback: false,
        execute: false,
      };
    case "injection":
      return {
        taskContinues: false,
        speak: false,
        textFallback: true,
        clarify: false,
        dropPlayback: false,
        execute: false,
      };
    case "model-missing":
      return {
        taskContinues: true,
        speak: false,
        textFallback: true,
        clarify: true,
        dropPlayback: false,
        execute: false,
      };
    case "disk-full":
      return {
        taskContinues: false,
        speak: false,
        textFallback: true,
        clarify: true,
        dropPlayback: false,
        execute: false,
      };
    case "bluetooth-switch":
    case "sleep-resume":
      return {
        taskContinues: true,
        speak: false,
        textFallback: true,
        clarify: false,
        dropPlayback: false,
        execute: false,
      };
    case "echo-loop":
      return {
        taskContinues: true,
        speak: false,
        textFallback: false,
        clarify: false,
        dropPlayback: true,
        execute: false,
      };
    default: {
      const _never: never = fault;
      return _never;
    }
  }
}

/** A capture is alive only when the track was actually obtained. */
export function micCaptureHonest(state: string, available: boolean): boolean {
  return state === "available" && available;
}

/**
 * Owner-voice match is an extra signal for a sensitive action.
 * It is off until a local verifier exists, and it never replaces desktop approval.
 */
export const OWNER_VOICE_GATE_ENABLED = false;

export function sensitiveNeedsOwnerVoice(input: {
  enabled: boolean;
  verified: boolean | null;
  consequential: boolean;
}): boolean {
  if (!input.enabled || !input.consequential) return false;
  return input.verified !== true;
}

export type NoticeDelivery = "now" | "later" | "drop";

/**
 * A background notice yields to the owner, quiet hours, and the kill switch.
 * An owner turn is not a notice. Urgent does not speak during quiet hours.
 */
export function backgroundNotice(input: {
  killed: boolean;
  quiet: boolean;
  ownerBusy: boolean;
  urgent: boolean;
  meeting?: boolean;
}): { deliver: NoticeDelivery; reason: string } {
  if (input.killed) return { deliver: "drop", reason: "kill switch" };
  if (input.meeting) return { deliver: "later", reason: "call in progress" };
  if (input.quiet) return { deliver: "later", reason: "quiet hours" };
  if (input.ownerBusy) return { deliver: "later", reason: "yield to the owner" };
  return { deliver: "now", reason: input.urgent ? "urgent notice" : "background notice" };
}

export type VoiceAudit = { at: number; heard: string; decision: string; action: string };

export function pushVoiceAudit(log: VoiceAudit[], entry: VoiceAudit, cap = 40): VoiceAudit[] {
  return [...log, entry].slice(-cap);
}

export type TurnClock = {
  heardAt: number | null;
  finalAt: number | null;
  tokenAt: number | null;
  audioAt: number | null;
};

export function turnSpans(clock: TurnClock): {
  sttMs: number | null;
  tokenMs: number | null;
  audioMs: number | null;
} {
  const gap = (from: number | null, to: number | null) =>
    from != null && to != null && to >= from ? to - from : null;
  return {
    sttMs: gap(clock.heardAt, clock.finalAt),
    tokenMs: gap(clock.finalAt, clock.tokenAt),
    audioMs: gap(clock.tokenAt, clock.audioAt),
  };
}

/** Hardware budgets are not a pass when the span was never measured. */
export function withinBudget(
  ms: number | null,
  budgetMs: number,
): "unmeasured" | "inside" | "over" {
  if (ms == null) return "unmeasured";
  return ms <= budgetMs ? "inside" : "over";
}

/** Playback should be gone within this bound after a barge-in. The brain turn is separate. */
export const BARGE_IN_STOP_BUDGET_MS = 200;

/** First local audio after the reply is ready. Hardware stays unmeasured until a clock is set. */
export const FIRST_AUDIO_BUDGET_MS = 1000;

/**
 * Finished sentences can be spoken while the rest of the answer is still
 * arriving. The tail is spoken only when the turn is final. Punctuation must
 * be followed by whitespace so a version like "v1.2" is not a sentence end.
 */
export function takeSpeakable(
  pending: string,
  final: boolean,
): { spoken: string; consumed: number } {
  if (!pending.trim()) return { spoken: "", consumed: 0 };
  if (final) return { spoken: pending.trim(), consumed: pending.length };
  const re = /[.!?।](?=\s)/g;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pending))) end = match.index + 1;
  if (end < 0) return { spoken: "", consumed: 0 };
  let consumed = end;
  while (consumed < pending.length && /\s/.test(pending[consumed] ?? "")) consumed += 1;
  return { spoken: pending.slice(0, end).trim(), consumed };
}

/** How many capture reopens follow a lost device. Matches the gate backoff. */
export const CAPTURE_RETRY_CAP = 6;

export function captureMayRetry(attempt: number, cap = CAPTURE_RETRY_CAP): boolean {
  return attempt >= 0 && attempt < cap;
}

export type AudioHealth =
  | "live"
  | "permission-denied"
  | "no-device"
  | "busy"
  | "recovering"
  | "asleep"
  | "exclusive"
  | "unavailable";

/** A dead microphone must not be reported as live. */
export function audioHealth(input: {
  state: string;
  available: boolean;
  recovering?: boolean;
  suspended?: boolean;
  exclusive?: boolean;
}): AudioHealth {
  if (input.suspended) return "asleep";
  if (input.exclusive) return "exclusive";
  if (input.recovering) return "recovering";
  if (input.available && input.state === "available") return "live";
  if (input.state === "permission-denied" || input.state === "permission-required")
    return "permission-denied";
  if (input.state === "no-microphone") return "no-device";
  if (input.state === "device-offline") return "busy";
  return "unavailable";
}

/**
 * Cloud speech is allowed only when the owner picked a cloud voice and the
 * text is not sensitive. Local and system speech do not use this gate.
 */
export function cloudSpeechAllowed(input: {
  optedIn: boolean;
  sensitive: boolean;
  privacy?: boolean;
}): boolean {
  if (input.privacy) return false;
  return input.optedIn === true && input.sensitive !== true;
}

/**
 * Model size for the existing faster-whisper worker.
 * The live default stays the requested model unless auto tiering is on and
 * RAM was actually measured. Unknown hardware does not change today's model.
 * On battery a medium or large model steps down to small.
 */
export function applySttTier(input: {
  requested?: string;
  auto: boolean;
  ramGb: number;
  gpu: boolean;
  battery: boolean;
}): string {
  const requested = input.requested?.trim() || "small";
  if (!input.auto || !(input.ramGb > 0)) return requested;
  let tier = "small";
  if (input.ramGb < 4) tier = "tiny";
  else if (input.ramGb < 8) tier = "base";
  else if (input.gpu && input.ramGb >= 16) tier = "large-v3";
  else if (input.ramGb >= 16) tier = "medium";
  if (input.battery && (tier === "medium" || tier === "large-v3")) tier = "small";
  return tier;
}

/** Feeling labels become a delivery pace. They do not grant a permission. */
export function prosodyAffect(label: string): "neutral" | "calm" | "urgent" {
  if (label === "hurry" || label === "anger") return "urgent";
  if (label === "sadness" || label === "distress" || label === "anxiety") return "calm";
  return "neutral";
}

/** Tone changes rate, pitch, and volume only. It never changes a permission. */
export function speakingProsody(input: {
  baseRate: number;
  basePitch: number;
  baseVolume: number;
  affect?: "neutral" | "calm" | "urgent";
  quiet?: boolean;
  whisper?: boolean;
}): { rate: number; pitch: number; volume: number } {
  let rate = input.baseRate;
  let pitch = input.basePitch;
  let volume = input.baseVolume;
  if (input.affect === "urgent") rate = Math.min(1.15, rate * 1.06);
  if (input.affect === "calm") {
    rate = Math.max(0.85, rate * 0.94);
    pitch = Math.max(0.9, pitch * 0.98);
  }
  if (input.quiet) volume = Math.min(volume, 0.45);
  if (input.whisper) volume = Math.min(volume, 0.28);
  return { rate, pitch, volume };
}

/** A short acknowledgement, at most once per turn, and only in Auto mode. */
export function backchannel(input: {
  hold: boolean;
  usedThisTurn: boolean;
  mode: VoiceSurface;
}): string {
  if (input.mode !== "auto" || !input.hold || input.usedThisTurn) return "";
  return "Mm-hmm.";
}

/** Filled pauses are not commands. */
export function isHoldSound(text: string): boolean {
  return /^(uh+|um+|hmm+|mm+|haan|achha)\.?$/i.test(text.trim());
}

/** Speech aimed at another assistant is not a FRIDAY turn. */
export function foreignAssistant(text: string): boolean {
  return /\b(hey|ok|okay)\s+(google|alexa|siri)\b|\b(alexa|ok google|hey google|hey siri)\b/i.test(
    text,
  );
}

/** A bare pronoun is a question, not a guess. A real question still goes through. */
export function clarifyPrompt(text: string): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return "";
  if (/^(what|who|when|where|why|how|kya|kaun|kab)\b/i.test(trimmed)) return "";
  if (/\b(it|that|this|them|woh|wo|वो|ये)\b/i.test(trimmed)) return "Which one do you mean?";
  return "";
}

export function wantsContinue(text: string): boolean {
  return /^(continue|go on|keep going|resume|aage bolo|jaari rakho)\b/i.test(text.trim());
}

/** Unspoken remainder after a barge-in. Empty when nothing was in flight. */
export function holdInterrupted(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
}

/** Short line FRIDAY can say when a stage fails. It does not run an action. */
export function spokenFailure(fault: VoiceFault): string {
  switch (fault) {
    case "asr-timeout":
      return "I didn't catch that. Say it once more.";
    case "tts-crash":
    case "model-missing":
      return "I can't speak that voice right now. The answer is on screen.";
    case "permission-denied":
      return "The microphone is blocked. Allow it in Windows, then try again.";
    case "device-ended":
    case "bluetooth-switch":
      return "The microphone dropped. I am still here in text.";
    case "sleep-resume":
      return "I am listening again.";
    case "disk-full":
      return "The disk is too full for a voice model. I will stay in text.";
    case "engine-down":
      return "Voice is not ready yet. I can still read what you type.";
    case "approval-expired":
      return "That yes expired. Ask again if you still want it.";
    case "injection":
      return "I ignored that. It does not change what I am allowed to do.";
    case "echo-loop":
    case "barge-in":
      return "";
    default: {
      const _never: never = fault;
      return _never;
    }
  }
}

export function wordErrorRate(reference: string, hypothesis: string): number {
  const tokenize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const dp: number[] = new Array(cols);
  for (let col = 0; col < cols; col += 1) dp[col] = col;
  for (let row = 1; row < rows; row += 1) {
    let prev = dp[0] ?? 0;
    dp[0] = row;
    for (let col = 1; col < cols; col += 1) {
      const current = dp[col] ?? 0;
      const cost = ref[row - 1] === hyp[col - 1] ? 0 : 1;
      dp[col] = Math.min((dp[col] ?? 0) + 1, (dp[col - 1] ?? 0) + 1, prev + cost);
      prev = current;
    }
  }
  return (dp[cols - 1] ?? ref.length) / ref.length;
}

/** False accepts per hour. No elapsed time means the rate was not measured. */
export function falseWakeRate(falseAccepts: number, hours: number): number | null {
  if (!(hours > 0)) return null;
  return falseAccepts / hours;
}

export const FALSE_WAKE_BUDGET_PER_HOUR = 1;

export type VoiceEvalStage = {
  stage: string;
  value: number | null;
  budget: number | null;
  verdict: "pass" | "fail" | "unmeasured";
};

/** Offline numbers from fixtures and injected clocks. Hardware stays unmeasured. */
export function voiceEval(input?: {
  bargeInStopMs?: number | null;
  firstAudioMs?: number | null;
}): VoiceEvalStage[] {
  const wer = wordErrorRate("open chrome", "open chrome");
  const slipped = wordErrorRate("open chrome", "open chroma");
  const endpoint = endpointSilenceMs(true, "open chrome and");
  const barge = withinBudget(input?.bargeInStopMs ?? null, BARGE_IN_STOP_BUDGET_MS);
  const firstAudio = withinBudget(input?.firstAudioMs ?? null, FIRST_AUDIO_BUDGET_MS);
  const wakes = falseWakeRate(0, 0);
  return [
    { stage: "wer-clean", value: wer, budget: 0, verdict: wer === 0 ? "pass" : "fail" },
    {
      stage: "wer-one-slip",
      value: slipped,
      budget: 0.5,
      verdict: slipped <= 0.5 ? "pass" : "fail",
    },
    {
      stage: "endpoint-cap",
      value: endpoint,
      budget: 1600,
      verdict: endpoint <= 1600 ? "pass" : "fail",
    },
    {
      stage: "barge-in-stop",
      value: input?.bargeInStopMs ?? null,
      budget: BARGE_IN_STOP_BUDGET_MS,
      verdict: barge === "inside" ? "pass" : barge === "over" ? "fail" : "unmeasured",
    },
    {
      stage: "first-audio",
      value: input?.firstAudioMs ?? null,
      budget: FIRST_AUDIO_BUDGET_MS,
      verdict: firstAudio === "inside" ? "pass" : firstAudio === "over" ? "fail" : "unmeasured",
    },
    {
      stage: "false-wake",
      value: wakes,
      budget: FALSE_WAKE_BUDGET_PER_HOUR,
      verdict: "unmeasured",
    },
  ];
}

type VoiceSurfaceRead = { mode: VoiceSurface; muted: boolean };

let readSurface: () => VoiceSurfaceRead = () => ({ mode: "manual", muted: false });

/** Assistant mode publishes the live surface. Before that, speech stays shut. */
export function bindVoiceSurface(read: () => VoiceSurfaceRead) {
  readSurface = read;
}

export function readVoiceSurface(): VoiceSurfaceRead {
  return readSurface();
}
