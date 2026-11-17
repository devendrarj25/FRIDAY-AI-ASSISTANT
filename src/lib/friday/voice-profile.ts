/**
 * FRIDAY · the owner's own voice, renderer side.
 *
 * Settings → Voice records short samples of the owner (electron/voice-enroll.cjs keeps them and the kernel builds a
 * voiceprint and a personal "Friday" template from them). This file holds the guided prompts, what is enough,
 * and the three decisions Auto mode takes from a scored utterance:
 *
 *   * a sensitive command from a voice that does not match is not run on a voice match, and a match never
 *     approves anything (speakerDecision in voice-session.ts is unchanged: it can only block);
 *   * with "only answer my voice" on, an utterance that clearly is not the owner's is ignored (a stop is always heard);
 *   * with the personal wake on, the owner saying "Friday" wakes her even when the transcriber wrote something else.
 *
 * Nothing is sent anywhere. With no saved voice every function here is a no-op and `scoreUtterance` answers at once.
 */
import { desktopApi } from "./desktop";
import type {
  VoiceEnrollCounts,
  VoiceEnrollStatus,
  VoiceMatchResult,
  VoiceProfileSummary,
} from "./desktop";

export type EnrollPrompt = {
  id: string;
  kind: "wake" | "speech";
  language: "en" | "hi" | "hinglish";
  /** What to say. `{wake}` is replaced by the wake word. */
  text: string;
  /** How to say it (wake takes vary on purpose: the template must cover the owner's real voice). */
  hint: string;
};

const WAKE_HINTS = [
  "in your normal voice",
  "in your normal voice again",
  "a little softer, as if the room is quiet",
  "a little louder",
  "from a bit farther away from the microphone",
  "quickly",
  "slowly",
  "as if you are calling her from across the room",
];

export const WAKE_PROMPTS: EnrollPrompt[] = WAKE_HINTS.map((hint, index) => ({
  id: `wake-${index + 1}`,
  kind: "wake",
  language: "en",
  text: "{wake}",
  hint,
}));

export const SPEECH_PROMPTS: EnrollPrompt[] = [
  {
    id: "en-1",
    kind: "speech",
    language: "en",
    text: "{wake}, what is on my calendar for tomorrow?",
    hint: "natural pace",
  },
  {
    id: "en-2",
    kind: "speech",
    language: "en",
    text: "Please open the downloads folder and show me the newest file.",
    hint: "natural pace",
  },
  {
    id: "en-3",
    kind: "speech",
    language: "en",
    text: "Remind me to call my brother at six in the evening.",
    hint: "natural pace",
  },
  {
    id: "hi-1",
    kind: "speech",
    language: "hi",
    text: "{wake}, आज मौसम कैसा है?",
    hint: "Hindi, natural pace",
  },
  {
    id: "hi-2",
    kind: "speech",
    language: "hi",
    text: "मेरी आज की सारी मीटिंग्स की सूची बताओ।",
    hint: "Hindi",
  },
  {
    id: "hi-3",
    kind: "speech",
    language: "hi",
    text: "कृपया स्क्रीन की चमक थोड़ी कम कर दो।",
    hint: "Hindi",
  },
  {
    id: "hg-1",
    kind: "speech",
    language: "hinglish",
    text: "{wake}, mera kal ka schedule batao aur ek reminder laga do.",
    hint: "Hinglish",
  },
  {
    id: "hg-2",
    kind: "speech",
    language: "hinglish",
    text: "Yeh file copy karke Desktop par rakh do.",
    hint: "Hinglish",
  },
  {
    id: "hg-3",
    kind: "speech",
    language: "hinglish",
    text: "Aaj ka kaam ek ek karke yaad dilana, please.",
    hint: "Hinglish",
  },
  {
    id: "hg-4",
    kind: "speech",
    language: "hinglish",
    text: "Notepad kholo aur likho: kal subah nau baje meeting hai.",
    hint: "Hinglish",
  },
];

export const ALL_PROMPTS: EnrollPrompt[] = [...WAKE_PROMPTS, ...SPEECH_PROMPTS];

export function promptText(prompt: EnrollPrompt, wakeWord: string): string {
  return prompt.text.replace("{wake}", (wakeWord || "Friday").trim() || "Friday");
}

/** What the kernel needs before it builds each part (kernel/voice_enroll.py has the same numbers). */
export const MIN_WAKE_TAKES = 5;
export const GOOD_WAKE_TAKES = 8;
export const MIN_SPEECH_CLIPS = 6;
export const MIN_SPEECH_SECONDS = 20;

export type EnrollProgress = {
  wakeTakes: number;
  speechClips: number;
  speechSeconds: number;
  wakeEnough: boolean;
  speechEnough: boolean;
  canBuild: boolean;
  /** One plain line saying what is still missing, or "" when nothing is. */
  missing: string;
};

export function enrollProgress(counts: VoiceEnrollCounts | null | undefined): EnrollProgress {
  const wakeTakes = counts?.wakeTakes ?? 0;
  const speechClips = counts?.speechClips ?? 0;
  const speechSeconds = counts?.speechSeconds ?? 0;
  const wakeEnough = wakeTakes >= MIN_WAKE_TAKES;
  const speechEnough = speechClips >= MIN_SPEECH_CLIPS && speechSeconds >= MIN_SPEECH_SECONDS;
  const missing: string[] = [];
  if (!speechEnough) {
    const clips = Math.max(0, MIN_SPEECH_CLIPS - speechClips);
    missing.push(
      clips > 0
        ? `${clips} more sentence${clips === 1 ? "" : "s"}`
        : `about ${Math.max(1, Math.ceil(MIN_SPEECH_SECONDS - speechSeconds))} more seconds of speech`,
    );
  }
  if (!wakeEnough) {
    const takes = MIN_WAKE_TAKES - wakeTakes;
    missing.push(`${takes} more take${takes === 1 ? "" : "s"} of the wake word`);
  }
  return {
    wakeTakes,
    speechClips,
    speechSeconds,
    wakeEnough,
    speechEnough,
    // The voiceprint needs the sentences; the personal wake needs the takes. Either part is worth building.
    canBuild: speechEnough || wakeEnough,
    missing: missing.length ? `Still needed: ${missing.join(" and ")}.` : "",
  };
}

// ----------------------------------------------------------------------------- the three decisions
export type VoiceSettingsView = {
  /** Block a sensitive command from a voice that does not match (never approves anything). */
  recogniseMyVoice: boolean;
  /** Ignore what clearly is not the owner's voice. A stop is always heard. */
  ownerVoiceOnly: boolean;
  /** The owner's own "Friday" template may wake her when the transcript missed the word. */
  personalWake: boolean;
  /** Similarity the owner's voice must reach; 0.75 is the edge the kernel calibrated. */
  threshold: number;
};

export const DEFAULT_THRESHOLD = 0.75;

export function parseThreshold(value: string | undefined | null): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0.3 && n <= 0.99 ? n : DEFAULT_THRESHOLD;
}

/**
 * Is this the owner's voice? `null` means it cannot be told (no saved voice, or too little speech in the clip): the
 * caller must treat that as "unknown", never as a mismatch.
 */
export function ownerVoice(
  voice: VoiceMatchResult | null | undefined,
  threshold = DEFAULT_THRESHOLD,
): boolean | null {
  const speaker = voice?.speaker;
  if (!speaker?.enrolled || speaker.similarity == null) return null;
  return speaker.similarity >= threshold;
}

export type VoiceTurnGate = {
  /** Drop the whole utterance: it is clearly another voice and the owner asked for only theirs. */
  ignore: boolean;
  /** The owner's personal "Friday" template matched although the transcript did not carry the word. */
  personalWake: boolean;
  reason: string;
};

export function voiceTurnGate(input: {
  voice: VoiceMatchResult | null | undefined;
  settings: VoiceSettingsView;
  transcriptWake: boolean;
  isStop: boolean;
  words: number;
}): VoiceTurnGate {
  const { voice, settings } = input;
  const mine = ownerVoice(voice, settings.threshold);
  if (settings.ownerVoiceOnly && mine === false && !input.isStop) {
    return { ignore: true, personalWake: false, reason: "not the owner's voice" };
  }
  // A template match only ever helps the owner: it needs the owner's voice to match when that can be told.
  if (
    settings.personalWake &&
    !input.transcriptWake &&
    voice?.wake?.ready === true &&
    voice.wake.matched === true &&
    mine !== false &&
    input.words <= 3
  ) {
    return { ignore: false, personalWake: true, reason: "the owner's own Friday template matched" };
  }
  return { ignore: false, personalWake: false, reason: "" };
}

/** Names and words the owner listed, split on commas and line breaks, trimmed, de-duplicated, at most 30. */
export function parseVocabulary(value: string | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(value ?? "").split(/[,\n;]+/)) {
    const word = raw.trim().slice(0, 40);
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= 30) break;
  }
  return out;
}

/** For `speakerDecision`: the score of this turn, when the owner turned recognition on and a voice is saved. */
export function speakerInput(
  voice: VoiceMatchResult | null | undefined,
  settings: VoiceSettingsView,
): { similarity: number | null; enrolled: boolean; threshold: number } {
  if (!settings.recogniseMyVoice || !voice?.speaker?.enrolled) {
    return { similarity: null, enrolled: false, threshold: settings.threshold };
  }
  return {
    similarity: voice.speaker.similarity ?? null,
    enrolled: true,
    threshold: settings.threshold,
  };
}

// ----------------------------------------------------------------------------- state and the bridge
type State = { status: VoiceEnrollStatus | null; loadedAt: number };
let state: State = { status: null, loadedAt: 0 };
const listeners = new Set<() => void>();

export function subscribeVoiceProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function voiceProfileSnapshot(): VoiceEnrollStatus | null {
  return state.status;
}

function publish(status: VoiceEnrollStatus | null) {
  state = { status, loadedAt: Date.now() };
  for (const listener of [...listeners]) listener();
}

/** Read what is saved. Cheap; the Auto mode scorer calls it once at start and after every change. */
export async function refreshVoiceProfile(): Promise<VoiceEnrollStatus | null> {
  const api = desktopApi();
  if (!api?.voiceEnrollStatus) return null;
  try {
    const status = await api.voiceEnrollStatus();
    publish(status?.ok ? status : null);
    return state.status;
  } catch {
    return state.status;
  }
}

/** True when a saved profile can score utterances: only then is the per-utterance IPC worth paying. */
export function voiceProfileBuilt(): boolean {
  return state.status?.profile.built === true;
}

/** Score one utterance. Answers `null` at once when no voice is saved, so a PC without one pays nothing. */
export async function scoreUtterance(payload: {
  audioBytes: Uint8Array;
  mime?: string;
}): Promise<VoiceMatchResult | null> {
  if (!voiceProfileBuilt()) return null;
  const api = desktopApi();
  if (!api?.voiceEnrollScore) return null;
  try {
    const result = await api.voiceEnrollScore(payload);
    return result?.ok ? result : null;
  } catch {
    return null;
  }
}

export async function saveSample(input: {
  prompt: EnrollPrompt;
  take: number;
  text: string;
  wavBytes: Uint8Array;
}): Promise<{ ok: boolean; message: string }> {
  const api = desktopApi();
  if (!api?.voiceEnrollSaveSample)
    return { ok: false, message: "Recording samples needs the desktop app." };
  const result = await api.voiceEnrollSaveSample({
    id: `${input.prompt.id}-${input.take}`,
    kind: input.prompt.kind,
    promptId: input.prompt.id,
    text: input.text,
    language: input.prompt.language,
    wavBytes: input.wavBytes,
  });
  await refreshVoiceProfile();
  return result.ok
    ? { ok: true, message: "Saved." }
    : { ok: false, message: result.detail || result.reason || "That recording was not saved." };
}

export async function deleteSample(id: string): Promise<void> {
  await desktopApi()?.voiceEnrollDeleteSample?.(id);
  await refreshVoiceProfile();
}

export async function buildProfile(): Promise<{
  ok: boolean;
  message: string;
  summary?: VoiceProfileSummary;
}> {
  const api = desktopApi();
  if (!api?.voiceEnrollBuild)
    return { ok: false, message: "Building a voiceprint needs the desktop app." };
  const result = await api.voiceEnrollBuild();
  await refreshVoiceProfile();
  return result.ok
    ? {
        ok: true,
        message: "Your voice profile is ready.",
        ...(result.summary ? { summary: result.summary } : {}),
      }
    : { ok: false, message: result.error || "The voice profile was not built." };
}

export async function clearRecordings(): Promise<void> {
  await desktopApi()?.voiceEnrollClearRecordings?.();
  await refreshVoiceProfile();
}

export async function forgetMyVoice(): Promise<void> {
  const status = await desktopApi()?.voiceEnrollForget?.();
  publish(status?.ok ? status : null);
}

/** Reset the cache (tests). */
export function resetVoiceProfileForTests(): void {
  state = { status: null, loadedAt: 0 };
  listeners.clear();
}
