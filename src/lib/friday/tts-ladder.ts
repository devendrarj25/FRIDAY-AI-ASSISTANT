import { HINDI_LIGHT_ENGINE, legacyEngineChoice } from "./voice-engine/tts-provider";

export {
  HINDI_LIGHT_ENGINE,
  HINDI_LIGHT_MODEL_ID,
  chooseHindiLightVoice,
  hindiLightSpeakable,
  type HindiLightChoice,
} from "./voice-engine/tts-provider";

export type TtsEngine = "neural" | "supertonic" | "sapi";

/**
 * Neural online, Supertonic offline, then the system voice. Privacy stays on the system voice.
 * The decision is the one ranking in `voice-engine/tts-provider.ts` (the fallback manager's order).
 */
export function chooseTtsEngine(input: {
  network: boolean;
  supertonicReady: boolean;
  privacy: boolean;
  prefer?: "auto" | TtsEngine;
}): TtsEngine {
  return legacyEngineChoice(input) as TtsEngine;
}

const HINDI_LIGHT_WHY: Record<string, string> = {
  "hindi-light-not-installed": "it is not downloaded (Models, Hindi light voice)",
  "hindi-light-needs-hindi": "the line was not Hindi",
  "hindi-light-needs-devanagari-only": "the line was not Devanagari only",
  "hindi-light-failed": "it failed on this line",
  "unknown-engine": "this FRIDAY did not know the engine asked for",
};

/** One honest line for a clause that asked for the light Hindi voice and was spoken by another engine. */
export function hindiLightFallbackNote(reply: { engine?: string; fallback?: string }): string {
  if (String(reply.engine || "").toLowerCase() === HINDI_LIGHT_ENGINE) return "";
  const code = String(reply.fallback || "").trim();
  const why =
    HINDI_LIGHT_WHY[code] ?? (code ? `reason: ${code.slice(0, 60)}` : "no reason was given");
  return `The light Hindi voice did not speak a line (${why}); the standard voice did.`;
}

export function switchMidSentence(input: {
  networkDropped: boolean;
  current: TtsEngine;
  supertonicReady: boolean;
}): TtsEngine {
  if (!input.networkDropped || input.current !== "neural") return input.current;
  return legacyEngineChoice({
    network: false,
    supertonicReady: input.supertonicReady,
    privacy: false,
  }) as TtsEngine;
}

export function voiceForLanguage(lang: string): { lang: string; note: string } {
  const value = String(lang || "").toLowerCase();
  if (value.startsWith("hi")) return { lang: "hi-IN", note: "Hindi voice" };
  if (value === "hinglish" || value === "en-in") return { lang: "hi-IN", note: "Hinglish voice" };
  return { lang: "en-IN", note: "English voice" };
}

export function firstAudioLatency(tokenAt: number | null, audioAt: number | null): number | null {
  if (tokenAt == null || audioAt == null) return null;
  return Math.max(0, audioAt - tokenAt);
}

export function outputReachable(input: { deviceId: string; volume: number }): {
  ok: boolean;
  reason: string;
} {
  if (!input.deviceId) return { ok: false, reason: "no output device" };
  if (!(input.volume > 0)) return { ok: false, reason: "volume is silent" };
  return { ok: true, reason: "a speak test can use this device" };
}
