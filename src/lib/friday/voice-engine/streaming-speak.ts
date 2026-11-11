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
import { ProgressiveAudio, progressiveSupported, type MediaImpl } from "./progressive-audio";
import { createStreamingTts, type StreamingTtsOptions } from "./sarvam-streaming-tts";
import type { VoiceTtsEvent } from "./voice-contracts";

type Api = NonNullable<ReturnType<typeof desktopApi>>;
export type SpeakRequest = { text: string; language: string; speaker?: string; pace?: number };
export type SpeakResult = {
  ok: boolean;
  error?: string;
  audioBase64?: string;
  mime?: string;
  /** Set when the clip is playing as it arrives: a paused audio element the player starts. */
  audio?: unknown;
  /**
   * Gives back what the clip holds (its media stream, buffers and object URL). The player calls it when the clip is
   * cancelled or dropped before it ended; calling it twice, or after the clip ended, does nothing.
   */
  release?: () => void;
};
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
  /**
   * The browser's media pieces. When given and `audio/mpeg` is supported, a clause is handed back as soon as its
   * first piece arrives and plays while the rest streams in; without it the pieces are joined into one clip.
   */
  media?: MediaImpl | null;
  /** A one-line note for the voice trace when the stream is skipped. */
  note?: (line: string) => void;
}) {
  const sessionId = deps.sessionId ?? "voice";
  const timeoutMs = deps.timeoutMs ?? 8000;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  type Slot = {
    parts: Uint8Array[];
    mime: string;
    /** Settle the caller (once) and stop collecting. Used for failure, cancel and the end of a joined clip. */
    done: (r: SpeakResult) => void;
    /** Hand the caller a playing clip before the clause is complete (once). */
    early: (r: SpeakResult) => void;
    stream: ProgressiveAudio | null;
  };
  const pending = new Map<string, Slot>();
  const useStream = progressiveSupported(deps.media);
  let counter = 0;

  const tts = createStreamingTts({
    api: deps.api as never,
    sessionId,
    ...(deps.clock ? { clock: deps.clock } : {}),
    onEvent: (event: VoiceTtsEvent) => {
      const slot = "turnId" in event ? pending.get(event.turnId) : undefined;
      if (!slot) return;
      if (event.type === "audio-chunk") {
        const bytes = bytesOf(event.audioBase64);
        slot.parts.push(bytes);
        slot.mime = event.mime;
        if (slot.stream) slot.stream.append(bytes);
        else if (useStream && deps.media && /mp(3|eg)/i.test(event.mime)) {
          // The first piece: start the element, give the caller the clip now, and keep feeding it.
          const stream = new ProgressiveAudio(deps.media);
          slot.stream = stream;
          for (const part of slot.parts) stream.append(part);
          slot.early({
            ok: true,
            audio: stream.audio,
            mime: slot.mime,
            audioBase64: "",
            release: () => stream.dispose(),
          });
        }
      } else if (event.type === "utterance-complete") {
        if (slot.stream) {
          slot.stream.end();
          slot.done({ ok: true });
        } else
          slot.done(
            slot.parts.length
              ? { ok: true, audioBase64: toBase64(slot.parts), mime: slot.mime }
              : { ok: false, error: "the stream returned no audio" },
          );
      } else if (event.type === "error") {
        slot.stream?.end(); // what arrived plays out; the rest of this clause is lost
        slot.done({ ok: false, error: event.message });
      }
    },
  });

  /** One socket per voice. A change of language or pace goes down the open socket; only another voice reopens it. */
  let current: { speaker: string; language: string; pace: number } | null = null;
  /** Opening, configuring and sending are done one clause at a time, so two clauses asked at once share one socket. */
  let sendChain: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const run = sendChain.then(work, work);
    sendChain = run.catch(() => undefined);
    return run;
  };

  async function ensureOpen(options: StreamingTtsOptions): Promise<boolean> {
    const pace = options.pace ?? 1;
    // After an interruption the provider is still making the cancelled sentences and replies come back in order,
    // so the next sentence would wait behind them: drop that connection (the provider stops) and open a new one.
    if (current && tts.staleOutstanding() > 0) {
      await tts.stop();
      current = null;
    }
    if (current && current.speaker !== options.speaker) {
      await tts.stop();
      current = null;
    }
    if (!current) {
      const out = await tts.start(options);
      if (!out.ok) deps.note?.(`streaming voice not opened — ${out.error ?? "refused"}`);
      else current = { speaker: options.speaker, language: options.language, pace };
      return out.ok;
    }
    if (current.language !== options.language || current.pace !== pace) {
      const done = await tts.configure({ language: options.language, pace });
      if (done) current = { speaker: options.speaker, language: options.language, pace };
      return done;
    }
    return true;
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
      const turnId = `u${(counter += 1)}`;
      const result = await new Promise<SpeakResult>((resolve) => {
        // The answer clock starts when the text has been sent on an open socket, not when the clause was asked:
        // the wait for the connection has its own limit (the open timeout), and counting it here made a slow first
        // connection look like a silent stream and fall back to REST for the very first sentence.
        let timer: unknown = null;
        let settled = false;
        const settle = (r: SpeakResult) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimer(timer);
          resolve(r);
        };
        const finish = (r: SpeakResult) => {
          pending.delete(turnId);
          settle(r);
        };
        pending.set(turnId, {
          parts: [],
          mime: "audio/mp3",
          done: finish,
          early: settle,
          stream: null,
        });
        // The slot exists before anything is sent, so no reply frame can arrive for a clause nobody waits for.
        void inOrder(async () => {
          if (!(await ensureOpen(options))) return false;
          const sent = (await tts.speak(turnId, request.text)) !== 0;
          if (sent && !settled)
            timer = setTimer(
              () => finish({ ok: false, error: "the stream did not answer in time" }),
              timeoutMs,
            );
          return sent;
        })
          .catch(() => false)
          .then((sent) => {
            if (!sent && pending.has(turnId))
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
      for (const slot of [...pending.values()]) {
        slot.stream?.dispose(); // what was still arriving is dropped, not left to buffer behind the next turn
        slot.done({ ok: false, error: "cancelled" });
      }
    },

    async stop() {
      current = null;
      for (const slot of [...pending.values()]) {
        slot.stream?.dispose();
        slot.done({ ok: false, error: "stopped" });
      }
      await tts.stop();
    },
  };
}
