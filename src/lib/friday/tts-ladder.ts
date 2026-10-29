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
