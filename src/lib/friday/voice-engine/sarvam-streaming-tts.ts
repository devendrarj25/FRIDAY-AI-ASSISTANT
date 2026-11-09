/**
 * FRIDAY · Sarvam streaming text to speech, renderer side (Bulbul over one persistent WebSocket).
 *
 * The socket and the key live in the main process (`electron/sarvam-stream.cjs`). One connection carries many
 * utterances: config once, then for each speech unit `text` then `flush`, and the provider sends `audio` frames
 * and a `final` event. Replies arrive in the order the units were sent, so the first unit still waiting is the
 * one a frame belongs to.
 *
 * Rules kept here:
 *  - every unit has a generation number; cancelling moves the guard on, and a late frame of a cancelled
 *    generation is dropped and never reaches the player;
 *  - frames carry an increasing sequence per generation, in arrival order;
 *  - the stage clock stamps the request and the first audio received separately from anything audible;
 *  - an error is classified (auth, quota, config, network, provider) so the ladder can fall back at the right
 *    place: the caller continues with the first unit that was not fully spoken instead of repeating heard audio.
 * The audio container follows `output_audio_codec` and the frame's own `content_type`; a frame is passed on as
 * the provider sent it and decoded by the existing clip player. Not run against a live Sarvam account.
 */
import { desktopApi } from "../desktop";
import { StageClock } from "./latency-monitor";
import { GenerationGuard, type VoiceTtsEvent } from "./voice-contracts";

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

export type StreamingTtsOptions = {
  model?: "bulbul:v2" | "bulbul:v3" | "bulbul:v4-flash";
  language: string;
  /** For bulbul:v4-flash a persona id such as `aparna_hi_customer`; pinned, never left to a provider default. */
  speaker: string;
  sampleRate?: 8000 | 16000 | 22050 | 24000;
  codec?: "mp3" | "wav" | "opus" | "flac" | "aac" | "linear16";
  pace?: number;
};

export type StreamingTtsDeps = {
  api?: StreamApi | null;
  sessionId: string;
  guard?: GenerationGuard;
  clock?: StageClock;
  now?: () => number;
  onEvent: (event: VoiceTtsEvent) => void;
};

export const MAX_UNIT_CHARS = 2500;

type Waiting = { generationId: number; turnId: string; sequence: number; cancelled: boolean };

/** One normalised event from the main process (`parseTtsEvent` in `electron/sarvam-stream.cjs`). */
type TtsWire = {
  type: string;
  mime?: string;
  audioBase64?: string;
  code?: number;
  message?: string;
};

const categoryOf = (code: number): Extract<VoiceTtsEvent, { type: "error" }>["category"] =>
  code === 401 || code === 403
    ? "auth"
    : code === 429
      ? "quota"
      : code === 400 || code === 422
        ? "config"
        : "provider";

export function createStreamingTts(deps: StreamingTtsDeps) {
  const guard = deps.guard ?? new GenerationGuard();
  const now = deps.now ?? (() => performance.now());
  const offs: Array<() => void> = [];
  const waiting: Waiting[] = [];
  let api: StreamApi | null = deps.api ?? (desktopApi() as StreamApi | null);
  let streamId = "";
  let ready = false;
  let epoch = 0;
  let opened: Promise<{ ok: boolean; error?: string }> | null = null;

  const fail = (
    w: Waiting,
    category: Extract<VoiceTtsEvent, { type: "error" }>["category"],
    retryable: boolean,
    message: string,
  ) =>
    deps.onEvent({
      type: "error",
      sessionId: deps.sessionId,
      turnId: w.turnId,
      generationId: w.generationId,
      category,
      retryable,
      message,
    });

  function unsubscribe() {
    while (offs.length) offs.pop()?.();
  }

  function handle(event: TtsWire) {
    const head = waiting[0];
    if (event.type === "audio") {
      if (!head || head.cancelled || !guard.isCurrent(head.generationId)) return; // a late frame is dropped
      const at = now();
      deps.clock?.mark("ttsFirstAudioReceived", at);
      head.sequence += 1;
      deps.onEvent({
        type: "audio-chunk",
        sessionId: deps.sessionId,
        turnId: head.turnId,
        generationId: head.generationId,
        sequence: head.sequence,
        mime: String(event.mime ?? "audio/mp3"),
        audioBase64: String(event.audioBase64 ?? ""),
      });
    } else if (event.type === "complete") {
      const done = waiting.shift();
      if (done && !done.cancelled && guard.isCurrent(done.generationId))
        deps.onEvent({
          type: "utterance-complete",
          sessionId: deps.sessionId,
          turnId: done.turnId,
          generationId: done.generationId,
        });
    } else if (event.type === "error") {
      const code = Number(event.code) || 0;
      const w = waiting.shift();
      if (w && !w.cancelled)
        fail(
          w,
          categoryOf(code),
          categoryOf(code) === "provider",
          String(event.message ?? "the provider reported an error"),
        );
    }
  }

  async function open(options: StreamingTtsOptions) {
    api = deps.api ?? (desktopApi() as StreamApi | null);
    if (!api?.voiceStreamOpen)
      return { ok: false, error: "streaming speech runs in the installed desktop app" };
    unsubscribe();
    epoch += 1;
    const mine = epoch;
    streamId = `tts-${deps.sessionId}-${mine}`;
    const id = streamId;
    ready = false;
    offs.push(
      api.onVoiceStreamOpened?.((p) => {
        if (p.id === id && mine === epoch) ready = true;
      }) ?? (() => undefined),
      api.onVoiceStreamEvent?.((p) => {
        if (p.id === id && mine === epoch) handle(p.event as TtsWire);
      }) ?? (() => undefined),
      api.onVoiceStreamClosed?.((p) => {
        if (p.id !== id || mine !== epoch) return;
        ready = false;
        streamId = "";
        while (waiting.length) {
          const w = waiting.shift()!;
          if (!w.cancelled) fail(w, "network", p.retry, p.reason);
        }
      }) ?? (() => undefined),
    );
    const out = await api.voiceStreamOpen(id, "tts", { ...options });
    if (!out.ok) {
      unsubscribe();
      streamId = "";
      return { ok: false, ...(out.error ? { error: out.error } : {}) };
    }
    ready = true; // the main process sends the config as the socket opens; frames queue behind it
    return { ok: true };
  }

  return {
    async start(options: StreamingTtsOptions) {
      opened = open(options);
      return opened;
    },

    /** Speak one unit (a sentence or clause). Returns the generation it belongs to, or 0 when it was refused. */
    async speak(turnId: string, text: string): Promise<number> {
      const unit = text.trim();
      const generationId = guard.id || guard.next();
      if (!unit || !api?.voiceStreamSend || !streamId) return 0;
      if (unit.length > MAX_UNIT_CHARS) {
        fail(
          { generationId, turnId, sequence: 0, cancelled: false },
          "config",
          false,
          `speak at most ${MAX_UNIT_CHARS} characters at a time`,
        );
        return 0;
      }
      if (opened) await opened;
      if (!ready || !streamId) return 0;
      const w: Waiting = { generationId, turnId, sequence: 0, cancelled: false };
      waiting.push(w);
      deps.clock?.mark("ttsRequestStarted", now());
      deps.onEvent({ type: "request-started", sessionId: deps.sessionId, turnId, generationId });
      const sentText = await api.voiceStreamSend(streamId, { type: "text", text: unit });
      const sentFlush = sentText.ok
        ? await api.voiceStreamSend(streamId, { type: "flush" })
        : sentText;
      if (!sentFlush.ok) {
        const at = waiting.indexOf(w);
        if (at >= 0) waiting.splice(at, 1);
        fail(w, "network", true, sentFlush.error ?? "the text could not be sent");
        return 0;
      }
      return generationId;
    },

    /** Change the language or pace on the open socket (the provider applies it from the next unit on). */
    async configure(change: { language: string; pace?: number }): Promise<boolean> {
      if (opened) await opened;
      if (!ready || !streamId || !api?.voiceStreamSend) return false;
      const out = await api.voiceStreamSend(streamId, {
        type: "config",
        language: change.language,
        ...(typeof change.pace === "number" ? { pace: change.pace } : {}),
      });
      return out.ok;
    },

    /** Stop what is being said now: later frames of this generation are dropped. Audible stop is the player's job. */
    cancel(turnId = ""): number {
      const old = guard.cancel();
      for (const w of waiting) {
        if (!w.cancelled) {
          w.cancelled = true;
          deps.onEvent({
            type: "cancelled",
            sessionId: deps.sessionId,
            turnId: turnId || w.turnId,
            generationId: w.generationId,
          });
        }
      }
      return old;
    },

    /** The generation number for the next speech of a new turn. */
    nextGeneration: () => guard.next(),

    async stop() {
      epoch += 1;
      unsubscribe();
      const id = streamId;
      streamId = "";
      ready = false;
      waiting.length = 0;
      if (api?.voiceStreamClose && id) await api.voiceStreamClose(id);
    },

    pending: () => waiting.filter((w) => !w.cancelled).length,
  };
}
