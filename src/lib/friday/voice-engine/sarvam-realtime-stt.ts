/**
 * FRIDAY · Sarvam realtime speech to text, renderer side.
 *
 * The socket and the key live in the main process (`electron/sarvam-stream.cjs`). This file feeds it 16 kHz mono
 * PCM16 taken from the one shared capture (never a second microphone), and turns the provider's events into the
 * normalised transcript events of `voice-contracts.ts`.
 *
 * Rules kept here:
 *  - a partial is provisional text only, shown and replaced, never acted on;
 *  - a final closes the turn and is handed on exactly once (`TurnFinalizer`);
 *  - audio is resampled to 16 kHz before it is labelled 16 kHz;
 *  - the send queue is bounded, a chunk that cannot be sent is counted, never queued without limit;
 *  - a close the provider calls retryable is retried a few times with a growing wait; one it calls final
 *    (a refused key, quota or option) is reported and not retried;
 *  - the billed audio seconds the server reports at the end replace the client's estimate.
 * Not run against a live Sarvam account.
 */
import { desktopApi } from "../desktop";
import { StreamResampler, floatToPcm16, pcm16ToBase64 } from "./audio-format";
import { StageClock } from "./latency-monitor";
import { TurnFinalizer, type VoiceTranscriptEvent } from "./voice-contracts";

type Api = NonNullable<ReturnType<typeof desktopApi>>;
type StreamApi = Pick<
  Api,
  | "voiceStreamOpen"
  | "voiceStreamSend"
  | "voiceStreamClose"
  | "onVoiceStreamOpened"
  | "onVoiceStreamEvent"
  | "onVoiceStreamClosed"
>;

export type RealtimeSttOptions = {
  language?: string;
  model?: "saaras:v3-realtime" | "saaras:v4";
  streamType?: "fast" | "balanced" | "simulated";
  /** Words the recogniser should favour (saaras:v4 only, at most 50 of up to 64 characters). */
  keyterms?: string[];
  silenceMs?: number;
  hinglish?: boolean;
};

export type SttStatus = "idle" | "connecting" | "open" | "retrying" | "failed" | "closed";

export type RealtimeSttDeps = {
  api?: StreamApi | null;
  sessionId: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onTranscript: (event: VoiceTranscriptEvent) => void;
  /** Called once for each finished turn with its final text, after the transcript event. */
  onFinalTurn?: (event: Extract<VoiceTranscriptEvent, { type: "final" }>) => void;
  onSpeech?: (state: "start" | "end") => void;
  onStatus?: (status: SttStatus, detail?: string) => void;
  /** The provider's own count of audio it billed, in seconds. */
  onBilledSeconds?: (seconds: number) => void;
  clock?: StageClock;
  maxInFlight?: number;
  maxRetries?: number;
};

export const STT_RATE = 16_000;

/** One normalised event from the main process (`parseSttEvent` in `electron/sarvam-stream.cjs`). */
type SttWire = {
  type: string;
  text?: string;
  language?: string;
  audioSeconds?: number;
  fatal?: boolean;
  message?: string;
};

export function createRealtimeStt(deps: RealtimeSttDeps) {
  const now = deps.now ?? (() => performance.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const maxInFlight = deps.maxInFlight ?? 8;
  const maxRetries = deps.maxRetries ?? 3;
  const finalizer = new TurnFinalizer();
  const offs: Array<() => void> = [];

  let api: StreamApi | null = deps.api ?? (desktopApi() as StreamApi | null);
  let streamId = "";
  let generation = 0;
  let opts: RealtimeSttOptions = {};
  let status: SttStatus = "idle";
  let turn = 0;
  let revision = 0;
  let lastPartial = "";
  let inFlight = 0;
  let dropped = 0;
  let sent = 0;
  let attempts = 0;
  let retryTimer: unknown = null;
  let resampler: StreamResampler | null = null;
  let resamplerFrom = 0;
  let wantOpen = false;

  const setStatus = (next: SttStatus, detail?: string) => {
    status = next;
    deps.onStatus?.(next, detail);
  };
  const turnId = () => `t${turn}`;

  function onEvent(event: SttWire) {
    const at = now();
    switch (event.type) {
      case "speech-start":
        deps.onSpeech?.("start");
        return;
      case "speech-end":
        deps.onSpeech?.("end");
        return;
      case "partial": {
        const text = String(event.text ?? "").trim();
        if (!text || text === lastPartial) return;
        lastPartial = text;
        revision += 1;
        deps.clock?.mark("sttPartialFirstReceived", at);
        deps.onTranscript({
          type: "partial",
          sessionId: deps.sessionId,
          turnId: turnId(),
          revision,
          text,
          ...(event.language ? { language: String(event.language) } : {}),
          atMonoMs: at,
        });
        return;
      }
      case "final": {
        const text = String(event.text ?? "").trim();
        const id = turnId();
        const finalRevision = revision + 1;
        turn += 1;
        revision = 0;
        lastPartial = "";
        if (!text) return;
        deps.clock?.mark("sttFinalReceived", at);
        const final: Extract<VoiceTranscriptEvent, { type: "final" }> = {
          type: "final",
          sessionId: deps.sessionId,
          turnId: id,
          revision: finalRevision,
          text,
          ...(event.language ? { language: String(event.language) } : {}),
          atMonoMs: at,
        };
        deps.onTranscript(final);
        if (finalizer.finalizeOnce(deps.sessionId, id)) deps.onFinalTurn?.(final);
        return;
      }
      case "end": {
        const seconds = Number(event.audioSeconds);
        if (Number.isFinite(seconds)) deps.onBilledSeconds?.(seconds);
        return;
      }
      case "error":
        if (event.fatal === true)
          setStatus("failed", String(event.message ?? "the provider reported an error"));
        return;
      default:
    }
  }

  function subscribe(forId: string, forGeneration: number) {
    if (!api) return;
    const mine = () => forGeneration === generation && streamId === forId;
    offs.push(
      api.onVoiceStreamOpened?.((p) => {
        if (p.id === forId && mine()) {
          attempts = 0;
          setStatus("open");
        }
      }) ?? (() => undefined),
      api.onVoiceStreamEvent?.((p) => {
        if (p.id === forId && mine()) onEvent(p.event as SttWire);
      }) ?? (() => undefined),
      api.onVoiceStreamClosed?.((p) => {
        if (p.id !== forId || !mine()) return;
        streamId = "";
        if (!wantOpen) return setStatus("closed", p.reason);
        if (p.retry && attempts < maxRetries) {
          attempts += 1;
          setStatus("retrying", p.reason);
          retryTimer = setTimer(() => void connect(), 400 * 2 ** (attempts - 1));
        } else {
          setStatus("failed", p.reason);
        }
      }) ?? (() => undefined),
    );
  }

  function unsubscribe() {
    while (offs.length) offs.pop()?.();
  }

  async function connect(): Promise<{ ok: boolean; error?: string }> {
    api = deps.api ?? (desktopApi() as StreamApi | null);
    if (!api?.voiceStreamOpen) {
      setStatus("failed", "streaming speech runs in the installed desktop app");
      return { ok: false, error: "streaming speech runs in the installed desktop app" };
    }
    unsubscribe();
    generation += 1;
    streamId = `stt-${deps.sessionId}-${generation}`;
    subscribe(streamId, generation);
    setStatus("connecting");
    const out = await api.voiceStreamOpen(streamId, "stt", {
      language: opts.language ?? "auto",
      model: opts.model ?? "saaras:v4",
      streamType: opts.streamType ?? "fast",
      sampleRate: STT_RATE,
      ...(opts.keyterms ? { keyterms: opts.keyterms } : {}),
      ...(opts.silenceMs ? { silenceMs: opts.silenceMs } : {}),
      ...(opts.hinglish === false ? { hinglish: false } : {}),
    });
    if (!out.ok) {
      unsubscribe();
      streamId = "";
      setStatus("failed", out.error);
      return { ok: false, ...(out.error ? { error: out.error } : {}) };
    }
    return { ok: true };
  }

  return {
    /** Open the stream. The main process refuses (and says why) when cloud speech is off, private or keyless. */
    async start(options: RealtimeSttOptions = {}) {
      opts = options;
      wantOpen = true;
      attempts = 0;
      return connect();
    },

    /** One captured frame, any rate. It is resampled to 16 kHz, made PCM16 and sent. Never throws. */
    pushFrame(samples: ArrayLike<number>, fromRate: number): boolean {
      if (!api?.voiceStreamSend || !streamId || status !== "open") return false;
      if (inFlight >= maxInFlight) {
        dropped += 1;
        return false;
      }
      if (!resampler || resamplerFrom !== fromRate) {
        resampler = new StreamResampler(fromRate, STT_RATE);
        resamplerFrom = fromRate;
      }
      const pcm = floatToPcm16(resampler.push(samples));
      if (pcm.length === 0) return true;
      deps.clock?.mark("sttAudioFirstSent", now());
      inFlight += 1;
      const forId = streamId;
      void api
        .voiceStreamSend(forId, { type: "audio", audioBase64: pcm16ToBase64(pcm) })
        .then((r) => {
          if (r.ok) sent += 1;
          else dropped += 1;
        })
        .catch(() => {
          dropped += 1;
        })
        .finally(() => {
          inFlight -= 1;
        });
      return true;
    },

    /** Tell the provider the audio has ended so it settles the last turn and reports the billed seconds. */
    async finish() {
      if (api?.voiceStreamSend && streamId) await api.voiceStreamSend(streamId, { type: "end" });
    },

    async stop() {
      wantOpen = false;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      const id = streamId;
      streamId = "";
      generation += 1;
      unsubscribe();
      resampler = null;
      if (api?.voiceStreamClose && id) await api.voiceStreamClose(id);
      setStatus("closed");
    },

    stats: () => ({ status, sent, dropped, inFlight, attempts, turn }),
  };
}
