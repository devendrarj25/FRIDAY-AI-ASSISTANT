/**
 * FRIDAY · a streaming Sarvam voice that answers like the one-shot cloud call.
 *
 * `createStreamingSpeak` returns a function shaped like `voiceCloudSpeak` ({ ok, audioBase64, mime } for one
 * clause), so the existing cloud clip path (quota check, ledger, privacy gates, prefetch) is reused unchanged. The
 * difference is below it: one persistent WebSocket carries every clause (no new connection per clause) and the
 * audio frames are joined into the clip as they arrive. A clause that the stream cannot make falls back to the
 * one-shot REST call, so turning streaming on never makes a reply fail where the REST voice would have worked.
 *
 * Joining frames: with the codec mp3 (the only one the provider page lists as supported today) the frames are
 * joined byte for byte, which gives one playable mp3. For another codec the frames are not joined (their
 * containers would clash), so the clause falls back to REST. First audible sound is still the player's moment,
 * not this file's. Not run against a live Sarvam account.
 */
import type { desktopApi } from "../desktop";
import { StageClock } from "./latency-monitor";
import { createStreamingTts, type StreamingTtsOptions } from "./sarvam-streaming-tts";
import type { VoiceTtsEvent } from "./voice-contracts";

type Api = NonNullable<ReturnType<typeof desktopApi>>;
export type SpeakRequest = { text: string; language: string; speaker?: string; pace?: number };
export type SpeakResult = { ok: boolean; error?: string; audioBase64?: string; mime?: string };
type RestSpeak = (provider: string, request: SpeakRequest) => Promise<SpeakResult>;

/** A bulbul:v4-flash persona id looks like name_lang_style (aparna_hi_customer); older short names do not. */
export const isV4Persona = (speaker: string): boolean => /^[a-z]+_[a-z]{2,5}_[a-z]+$/.test(speaker);

const bytesOf = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

const toBase64 = (parts: Uint8Array[]): string => {
  let binary = "";
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 0x8000)
      binary += String.fromCharCode(...part.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export function createStreamingSpeak(deps: {
  api: Api | null | undefined;
  rest: RestSpeak;
  sessionId?: string;
  clock?: StageClock;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** A one-line note for the voice trace when the stream is skipped. */
  note?: (line: string) => void;
}) {
  const sessionId = deps.sessionId ?? "voice";
  const timeoutMs = deps.timeoutMs ?? 8000;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Map<
    string,
    { parts: Uint8Array[]; mime: string; done: (r: SpeakResult) => void }
  >();
  let counter = 0;
  let openKey = "";

  const tts = createStreamingTts({
    api: deps.api as never,
    sessionId,
    ...(deps.clock ? { clock: deps.clock } : {}),
    onEvent: (event: VoiceTtsEvent) => {
      const slot = "turnId" in event ? pending.get(event.turnId) : undefined;
      if (!slot) return;
      if (event.type === "audio-chunk") {
        slot.parts.push(bytesOf(event.audioBase64));
        slot.mime = event.mime;
      } else if (event.type === "utterance-complete") {
        slot.done(
          slot.parts.length
            ? { ok: true, audioBase64: toBase64(slot.parts), mime: slot.mime }
            : { ok: false, error: "the stream returned no audio" },
        );
      } else if (event.type === "error") {
        slot.done({ ok: false, error: event.message });
      }
    },
  });

  async function ensureOpen(options: StreamingTtsOptions): Promise<boolean> {
    const key = `${options.language}|${options.speaker}|${options.pace ?? 1}`;
    if (key === openKey) return true;
    if (openKey) await tts.stop();
    const out = await tts.start(options);
    openKey = out.ok ? key : "";
    if (!out.ok) deps.note?.(`streaming voice not opened — ${out.error ?? "refused"}`);
    return out.ok;
  }

  return {
    async speak(provider: string, request: SpeakRequest): Promise<SpeakResult> {
      const speaker = request.speaker ?? "";
      if (provider !== "sarvam" || !isV4Persona(speaker) || !deps.api?.voiceStreamOpen)
        return deps.rest(provider, request);
      const options: StreamingTtsOptions = {
        model: "bulbul:v4-flash",
        language: request.language,
        speaker,
        codec: "mp3",
        ...(typeof request.pace === "number" ? { pace: request.pace } : {}),
      };
      if (!(await ensureOpen(options))) return deps.rest(provider, request);
      const turnId = `u${(counter += 1)}`;
      const result = await new Promise<SpeakResult>((resolve) => {
        const timer = setTimer(
          () => finish({ ok: false, error: "the stream did not answer in time" }),
          timeoutMs,
        );
        const finish = (r: SpeakResult) => {
          clearTimer(timer);
          pending.delete(turnId);
          resolve(r);
        };
        pending.set(turnId, { parts: [], mime: "audio/mp3", done: finish });
        void tts.speak(turnId, request.text).then((generation) => {
          if (generation === 0 && pending.has(turnId))
            finish({ ok: false, error: "the text could not be sent" });
        });
      });
      if (result.ok) return result;
      deps.note?.(`streaming voice skipped — ${result.error}`);
      return deps.rest(provider, request);
    },

    /** Barge-in: drop what is waiting. The player's own stop is separate. */
    cancel() {
      tts.cancel();
      for (const slot of [...pending.values()]) slot.done({ ok: false, error: "cancelled" });
    },

    async stop() {
      openKey = "";
      for (const slot of [...pending.values()]) slot.done({ ok: false, error: "stopped" });
      await tts.stop();
    },
  };
}
