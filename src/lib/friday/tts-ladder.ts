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
 * The ladder of the standard voice: the owner's explicit choice first, then FRIDAY Voice (the local voice) whenever it
 * is installed and its breaker is closed, online, offline and under privacy mode alike; then, only when the cloud is
 * allowed (online, privacy mode off, an explicit pick or FRIDAY Voice unavailable), the online neural voice; the system
 * voice is the last rung. An explicit `neural` pick is the owner's, and still never reaches a private line.
 * The cloud rung itself is still decided by the one ranking in `voice-engine/tts-provider.ts`.
 */
export function chooseTtsEngine(input: {
  network: boolean;
  supertonicReady: boolean;
  privacy: boolean;
  prefer?: "auto" | TtsEngine;
  /** FRIDAY Voice failed lately: its breaker is open, so it counts as not ready until it closes. */
  supertonicBreakerOpen?: boolean;
}): TtsEngine {
  const { supertonicBreakerOpen, ...rest } = input;
  const ready = rest.supertonicReady && supertonicBreakerOpen !== true;
  const ranked = legacyEngineChoice({ ...rest, supertonicReady: ready }) as TtsEngine;
  if (rest.prefer === "sapi") return ranked;
  // The cloud rung wins only when the owner asked for it, or FRIDAY Voice cannot speak.
  if (ranked === "neural") return ready && rest.prefer !== "neural" ? "supertonic" : "neural";
  // A private line is on-device by definition: FRIDAY Voice, not the system voice, when it is ready.
  return ready ? "supertonic" : ranked;
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

/** Which script most of a line is written in: Hindi (Devanagari), English (Latin), or neither (digits, symbols). */
export function dominantScript(text: string): "devanagari" | "latin" | "none" {
  const devanagari = (String(text ?? "").match(/[\u0900-\u097F]/g) ?? []).length;
  const latin = (String(text ?? "").match(/[A-Za-z]/g) ?? []).length;
  if (!devanagari && !latin) return "none";
  return devanagari >= latin ? "devanagari" : "latin";
}

/**
 * The language tag the system voice is asked for. The Hindi tag follows the mapping above (en-in and hinglish keep
 * asking for hi-IN), but a line written in Latin letters under a Hindi tag is asked for en-IN, so an English line is
 * not read by a Hindi voice; a Devanagari line always gets hi-IN.
 */
export function fallbackUtterLang(spoken: string, tuningLang: string): string {
  const wanted = tuningLang || "hi-IN";
  const script = dominantScript(spoken);
  if (script === "devanagari") return "hi-IN";
  if (script === "latin" && wanted.toLowerCase().startsWith("hi")) return "en-IN";
  return wanted;
}

/**
 * What she says (and shows) when no engine could speak a line: a Hindi line names the missing Hindi voice, and the
 * local failure reason (when the voice worker gave one) goes on the end.
 */
export function noVoiceFailure(spoken: string, reason = ""): string {
  const why = String(reason ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const line =
    dominantScript(spoken) === "devanagari"
      ? "voice output failed — no Hindi voice is installed. Install a Hindi voice in Install Manager (or add one in Windows speech settings)"
      : "voice output failed — no speech engine could speak the reply (install a voice in Install Manager)";
  return why ? `${line}. Reason: ${why}` : line;
}

/** What the output list looked like when it was last read, kept so no caller has to ask the system again. */
export type OutputDeviceFacts = {
  enumerated: boolean;
  permitted: boolean;
  outputs: ReadonlyArray<{ id: string; isDefault?: boolean }>;
};

let outputFacts: OutputDeviceFacts | null = null;

/** Remember the latest read of the output devices (null forgets it). */
export function noteOutputDevices(facts: OutputDeviceFacts | null): void {
  outputFacts = facts;
}

/**
 * The sink id the output check is given. "default" when the list is unknown (never read, unreadable, or the
 * microphone is not allowed yet so nothing is named); "" when the list was read with permission and is empty (there
 * is no output); otherwise the saved speaker when it is still there, else the default one.
 */
export function cachedOutputSinkId(
  saved = "",
  facts: OutputDeviceFacts | null = outputFacts,
): string {
  if (!facts || !facts.enumerated || !facts.permitted) return "default";
  if (!facts.outputs.length) return "";
  const own = saved ? facts.outputs.find((row) => row.id === saved) : undefined;
  if (own) return own.id;
  return facts.outputs.find((row) => row.isDefault)?.id || facts.outputs[0]?.id || "default";
}
