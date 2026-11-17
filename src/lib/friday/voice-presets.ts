/**
 * FRIDAY · her own voice: the best-known defaults, the presets, and what Settings → Voice → FRIDAY's voice offers.
 *
 * The default is a female Indian voice that speaks Hindi and English: Swara for Hindi and Neerja for Indian
 * English (the only female hi-IN and en-IN voices Microsoft's online neural service lists). Microsoft's neural
 * voices infer their own intonation, so "natural" means close to the voice's own pace and pitch: small changes
 * sound better than large ones, and the presets stay close to that.
 *
 * Nothing here plays audio. The pickers set preferences; `neuralVoiceFor` (voice-library.ts) reads them per clause,
 * so a Hinglish reply is spoken by the Hindi voice for Devanagari and by the English voice for Latin runs.
 */
import type { VoicePreferences } from "./preferences";

export type IndianVoice = {
  id: string;
  label: string;
  lang: "hi-IN" | "en-IN";
  /** One plain line on how it sounds. */
  note: string;
};

/** Female Indian voices of the online neural service, in the order they are offered. */
export const INDIAN_FEMALE_VOICES: IndianVoice[] = [
  {
    id: "hi-IN-SwaraNeural",
    label: "Swara · Hindi (India)",
    lang: "hi-IN",
    note: "Friendly, positive. Reads Devanagari and Hinglish; the default Hindi voice.",
  },
  {
    id: "en-IN-NeerjaNeural",
    label: "Neerja · English (India)",
    lang: "en-IN",
    note: "Friendly, positive Indian English; the default English voice.",
  },
  {
    id: "en-IN-NeerjaExpressiveNeural",
    label: "Neerja Expressive · English (India)",
    lang: "en-IN",
    note: "The same voice with more emotion in her delivery.",
  },
];

export const DEFAULT_HINDI_VOICE = "hi-IN-SwaraNeural";
export const DEFAULT_ENGLISH_VOICE = "en-IN-NeerjaNeural";

export type VoicePresetId = "natural" | "warm" | "bright" | "calm";

export type VoicePreset = {
  id: VoicePresetId;
  label: string;
  hint: string;
  rate: number;
  pitch: number;
  volume: number;
  expressiveSpeech: boolean;
  whisperMode: boolean;
};

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: "natural",
    label: "Natural (recommended)",
    hint: "The voice's own pace and pitch, a touch slower so Hinglish is easy to follow.",
    rate: 0.97,
    pitch: 1,
    volume: 1,
    expressiveSpeech: true,
    whisperMode: false,
  },
  {
    id: "warm",
    label: "Warm and soft",
    hint: "A little slower and brighter, a little quieter.",
    rate: 0.93,
    pitch: 1.04,
    volume: 0.95,
    expressiveSpeech: true,
    whisperMode: false,
  },
  {
    id: "bright",
    label: "Bright and quick",
    hint: "Brisker and lively, for short answers.",
    rate: 1.06,
    pitch: 1.04,
    volume: 1,
    expressiveSpeech: true,
    whisperMode: false,
  },
  {
    id: "calm",
    label: "Calm and low",
    hint: "Slower and lower, for evenings.",
    rate: 0.92,
    pitch: 0.96,
    volume: 0.95,
    expressiveSpeech: true,
    whisperMode: false,
  },
];

export const BEST_PRESET: VoicePresetId = "natural";

/** What "Reset to the best voice" sets: the voices, the natural preset and nothing that is the owner's own choice. */
export function bestVoiceFields(): Partial<VoicePreferences> {
  const preset = VOICE_PRESETS[0]!;
  return {
    hindiVoice: DEFAULT_HINDI_VOICE,
    englishVoice: DEFAULT_ENGLISH_VOICE,
    voicePreset: preset.id,
    rate: preset.rate,
    pitch: preset.pitch,
    volume: preset.volume,
    expressiveSpeech: preset.expressiveSpeech,
    whisperMode: preset.whisperMode,
    speakReplies: true,
    hinglish: true,
  };
}

export function presetFields(id: VoicePresetId): Partial<VoicePreferences> {
  const preset = VOICE_PRESETS.find((row) => row.id === id) ?? VOICE_PRESETS[0]!;
  return {
    voicePreset: preset.id,
    rate: preset.rate,
    pitch: preset.pitch,
    volume: preset.volume,
    expressiveSpeech: preset.expressiveSpeech,
    whisperMode: preset.whisperMode,
  };
}

/** Which preset the sliders currently equal ("custom" once the owner moved them). */
export function detectPreset(
  voice: Pick<VoicePreferences, "rate" | "pitch" | "volume">,
): VoicePresetId | "custom" {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  for (const preset of VOICE_PRESETS) {
    if (
      near(voice.rate, preset.rate) &&
      near(voice.pitch, preset.pitch) &&
      near(voice.volume, preset.volume)
    ) {
      return preset.id;
    }
  }
  return "custom";
}

/** The sample lines the preview buttons speak: Hindi, English and a Hinglish line of the kind she really says. */
export const PREVIEW_LINES = {
  hi: "नमस्ते, मैं फ्राइडे हूँ। आज मैं आपकी कैसे मदद करूँ?",
  en: "Hello, I'm Friday. How can I help you today?",
  hinglish: "Namaste, main Friday hoon. Aaj ka schedule check karoon ya ek reminder laga doon?",
} as const;

/** The first FRIDAY shipped a bright, slightly slow delivery. An install still on exactly those numbers never chose them. */
const OLD_DEFAULT = { rate: 0.96, pitch: 1.12, volume: 1 };

/**
 * Move a saved voice that still holds the old shipped numbers to the natural preset, once. Anything the owner
 * changed (even one slider) is left exactly as it is. Returns the same object when nothing changes.
 */
export function upgradeVoiceDefaults<T extends Partial<VoicePreferences>>(
  voice: T,
): { voice: T; changed: boolean } {
  if ((voice.voicePresetVersion ?? 0) >= 1) return { voice, changed: false };
  const untouched =
    voice.rate === OLD_DEFAULT.rate &&
    voice.pitch === OLD_DEFAULT.pitch &&
    voice.volume === OLD_DEFAULT.volume;
  const preset = VOICE_PRESETS[0]!;
  return {
    voice: {
      ...voice,
      ...(untouched
        ? { rate: preset.rate, pitch: preset.pitch, volume: preset.volume, voicePreset: preset.id }
        : {}),
      voicePresetVersion: 1,
    },
    changed: true,
  };
}

/** The Edge neural pitch offset, in Hz, for the pitch multiplier (1 = the voice's own pitch). Clamped to ±40 Hz. */
export function pitchOffsetHz(pitch: number): number {
  const value = Number(pitch);
  if (!Number.isFinite(value)) return 0;
  return Math.max(-40, Math.min(40, Math.round((value - 1) * 150)));
}
