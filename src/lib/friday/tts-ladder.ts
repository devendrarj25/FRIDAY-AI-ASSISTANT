export type TtsEngine = "neural" | "supertonic" | "sapi";

/** Neural online, Supertonic offline, then the system voice. Privacy stays on the system voice. */
export function chooseTtsEngine(input: {
  network: boolean;
  supertonicReady: boolean;
  privacy: boolean;
  prefer?: "auto" | TtsEngine;
}): TtsEngine {
  if (input.privacy || input.prefer === "sapi") return "sapi";
  if (input.prefer === "supertonic") return input.supertonicReady ? "supertonic" : "sapi";
  if (!input.network) return input.supertonicReady ? "supertonic" : "sapi";
  if (input.prefer === "neural") return "neural";
  return "neural";
}

/** The optional light Hindi voice: a local engine of the raw-sample voice op, never a cloud voice. */
export const HINDI_LIGHT_ENGINE = "hindi-light";
/** Its row in the Models page (and the id the models store reports as installed). */
export const HINDI_LIGHT_MODEL_ID = "hindi-light-tts";

/**
 * True when the whole clause is Devanagari the light voice can say: at least one Devanagari letter, no Latin or
 * other letter and no digit (the same rule as `tts_hindi_light.speakable` in the kernel, which decides again).
 */
export function hindiLightSpeakable(text: string): boolean {
  const value = String(text || "");
  if (!/[\u0904-\u0939\u0958-\u0961]/.test(value)) return false;
  return !/[\p{Nd}]/u.test(value) && !/[^\P{L}\u0900-\u097F]/u.test(value);
}

export type HindiLightChoice = { use: boolean; note: string };

/**
 * Whether one clause asks for the light Hindi voice. It does when the setting is on, the clause is a local one
 * (no cloud voice picked for it), it is Hindi in Devanagari only, and the voice is not known to be missing.
 * `installed` is true or false when the Models page knows, null before its first look; null still asks, because
 * the kernel falls back to the standard local voice by itself and says so. Privacy mode does not matter here:
 * the engine runs on this PC and the cloud rules (`allowCloud`) are decided before this point and unchanged.
 */
export function chooseHindiLightVoice(input: {
  enabled: boolean;
  installed: boolean | null;
  local: boolean;
  lang: string;
  text: string;
}): HindiLightChoice {
  if (!input.enabled) return { use: false, note: "" };
  if (
    !input.local ||
    !String(input.lang || "")
      .toLowerCase()
      .startsWith("hi")
  ) {
    return { use: false, note: "" };
  }
  if (!hindiLightSpeakable(input.text)) return { use: false, note: "" };
  if (input.installed === false) {
    return {
      use: false,
      note: "The light Hindi voice is on but not downloaded (Models, Hindi light voice); the standard voice speaks.",
    };
  }
  return { use: true, note: "" };
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
  return input.supertonicReady ? "supertonic" : "sapi";
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
