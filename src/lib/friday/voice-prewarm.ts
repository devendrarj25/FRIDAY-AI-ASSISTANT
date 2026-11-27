/**
 * FRIDAY · the real engines behind the warm-up pass (`voice-engine/prewarm.ts`).
 *
 * Auto mode starts one pass when the microphone has opened. Each call below goes through a bridge FRIDAY already has
 * (`sttStatus` with `warm`, `transcribe` with `provisional`, `scoreTurn`, `speakNeuralPcm`, the kernel status), is
 * local only, and plays nothing. A browser preview with no desktop bridge has nothing to warm and says so.
 */
import { desktopApi } from "./desktop";
import { kernelApi } from "./kernel-api";
import { encodeWav } from "./pcm-capture";
import { preferences } from "./preferences";
import { readFridayVoiceStatus } from "./voice-diagnostics-rows";
import { getSystemPressureSnapshot } from "./system-pressure";
import { activeLocalStyle, activeVoiceSettings } from "./voice-library";
import { sttStatus, whisperLanguageArg } from "./voice-stt";
import {
  AckMemory,
  Prewarm,
  notePrewarmReport,
  type AckLine,
  type PrewarmIO,
  type PrewarmOutcome,
  type PrewarmPlan,
  type PrewarmReport,
  type PrewarmResult,
} from "./voice-engine/prewarm";
import { stopAckClip } from "./voice-engine/ack-player";
import { bytesToPcm16 } from "./voice-engine/pcm-clip-player";
import { streamLocale, streamWanted } from "./voice-engine/stream-session";
import { prepareForSpeech } from "./voice-engine/text-normalizer";

/** An acknowledgement line made in advance: raw samples, kept in memory only. */
export type AckClip = { text: string; lang: "en" | "hi"; pcm: Int16Array; rate: number };

/** The lines made while warming up. Emptied when the pass is cancelled and when Auto mode ends. */
export const ackMemory = new AckMemory<AckClip>();

type WarmBridge = {
  neuralVoiceStatus?: () => Promise<{
    available: boolean;
    reason?: string;
    fridayVoice?: unknown;
  }>;
  speakNeuralPcm?: (payload: {
    text: string;
    rate: number;
    lang?: string;
    style?: string;
    seq?: number;
    /** True asks only for the voice engine's one warm-up pass (no text is spoken). */
    warm?: boolean;
  }) => Promise<{
    ok: boolean;
    reason?: string;
    sampleRate?: number;
    pcm?: ArrayLike<number> & { length: number };
  }>;
  transcribe?: (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  /** Loads the streaming ear's model on the live worker; never opens a stream (voice:stt-stream-warm). */
  warmSttStream?: (payload: {
    streamEngine: string;
    locale: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
  scoreTurn?: (payload: {
    audioBytes: Uint8Array;
    mime: string;
  }) => Promise<{ ok: boolean; ready?: boolean; reason?: string }>;
};

const bridge = (): WarmBridge | null => (desktopApi() as unknown as WarmBridge | null) ?? null;

const NO_BRIDGE: PrewarmResult = {
  ok: true,
  skipped: true,
  reason: "no desktop bridge (browser preview)",
};

/** One second of silence at 16 kHz, as a WAV file. */
const silence = (): Uint8Array => encodeWav(new Float32Array(16_000));

let engineWarmed = false;
let engineWarmTries = 0;
/** A warm-up that failed is asked again by the next prewarm, this many times in all per app run. */
const ENGINE_WARM_TRIES_MAX = 3;

/**
 * The voice engine's own warm-up op: once per app run when it worked; a failure is asked again on the next prewarm,
 * at most three tries. A failure never stops the clip below, which warms the engine as well.
 */
async function warmVoiceEngineOnce(api: WarmBridge): Promise<void> {
  if (engineWarmed || engineWarmTries >= ENGINE_WARM_TRIES_MAX || !api.speakNeuralPcm) return;
  engineWarmTries += 1;
  const answered = await api
    .speakNeuralPcm({ text: "", rate: 1, style: activeLocalStyle(), warm: true })
    .catch(() => null);
  if (answered?.ok === true) engineWarmed = true;
}

/** Test hook: lets a test see the once-per-run warm-up again. */
export function resetVoiceEngineWarm(): void {
  engineWarmed = false;
  engineWarmTries = 0;
}

async function speak(
  text: string,
  lang: string,
): Promise<{
  ok: boolean;
  reason?: string;
  pcm?: Int16Array;
  rate?: number;
}> {
  const api = bridge();
  if (!api?.speakNeuralPcm) return { ok: false, reason: "no local voice bridge" };
  const status = await api.neuralVoiceStatus?.().catch(() => null);
  // The own voice engine being ready is enough; only when it does not report ready does the older flag decide.
  const own = readFridayVoiceStatus(status?.fridayVoice);
  if (status && !status.available && !(own && own.ready)) {
    return { ok: false, reason: status.reason || "the local voice is not installed" };
  }
  await warmVoiceEngineOnce(api);
  const result = await api.speakNeuralPcm({
    text,
    rate: activeVoiceSettings().rate,
    lang,
    // The voice the owner's replies use ("friday" unless another style was chosen), so the warm-up loads that one.
    style: activeLocalStyle(),
    seq: 0,
  });
  const rate = Number(result?.sampleRate) || 0;
  if (!result?.ok || !result.pcm || !(rate > 0)) {
    return { ok: false, reason: String(result?.reason || "no samples") };
  }
  return { ok: true, pcm: bytesToPcm16(result.pcm), rate };
}

/** `alive` turns false when the pass is cancelled: a line that finishes after that is dropped, never kept. */
export function createPrewarmIO(alive: () => boolean = () => true): PrewarmIO {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    after: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    },
    warmListening: async () => {
      const api = bridge();
      if (!api) return NO_BRIDGE;
      // The same worker load the recognition start asks for; the status call is idempotent.
      const state = await sttStatus(false, true, true);
      if (!state.ready)
        return { ok: false, reason: state.reason || "the speech engine is not ready" };
      const voice = preferences.getSnapshot().voice;
      // The streaming ear's model loads here, on its own limit, so the first stream-open of a turn only reuses it. Only
      // when the owner asked for that ear; a miss or refusal is a fallback to the ordinary decode, never a failed step.
      if (streamWanted(voice.streamEngine) && api.warmSttStream) {
        await api
          .warmSttStream({
            streamEngine: voice.streamEngine,
            locale: streamLocale(voice.recognitionLang),
          })
          .catch(() => null);
      }
      if (!api.transcribe) return { ok: true };
      const language = whisperLanguageArg(voice.recognitionLang) || undefined;
      const out = await api.transcribe({
        audioBytes: silence(),
        mime: "audio/wav",
        ...(language ? { language } : {}),
        // The same listening choice as a real turn, so the warm-up wakes the engine this turn will use (the Hindi ear
        // loads only when Hindi or auto is chosen).
        ...(voice.recognitionLang ? { speechPref: voice.recognitionLang } : {}),
        localOnly: true,
        // A provisional pass is never counted as heard or dropped and never written to the hearing log.
        provisional: true,
        utteranceId: "prewarm",
        ...(voice.sttSize && voice.sttSize !== "auto"
          ? { model: voice.sttSize, sttSize: voice.sttSize }
          : {}),
      });
      return out?.ok ? { ok: true } : { ok: false, reason: String(out?.error || "decode failed") };
    },
    warmBrain: async () => {
      if (!bridge()) return NO_BRIDGE;
      // Opens the connection to the kernel. No model is called here, paid or free: the light local chat model is
      // loaded by the speech status call above, and the router keeps both firewalls for every real turn.
      await kernelApi.status();
      return { ok: true };
    },
    warmSpeech: async (text) => {
      if (!bridge()) return NO_BRIDGE;
      // The samples are dropped here: a warm-up clip is never kept, cached or played.
      const made = await speak(text, "en-IN");
      return made.ok ? { ok: true } : { ok: false, reason: made.reason ?? "no samples" };
    },
    warmTurn: async () => {
      const api = bridge();
      if (!api) return NO_BRIDGE;
      if (!api.scoreTurn) return { ok: true, skipped: true, reason: "no Smart Turn bridge" };
      const out = await api.scoreTurn({ audioBytes: silence(), mime: "audio/wav" });
      if (out?.ready) return { ok: true };
      // The optional model is not installed: nothing to warm, and not a fault.
      if (/absent|no-python|no-audio/.test(out?.reason || "")) {
        return { ok: true, skipped: true, reason: out.reason || "Smart Turn is not installed" };
      }
      return { ok: false, reason: out?.reason || "Smart Turn did not answer" };
    },
    makeAck: async (line: AckLine) => {
      if (!bridge()) return NO_BRIDGE;
      // A Hindi line may be Roman ("Ek minute."): Speech Prep puts it in Devanagari for the Hindi voice, as for a reply.
      const spoken =
        line.lang === "hi"
          ? prepareForSpeech(line.text, {}, { enabled: true, hindiVoice: true }) || line.text
          : line.text;
      const made = await speak(spoken, line.lang === "hi" ? "hi-IN" : "en-IN");
      if (!made.ok || !made.pcm || !made.rate)
        return { ok: false, reason: made.reason ?? "no samples" };
      if (alive())
        ackMemory.put(line.id, {
          text: line.text,
          lang: line.lang,
          pcm: made.pcm,
          rate: made.rate,
        });
      return { ok: true };
    },
  };
}

let session: Prewarm | null = null;

/** Hardware profile Lite or battery saver: the heavy steps do not run. */
export function prewarmLight(): boolean {
  const pressure = getSystemPressureSnapshot();
  return Boolean(pressure && (pressure.lite || pressure.onBattery));
}

/**
 * Start the pass for Auto mode. Returns at once with the pass; it never blocks entering Auto and never rejects.
 * `onStep` receives each step as it ends (the timing stamp and the Voice Doctor note).
 */
export function startPrewarm(
  state: Pick<PrewarmPlan, "mode" | "micOpen" | "held"> & { localVoice: boolean },
  onStep?: (outcome: PrewarmOutcome) => void,
  io?: PrewarmIO,
): Promise<PrewarmReport> {
  const voice = preferences.getSnapshot().voice;
  const plan: PrewarmPlan = {
    enabled: voice.prewarm !== false,
    mode: state.mode,
    micOpen: state.micOpen,
    held: state.held,
    engines: {
      stt: true,
      brain: true,
      tts: state.localVoice && voice.speakReplies !== false,
      turn: true,
      // The acknowledgement lines are made only for the owner who turned the instant acknowledgement on.
      acks: voice.instantAck === true && state.localVoice && voice.speakReplies !== false,
    },
    light: prewarmLight(),
  };
  session?.cancel();
  let alive = true;
  const run = new Prewarm(io ?? createPrewarmIO(() => alive), {
    ...(onStep ? { onStep } : {}),
    onCancel: () => {
      alive = false;
      ackMemory.clear();
    },
  });
  session = run;
  return run.run(plan).then((report) => {
    if (session === run) notePrewarmReport(report);
    return report;
  });
}

/** Mute, pause, Stop everything or leaving Auto: stop the pass and drop what it made. */
export function cancelPrewarm(): void {
  session?.cancel();
  session = null;
  stopAckClip();
  ackMemory.clear();
}

/** The ids of the lines that are ready to play. A line with no clip here is never said as an acknowledgement. */
export function readyAckClipIds(): string[] {
  return ackMemory.ids();
}

/** One line made in advance, or nothing. The samples never leave this PC. */
export function ackClipFor(id: string): AckClip | undefined {
  return ackMemory.get(id);
}
