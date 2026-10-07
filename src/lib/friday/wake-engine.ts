/**
 * FRIDAY · which wake engine is really running.
 *
 * Two detectors exist, and the UI must never have to guess which one answered:
 *
 *   friday-linear / openwakeword — native detector. It scores a captured clip
 *                  BEFORE whisper runs, on a persistent worker that keeps the
 *                  matching model loaded. Ready only when that configured
 *                  model's file is actually present (jarvis never uses friday.onnx).
 *   transcript   — the documented fallback (src/lib/friday/wake-word.ts):
 *                  regex matching over the finished faster-whisper transcript.
 *                  Used whenever the native detector is not installed, or is
 *                  installed without a model for the configured wake word.
 */
import { desktopApi as desktop } from "./desktop";

export type WakeEngineId = "openwakeword" | "friday-linear" | "transcript";

export type WakeEngineStatus = {
  engine: WakeEngineId;
  installed: boolean;
  ready: boolean;
  model: string | null;
  modelDir: string | null;
  wakeWord: string;
  reason: string | null;
};

export const TRANSCRIPT_ONLY: WakeEngineStatus = {
  engine: "transcript",
  installed: false,
  ready: false,
  model: null,
  modelDir: null,
  wakeWord: "friday",
  reason: "native wake model is not ready — matching the transcript instead.",
};

let cached: { at: number; word: string; value: WakeEngineStatus } | null = null;

function nativeEngine(raw: { engine?: string; ready?: boolean } | null): WakeEngineId {
  if (raw?.engine === "transcript") return "transcript";
  if (raw?.engine === "friday-linear") return "friday-linear";
  if (raw?.engine === "openwakeword") return "openwakeword";
  if (raw?.ready) return "openwakeword";
  return "transcript";
}

/** The engine that will really handle the next utterance. */
export async function wakeEngineStatus(
  wakeWord = "friday",
  force = false,
): Promise<WakeEngineStatus> {
  const key = wakeWord.toLowerCase();
  if (cached && !force && cached.word === key && Date.now() - cached.at < 60_000)
    return cached.value;
  const api = desktop();
  if (!api?.wakeEngineStatus) {
    const value = { ...TRANSCRIPT_ONLY, wakeWord: key };
    cached = { at: Date.now(), word: key, value };
    return value;
  }
  try {
    const raw = await api.wakeEngineStatus({ wakeWord: key, force });
    const value: WakeEngineStatus = {
      engine: nativeEngine(raw),
      installed: Boolean(raw?.installed),
      ready: Boolean(raw?.ready),
      model: raw?.model ?? null,
      modelDir: raw?.modelDir ?? null,
      wakeWord: raw?.wakeWord || key,
      reason: raw?.reason ?? null,
    };
    cached = { at: Date.now(), word: key, value };
    return value;
  } catch (error) {
    const value = {
      ...TRANSCRIPT_ONLY,
      wakeWord: key,
      reason: String((error as Error)?.message || error),
    };
    cached = { at: Date.now(), word: key, value };
    return value;
  }
}

export type WakeProbe = {
  engine: WakeEngineId;
  detected: boolean;
  score: number | null;
  detail: string;
};

/**
 * Score one captured utterance with openWakeWord. Returns null when the engine
 * is unavailable, which is the caller's signal to use the transcript fallback.
 */
export async function detectWake(payload: {
  audioBase64: string;
  mime?: string;
  wakeWord?: string;
  threshold?: number;
}): Promise<WakeProbe | null> {
  const api = desktop();
  if (!api?.detectWakeWord) return null;
  const status = await wakeEngineStatus(payload.wakeWord || "friday");
  if (!status.ready) return null;
  try {
    const result = await api.detectWakeWord(payload);
    if (!result?.ok) return null;
    return {
      engine: nativeEngine(result),
      detected: Boolean(result.detected),
      score: typeof result.score === "number" ? result.score : null,
      detail: `${result.engine || "native"} ${result.detected ? "matched" : "no match"} · score ${result.score ?? "?"}`,
    };
  } catch {
    return null;
  }
}

/** Install openWakeWord through the shared Python toolchain. */
export async function installWakeEngine(): Promise<{ ok: boolean; error?: string }> {
  const api = desktop();
  if (!api?.installWakeEngine) return { ok: false, error: "desktop app required" };
  cached = null;
  return api.installWakeEngine();
}
