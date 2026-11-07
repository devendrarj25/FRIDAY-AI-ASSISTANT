/**
 * FRIDAY · cloud speech from the renderer: ask the router first, count the use, then let the main process call.
 *
 * Order, always: the voice router must pick this cloud provider (switched on, allowed, key saved, privacy off,
 * inside the day, month and audio quota) -> the request is counted -> the main process re-checks its own gates
 * and makes the call. A refusal returns the reason and counts nothing. The key is never here.
 */
import { desktopApi } from "../desktop";
import { routeVoice, type UsageLedger } from "./voice-provider-router";
import { toRouterSettings, type VoiceCloudPrefs } from "./voice-cloud-settings";

export type CloudSpeakResult =
  { ok: true; audioBase64: string; mime: string; provider: string } | { ok: false; error: string };

export type CloudSpeakDeps = {
  speak?: NonNullable<ReturnType<typeof desktopApi>>["voiceCloudSpeak"];
  ledger: UsageLedger;
  persistLedger?: () => void;
};

/** Roughly 15 characters per second of speech, used only to count audio minutes before the audio exists. */
export const estimateSpeechMinutes = (text: string): number =>
  Math.max(0.02, text.length / 15 / 60);

export async function speakWithCloud(
  provider: "sarvam" | "azure-speech",
  input: {
    text: string;
    language: string;
    prefs: VoiceCloudPrefs;
    keys: Record<string, boolean>;
    privacyMode: boolean;
    online: boolean;
  },
  deps: CloudSpeakDeps,
): Promise<CloudSpeakResult> {
  const minutes = estimateSpeechMinutes(input.text);
  const decision = routeVoice(
    {
      need: "tts",
      needHindi: input.language.startsWith("hi"),
      sensitive: false,
      privacyMode: input.privacyMode,
      billingAllowsPaid: false,
      online: input.online,
      audioMinutes: minutes,
    },
    // Only the provider asked for may be chosen here.
    {
      ...toRouterSettings(input.prefs, input.keys),
      allowedProviders: input.prefs.allowedProviders.filter((id) => id === provider),
    },
    deps.ledger,
  );
  if (decision.active !== "cloud" || decision.provider?.id !== provider) {
    return {
      ok: false,
      error: decision.refused.find((r) => r.id === provider)?.why ?? decision.reason,
    };
  }
  const speak = deps.speak ?? desktopApi()?.voiceCloudSpeak;
  if (!speak) return { ok: false, error: "cloud speech runs in the installed desktop app" };
  deps.ledger.record(provider, minutes);
  deps.persistLedger?.();
  const out = await speak(provider, {
    text: input.text,
    language: input.language,
    ...(provider === "sarvam" && input.prefs.sarvamSpeaker
      ? { speaker: input.prefs.sarvamSpeaker }
      : {}),
  });
  if (!out.ok || !out.audioBase64)
    return { ok: false, error: out.error ?? "the provider returned no audio" };
  return { ok: true, audioBase64: out.audioBase64, mime: out.mime ?? "audio/wav", provider };
}
