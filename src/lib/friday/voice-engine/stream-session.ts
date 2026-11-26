/**
 * FRIDAY · one utterance through the streaming ear (renderer side).
 *
 * The desktop dictation owns the microphone ring and its 80 ms segment tick; this session only turns the samples it
 * is handed into 80 to 320 ms int16 chunks for `feedSttStream`, one request in flight, no timer of its own. What the
 * ear answers is used three ways:
 *   · a partial becomes a `LiveWordsUpdate` (committed words settled, the rest dim) for the caption and the barge-in
 *     gate, exactly like the live-words follower; it is display data and never reaches the Brain;
 *   · an `EndOfTurn` endpoint ends the utterance early (the dictation closes the segment on its next tick);
 *   · the final text from `closeSttStream` stands in for the ordinary decode, through the same early-read slot the
 *     provisional decoder uses, so wake, voice match and every gate after it run unchanged.
 * Every refusal or throw (`{ ok: false, fallback: true }`, a missing bridge, a stalled worker, an empty final) ends the
 * stream and answers null, and the caller transcribes the same audio the ordinary way. Nothing here opens a
 * microphone; Auto mode's dictation is the only caller.
 */
import type { LiveWordsUpdate } from "./live-words";
import {
  checkScriptPolicy,
  summariseScriptChecks,
  type ScriptCheck,
  type ScriptSummary,
} from "./script-policy";
import { applyHinglishItn } from "./hinglish-itn";
import { tidyTranscript, type TidyChange } from "./transcript-tidy";

export type StreamEngineChoice = "off" | "auto" | "nemotron" | "stream-ear-nemotron";
export type StreamLocale = "hi" | "en" | "hi-en" | "";

/** The three bridge calls (see desktop.ts). A missing one means there is no streaming ear here. */
export type StreamBridge = {
  openSttStream?: (payload: {
    streamId?: string;
    streamEngine: StreamEngineChoice;
    locale: StreamLocale;
    hotwords?: string[];
    endpoint?: boolean;
    localOnly?: boolean;
  }) => Promise<{
    ok: boolean;
    streamId?: string;
    engine?: string;
    chunkMs?: number;
    fallback?: boolean;
    reason?: string;
  }>;
  feedSttStream?: (payload: { streamId: string; pcm: string }) => Promise<{
    ok: boolean;
    events?: { type: string; [key: string]: unknown }[];
    text?: string;
    committed?: string;
    audioMs?: number;
    endpoint?: { event?: string | null; [key: string]: unknown };
    fallback?: boolean;
    reason?: string;
  }>;
  closeSttStream?: (payload: { streamId: string; finalize?: boolean }) => Promise<{
    ok: boolean;
    text?: string;
    words?: { text: string; startMs?: number; endMs?: number }[];
    audioMs?: number;
    rtf?: number;
    fallback?: boolean;
    reason?: string;
  }>;
};

export type StreamPlan = {
  streamEngine: StreamEngineChoice;
  locale: StreamLocale;
  hotwords?: readonly string[];
};

export type StreamEndpoint = {
  event: string;
  reason: string;
  silenceMs: number | null;
  audioMs: number | null;
};

export type StreamFinal = {
  text: string;
  words: { text: string; startMs?: number; endMs?: number }[];
  audioMs: number;
  rtf: number;
  engine: string;
  locale: StreamLocale;
};

export type StreamSessionState = "idle" | "opening" | "open" | "closing" | "closed" | "fallback";

export const STREAM_RATE = 16_000;
export const STREAM_MIN_CHUNK_MS = 80;
export const STREAM_MAX_CHUNK_MS = 320;
const DEFAULT_CHUNK_MS = 160;
/** Audio waiting for a stalled ear beyond this is not worth streaming: the ordinary decode takes over. */
export const STREAM_MAX_BACKLOG_MS = 8_000;
const ID_CHARS = 64;

/** The recognition language the owner picked, as the ear's forced locale ("" lets the ear decide per segment). */
export function streamLocale(recognitionLang: string | null | undefined): StreamLocale {
  const v = String(recognitionLang ?? "")
    .trim()
    .toLowerCase()
    .replace("_", "-");
  if (!v) return "";
  if (v === "hinglish" || v === "mixed" || v === "hi-en" || v.startsWith("hi-latn")) return "hi-en";
  if (v === "hi" || v.startsWith("hi-")) return "hi";
  if (v === "en" || v.startsWith("en-")) return "en";
  return "";
}

/** True only when the owner asked for the streaming ear (`voice.streamEngine`); off, absent or unknown is off. */
export function streamWanted(
  streamEngine: unknown,
): streamEngine is Exclude<StreamEngineChoice, "off"> {
  return (
    streamEngine === "auto" || streamEngine === "nemotron" || streamEngine === "stream-ear-nemotron"
  );
}

/** Float samples (-1..1) as base64 of int16 little-endian, the ear's wire format. */
export function pcm16Base64(samples: ArrayLike<number>): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  let binary = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One kernel partial event as the update the live caption and the barge-in gate already read. */
export function streamPartialUpdate(
  event: { [key: string]: unknown },
  passes: number,
  language: string,
): LiveWordsUpdate {
  const shown = text(event["text"]).trim();
  const settled = text(event["committed"]).trim();
  const stable = text(event["stable"]).trim();
  const volatile = text(event["volatile"]).trim();
  const rest = shown.startsWith(settled)
    ? shown.slice(settled.length).trim()
    : [stable, volatile].filter(Boolean).join(" ");
  const revision = num(event["revision"]);
  return {
    settled,
    shown: shown || settled,
    unstable: rest,
    ...(stable ? { stable } : {}),
    ...(volatile ? { volatile } : {}),
    ...(revision !== null ? { revision } : {}),
    passes,
    language,
  };
}

export type StreamSessionDeps = {
  bridge: StreamBridge | null | undefined;
  onPartial?: (update: LiveWordsUpdate) => void;
  onEndpoint?: (endpoint: StreamEndpoint) => void;
  /** Called once when the stream gives up (refusal, throw, stall); the caller transcribes the ordinary way. */
  onFallback?: (reason: string) => void;
  /** A unique id for this utterance's stream. */
  streamId?: string;
};

/**
 * One utterance, one stream. `push` takes the new samples since the last call; `close` resolves the final text, or
 * null when the ordinary decode must run. A session is never reused.
 */
export class SttStreamSession {
  private phase: StreamSessionState = "idle";
  private id = "";
  private engine = "";
  private locale: StreamLocale = "";
  private chunkSamples = Math.round((DEFAULT_CHUNK_MS / 1000) * STREAM_RATE);
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private inFlight: Promise<void> | null = null;
  private opening: Promise<boolean> | null = null;
  private partials = 0;
  private ended = false;
  private reason = "";

  constructor(private readonly deps: StreamSessionDeps) {}

  get state(): StreamSessionState {
    return this.phase;
  }

  /** The ear judged the turn over (EndOfTurn). */
  get endOfTurn(): boolean {
    return this.ended;
  }

  get fallbackReason(): string {
    return this.reason;
  }

  /** True while the stream is opening or open: the ordinary early read and live-words passes stay off. */
  get live(): boolean {
    return this.phase === "opening" || this.phase === "open";
  }

  open(plan: StreamPlan): Promise<boolean> {
    if (this.phase !== "idle") return Promise.resolve(false);
    const bridge = this.deps.bridge;
    if (!streamWanted(plan.streamEngine)) return Promise.resolve(this.giveUp("off"));
    if (!bridge?.openSttStream || !bridge.feedSttStream || !bridge.closeSttStream)
      return Promise.resolve(this.giveUp("no-bridge"));
    this.phase = "opening";
    this.locale = plan.locale;
    const streamId = String(this.deps.streamId ?? "")
      .replace(/[^\w.:-]/g, "")
      .slice(0, ID_CHARS);
    const hotwords = plan.hotwords?.length ? [...plan.hotwords] : null;
    this.opening = (async () => {
      try {
        const reply = await bridge.openSttStream!({
          ...(streamId ? { streamId } : {}),
          streamEngine: plan.streamEngine,
          locale: plan.locale,
          ...(hotwords ? { hotwords } : {}),
          endpoint: true,
          localOnly: true,
        });
        if (!reply?.ok || !reply.streamId) return this.giveUp(text(reply?.reason) || "refused");
        if (this.phase !== "opening") {
          // Aborted while the model loaded: the ear holds a stream nobody wants.
          void bridge.closeSttStream!({ streamId: reply.streamId, finalize: false }).catch(
            () => undefined,
          );
          return false;
        }
        this.id = reply.streamId;
        this.engine = text(reply.engine);
        const ms = num(reply.chunkMs) ?? DEFAULT_CHUNK_MS;
        const clamped = Math.max(STREAM_MIN_CHUNK_MS, Math.min(STREAM_MAX_CHUNK_MS, ms));
        this.chunkSamples = Math.round((clamped / 1000) * STREAM_RATE);
        this.phase = "open";
        this.pump();
        return true;
      } catch {
        return this.giveUp("threw");
      }
    })();
    return this.opening;
  }

  /** New samples (16 kHz mono floats) since the last push. Sends whole chunks; never blocks. */
  push(samples: Float32Array): void {
    if (!this.live || !samples.length) return;
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    if (this.pendingSamples > (STREAM_MAX_BACKLOG_MS / 1000) * STREAM_RATE) {
      this.abort("stalled");
      return;
    }
    this.pump();
  }

  /**
   * End the stream. With `finalize` the ear reads the tail and answers the final text; null means "transcribe the
   * ordinary way" (refused, failed, empty, aborted).
   */
  async close(finalize = true): Promise<StreamFinal | null> {
    if (this.phase === "opening") await this.opening;
    if (this.phase !== "open") return null;
    this.phase = "closing";
    const bridge = this.deps.bridge!;
    try {
      await this.drain();
      if (this.phase !== "closing") return null;
      while (finalize && this.pendingSamples > 0) {
        const chunk = this.take(Math.round((STREAM_MAX_CHUNK_MS / 1000) * STREAM_RATE));
        if (!(await this.send(chunk))) return null;
      }
      const reply = await bridge.closeSttStream!({ streamId: this.id, finalize });
      this.phase = "closed";
      if (!reply?.ok) {
        this.reason = text(reply?.reason) || "close-refused";
        this.deps.onFallback?.(this.reason);
        return null;
      }
      const final = text(reply.text).trim();
      if (!finalize || !final) return null;
      return {
        text: final,
        words: Array.isArray(reply.words) ? reply.words : [],
        audioMs: num(reply.audioMs) ?? 0,
        rtf: num(reply.rtf) ?? 0,
        engine: this.engine,
        locale: this.locale,
      };
    } catch {
      this.giveUp("threw");
      return null;
    }
  }

  /** Drop the stream without a final (speech dropped, mic closed, stalled ear). Safe to call at any time. */
  abort(reason = "aborted"): void {
    const wasOpen = this.phase === "open" || this.phase === "closing";
    if (this.phase === "closed" || this.phase === "fallback") return;
    this.giveUp(reason, false);
    this.pending = [];
    this.pendingSamples = 0;
    if (wasOpen && this.id)
      void Promise.resolve(
        this.deps.bridge?.closeSttStream?.({ streamId: this.id, finalize: false }),
      ).catch(() => undefined);
  }

  private giveUp(reason: string, notify = true): false {
    this.reason ||= reason;
    this.phase = "fallback";
    if (notify) this.deps.onFallback?.(this.reason);
    return false;
  }

  private take(max: number): Float32Array {
    const count = Math.min(max, this.pendingSamples);
    const out = new Float32Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.pending[0]!;
      const need = count - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.pending.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.pending[0] = head.subarray(need);
        filled += need;
      }
    }
    this.pendingSamples -= count;
    return out;
  }

  private pump(): void {
    if (this.phase !== "open" || this.inFlight || this.pendingSamples < this.chunkSamples) return;
    const max = Math.round((STREAM_MAX_CHUNK_MS / 1000) * STREAM_RATE);
    const chunk = this.take(
      Math.min(max, Math.floor(this.pendingSamples / this.chunkSamples) * this.chunkSamples),
    );
    this.inFlight = this.send(chunk).then(() => {
      this.inFlight = null;
      this.pump();
    });
  }

  private async drain(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  /** One feed. False when the stream is over (the caller falls back). */
  private async send(chunk: Float32Array): Promise<boolean> {
    try {
      const reply = await this.deps.bridge!.feedSttStream!({
        streamId: this.id,
        pcm: pcm16Base64(chunk),
      });
      if (this.phase === "fallback" || this.phase === "closed") return false;
      if (!reply?.ok) return this.giveUp(text(reply?.reason) || "feed-refused");
      this.read(reply);
      return true;
    } catch {
      if (this.phase === "fallback" || this.phase === "closed") return false;
      return this.giveUp("threw");
    }
  }

  private read(
    reply: NonNullable<Awaited<ReturnType<NonNullable<StreamBridge["feedSttStream"]>>>>,
  ): void {
    const events = Array.isArray(reply.events) ? reply.events : [];
    let latest: { [key: string]: unknown } | null = null;
    for (const event of events) {
      if (event?.type === "partial") latest = event;
      else if (event?.type === "endpoint") this.endpoint(event);
    }
    if (!this.ended && reply.endpoint?.event === "EndOfTurn") this.endpoint(reply.endpoint);
    if (latest) {
      this.partials += 1;
      this.deps.onPartial?.(streamPartialUpdate(latest, this.partials, this.locale));
    }
  }

  private endpoint(event: { [key: string]: unknown }): void {
    const name = text(event["event"]);
    if (!name) return;
    if (name === "EndOfTurn") this.ended = true;
    else if (name === "TurnResumed" || name === "StartOfTurn") this.ended = false;
    this.deps.onEndpoint?.({
      event: name,
      reason: text(event["reason"]),
      silenceMs: num(event["silenceMs"]),
      audioMs: num(event["audioMs"]),
    });
  }
}

/**
 * The stream's final as the early-read slot of the dictation queue: `take` answers a transcribe-shaped reply when
 * the ear produced text, or null so the ordinary decode runs on the same audio.
 */
export function streamEarlyRead(final: Promise<StreamFinal | null>): {
  source: "stream";
  take: () => Promise<{
    ok: true;
    text: string;
    language: string;
    engine: string;
    elapsedMs?: number;
  } | null>;
  cancel: () => void;
} {
  return {
    source: "stream",
    take: async () => {
      const got = await final.catch(() => null);
      if (!got?.text.trim()) return null;
      return {
        ok: true,
        text: got.text,
        language: got.locale === "hi-en" ? "" : got.locale,
        engine: got.engine || "stream-ear",
      };
    },
    cancel: () => undefined,
  };
}

/**
 * The words shown for a heard line: FRIDAY Tidy (when on), then the spoken-number cleanup (`voice.itn`, default on).
 * Only what is shown changes; the command that reaches the Brain is the heard line. An empty result keeps the heard.
 */
export function shapeHeardText(
  heard: string,
  options: {
    tidy: boolean;
    itn: boolean;
    requested?: string;
    dictionary?: { heard: string; write: string }[];
  },
): { text: string; tidy?: { raw: string; changes: TidyChange[] } } {
  let shown = heard;
  let changes: TidyChange[] = [];
  if (options.tidy) {
    const done = tidyTranscript(heard, {
      ...(options.requested !== undefined ? { requested: options.requested } : {}),
      ...(options.dictionary ? { dictionary: options.dictionary } : {}),
    });
    if (done.changed && done.text.trim()) {
      shown = done.text;
      changes = done.changes;
    }
  }
  if (options.itn) {
    const itn = applyHinglishItn(shown);
    if (itn.changed && itn.text.trim()) shown = itn.text;
  }
  if (shown === heard) return { text: heard };
  return { text: shown, tidy: { raw: heard, changes } };
}

/** A bounded count of how heard lines kept the script policy (Hindi Devanagari, English Latin). Counts only. */
export class ScriptPolicyTally {
  private checks: ScriptCheck[] = [];

  constructor(private readonly keep = 50) {}

  note(heard: string, expected: string | undefined): ScriptCheck {
    const check = checkScriptPolicy(heard, expected);
    this.checks.push(check);
    if (this.checks.length > this.keep) this.checks.shift();
    return check;
  }

  summary(): ScriptSummary {
    return summariseScriptChecks(this.checks);
  }
}
