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
 *   · a `turn` object on the reply (start, partial, eager, resumed, end, revised) is the turn protocol: it is parsed
 *     strictly into a `StreamTurn` and handed to `onTurn` and to the global `subscribeStreamTurns` listeners. A ear
 *     that sends no `turn` still gets one: the endpoint and partial events are turned into the same events.
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
    /** The turn protocol (see `parseStreamTurn`); absent from an ear that does not send it. */
    turn?: unknown;
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

/** The turn protocol: what the ear says about the owner's turn as it goes (see the kernel stream feed reply). */
export const TURN_EVENTS = ["start", "partial", "eager", "resumed", "end", "revised"] as const;
export type TurnEventName = (typeof TURN_EVENTS)[number];
export type TurnEnv = { kind: "speech" | "music" | "tv" | "noise"; score: number };
export type TurnSpeaker = { tag: "owner" | "other" | "unknown"; score: number };

/**
 * One turn event. `env` and `speaker` are tags about the room and the voice: they may raise a threshold or colour a
 * log line, and they are never read by any code that approves, confirms or authorises an action.
 */
export type StreamTurn = {
  turnId: string;
  event: TurnEventName;
  text: string;
  vadP: number | null;
  speechMs: number | null;
  env?: TurnEnv;
  speaker?: TurnSpeaker;
  clipped?: boolean;
  /** The ear asks for MORE proof (a wake word); it can never mean less. */
  needsWake?: boolean;
};

const ENV_KINDS: readonly TurnEnv["kind"][] = ["speech", "music", "tv", "noise"];
const SPEAKER_TAGS: readonly TurnSpeaker["tag"][] = ["owner", "other", "unknown"];

/** A `turn` object from the ear, strictly: an unknown event, a missing id or a wrong shape is no turn at all. */
export function parseStreamTurn(raw: unknown): StreamTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { [key: string]: unknown };
  const event = text(row["event"]);
  const turnId = text(row["turnId"]).slice(0, ID_CHARS);
  if (!turnId || !(TURN_EVENTS as readonly string[]).includes(event)) return null;
  const turn: StreamTurn = {
    turnId,
    event: event as TurnEventName,
    text: text(row["text"]),
    vadP: num(row["vadP"]),
    speechMs: num(row["speechMs"]),
  };
  const env = row["env"] as { [key: string]: unknown } | undefined;
  if (env && typeof env === "object") {
    const kind = text(env["kind"]) as TurnEnv["kind"];
    const score = num(env["score"]);
    if (ENV_KINDS.includes(kind) && score !== null) turn.env = { kind, score };
  }
  const speaker = row["speaker"] as { [key: string]: unknown } | undefined;
  if (speaker && typeof speaker === "object") {
    const tag = text(speaker["tag"]) as TurnSpeaker["tag"];
    const score = num(speaker["score"]);
    if (SPEAKER_TAGS.includes(tag) && score !== null) turn.speaker = { tag, score };
  }
  if (row["clipped"] === true) turn.clipped = true;
  if (row["needsWake"] === true) turn.needsWake = true;
  return turn;
}

type TurnListener = (turn: StreamTurn) => void;
const turnListeners = new Set<TurnListener>();

/** Hear every turn event of every stream session (one Auto session at a time). Returns the way to stop. */
export function subscribeStreamTurns(listener: TurnListener): () => void {
  turnListeners.add(listener);
  return () => {
    turnListeners.delete(listener);
  };
}

function emitTurn(deps: StreamSessionDeps, turn: StreamTurn): void {
  try {
    deps.onTurn?.(turn);
  } catch {
    /* a listener never breaks the stream */
  }
  for (const listener of [...turnListeners]) {
    try {
      listener(turn);
    } catch {
      /* a listener never breaks the stream */
    }
  }
}

export type StreamSessionDeps = {
  bridge: StreamBridge | null | undefined;
  onPartial?: (update: LiveWordsUpdate) => void;
  onEndpoint?: (endpoint: StreamEndpoint) => void;
  /** One turn event of the turn protocol (native from the ear, or built from its endpoint and partial events). */
  onTurn?: (turn: StreamTurn) => void;
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
  /** The ear sent a real `turn` at least once: the endpoint and partial events are no longer turned into turns. */
  private nativeTurns = false;
  private legacyTurn = { id: "", active: false, text: "" };
  private legacySeq = 0;

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
    const native = parseStreamTurn(reply.turn);
    if (native) this.nativeTurns = true;
    let latest: { [key: string]: unknown } | null = null;
    for (const event of events) {
      if (event?.type === "partial") {
        latest = event;
        this.legacyPartial(event);
      } else if (event?.type === "endpoint") {
        this.endpoint(event);
        this.legacyEndpoint(event);
      }
    }
    if (!this.ended && reply.endpoint?.event === "EndOfTurn") {
      this.endpoint(reply.endpoint);
      this.legacyEndpoint(reply.endpoint);
    }
    if (native) emitTurn(this.deps, native);
    if (latest) {
      this.partials += 1;
      this.deps.onPartial?.(streamPartialUpdate(latest, this.partials, this.locale));
    }
  }

  /** An ear with no `turn` still speaks the protocol: a partial opens the turn and carries its words. */
  private legacyPartial(event: { [key: string]: unknown }): void {
    if (this.nativeTurns) return;
    const words = text(event["text"]).trim() || text(event["committed"]).trim();
    this.legacyOpen(words);
    this.legacyEmit("partial", words);
  }

  private legacyEndpoint(event: { [key: string]: unknown }): void {
    if (this.nativeTurns) return;
    const name = text(event["event"]);
    if (name === "StartOfTurn") {
      this.legacyOpen("");
    } else if (name === "EndOfTurn") {
      this.legacyEmit("end", this.legacyTurn.text);
      this.legacyTurn.active = false;
    } else if (name === "TurnResumed") {
      this.legacyTurn.active = true;
      this.legacyEmit("resumed", this.legacyTurn.text);
    }
  }

  private legacyOpen(words: string): void {
    if (this.legacyTurn.active) return;
    this.legacySeq += 1;
    this.legacyTurn = {
      id: `${this.id || "stream"}-t${this.legacySeq}`,
      active: true,
      text: words,
    };
    this.legacyEmit("start", words);
  }

  private legacyEmit(event: TurnEventName, words: string): void {
    if (!this.legacyTurn.id) return;
    if (words) this.legacyTurn.text = words;
    emitTurn(this.deps, {
      turnId: this.legacyTurn.id,
      event,
      text: this.legacyTurn.text,
      vadP: null,
      speechMs: null,
    });
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

/** What the conductor should do with a turn event. */
export type TurnAction =
  | { kind: "draft"; turnId: string; text: string }
  | { kind: "cancel-draft"; turnId: string; why: "resumed" | "new-turn" | "revised" };

/** What the tracker knows of the turn that ended last, for the record that goes with its final text. */
export type TurnFacts = {
  turnId: string;
  eagerText: string;
  speaker: TurnSpeaker | null;
  env: TurnEnv | null;
  clipped: boolean;
};

/** The turn facts older than this are another turn's: a record is never built from them. */
export const TURN_FACTS_TTL_MS = 20_000;

/** Words compared the way a person reads them: case, punctuation and spacing do not count. */
export function sameWords(a: string, b: string): boolean {
  const key = (v: string) =>
    v
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
      .trim();
  const left = key(a);
  return left !== "" && left === key(b);
}

/**
 * Follows the turn protocol of the ear and says what the speculative draft should do. An `eager` event (the ear
 * thinks the owner is done) starts one draft, only when `eager()` says the owner switched it on; `resumed`, a new
 * turn id or a revised text that differs throws it away; the final text adopts it only when the words are equal
 * (the Brain decides that with `adoptDraft`). It reads text and ids only: it starts nothing itself, runs no tool,
 * and never lets `speaker` or `env` leave the record.
 */
export class TurnTracker {
  private turnId = "";
  private eagerText = "";
  private draftLive = false;
  private speaker: TurnSpeaker | null = null;
  private env: TurnEnv | null = null;
  private clipped = false;
  private lastAt = 0;
  private lastSpeechAt = Number.NEGATIVE_INFINITY;
  /** Eager endpoints seen, and how many of them the owner then continued past (the log of a wrong guess). */
  eagers = 0;
  resumes = 0;
  /** Voiced milliseconds the ear had counted when it last ended a turn; null until one ended. Kept across turns. */
  lastEndMs: number | null = null;
  /** The newest room tag the ear sent, kept across turns for the Doctor row. A tag only, never an authority. */
  lastEnv: TurnEnv | null = null;

  constructor(private readonly eager: () => boolean = () => false) {}

  /** Share of eager endpoints the owner spoke past, 0 when none was seen. Under 0.3 is the aim. */
  get resumeRatio(): number {
    return this.eagers === 0 ? 0 : Math.min(1, this.resumes / this.eagers);
  }

  get draftActive(): boolean {
    return this.draftLive;
  }

  /** The ear is hearing the owner (a turn event within `withinMs`): the voice is confirmed on the cleaned signal. */
  recentSpeech(now: number, withinMs: number): boolean {
    return now - this.lastSpeechAt <= withinMs;
  }

  ingest(turn: StreamTurn, now: number): TurnAction[] {
    const actions: TurnAction[] = [];
    if (this.turnId && turn.turnId !== this.turnId) {
      if (this.draftLive)
        actions.push({ kind: "cancel-draft", turnId: this.turnId, why: "new-turn" });
      this.reset();
    }
    if (!this.turnId) this.turnId = turn.turnId;
    this.lastAt = now;
    if (turn.event !== "end" && turn.event !== "revised") this.lastSpeechAt = now;
    else if ((turn.speechMs ?? 0) > 0) this.lastSpeechAt = now;
    if (turn.env) {
      this.env = turn.env;
      this.lastEnv = turn.env;
    }
    if (turn.event === "end" && typeof turn.speechMs === "number" && turn.speechMs >= 0)
      this.lastEndMs = turn.speechMs;
    if (turn.speaker) this.speaker = turn.speaker;
    if (turn.clipped) this.clipped = true;
    if (turn.event === "eager") {
      this.eagers += 1;
      this.eagerText = turn.text.trim();
      if (this.eagerText && this.eager() && !this.draftLive) {
        this.draftLive = true;
        actions.push({ kind: "draft", turnId: turn.turnId, text: this.eagerText });
      }
    } else if (turn.event === "resumed") {
      if (this.eagerText) this.resumes += 1;
      this.eagerText = "";
      if (this.draftLive) {
        this.draftLive = false;
        actions.push({ kind: "cancel-draft", turnId: turn.turnId, why: "resumed" });
      }
    } else if (
      turn.event === "revised" &&
      this.draftLive &&
      !sameWords(turn.text, this.eagerText)
    ) {
      this.draftLive = false;
      this.eagerText = "";
      actions.push({ kind: "cancel-draft", turnId: turn.turnId, why: "revised" });
    }
    return actions;
  }

  /** The facts of the turn that just ended, once; null when none is fresh (the final came from the ordinary path). */
  take(now: number): TurnFacts | null {
    if (!this.turnId || now - this.lastAt > TURN_FACTS_TTL_MS) {
      this.reset();
      return null;
    }
    const facts: TurnFacts = {
      turnId: this.turnId,
      eagerText: this.eagerText,
      speaker: this.speaker,
      env: this.env,
      clipped: this.clipped,
    };
    this.reset();
    return facts;
  }

  /** Forget the current turn (the draft is the caller's to discard). */
  reset(): void {
    this.turnId = "";
    this.eagerText = "";
    this.draftLive = false;
    this.speaker = null;
    this.env = null;
    this.clipped = false;
  }
}

export type TurnLang = "hi" | "en" | "hi-en" | "";

/** The language of a line and how mixed it is: the minority script's share of the letters, 0 for one script. */
export function languageMix(line: string, declared: string = ""): { lang: TurnLang; mix: number } {
  let deva = 0;
  let latin = 0;
  for (const ch of line) {
    if (/[\u0900-\u097F]/u.test(ch)) deva += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
  }
  const total = deva + latin;
  const mix = total === 0 ? 0 : Math.round((Math.min(deva, latin) / total) * 100) / 100;
  if (deva > 0 && latin > 0) return { lang: "hi-en", mix };
  const asked = streamLocale(declared);
  if (deva > 0) return { lang: "hi", mix };
  if (latin > 0) return { lang: asked === "hi" || asked === "hi-en" ? asked : "en", mix };
  return { lang: asked, mix };
}

/**
 * What goes to the Brain with a heard turn. `text` is what is shown and acted on, `textRaw` the ear's own words.
 * `speaker` and `env` are tags for logs and thresholds: no approval, confirmation or authority check reads them (a
 * test pins that), and the text is data, never an instruction.
 */
export type TurnRecord = {
  text: string;
  textRaw: string;
  lang: TurnLang;
  mix: number;
  confidence: number | null;
  turnId: string;
  eager: boolean;
  speaker: TurnSpeaker | null;
  env: TurnEnv | null;
  clipped: boolean;
  interruptedPlayedMs: number | null;
};

export function buildTurnRecord(input: {
  text: string;
  textRaw?: string;
  declaredLanguage?: string;
  confidence?: number | null;
  facts: TurnFacts | null;
  interruptedPlayedMs?: number | null;
}): TurnRecord {
  const { lang, mix } = languageMix(input.text, input.declaredLanguage ?? "");
  const facts = input.facts;
  const confidence =
    typeof input.confidence === "number" && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : null;
  const played = input.interruptedPlayedMs;
  return {
    text: input.text,
    textRaw: input.textRaw ?? input.text,
    lang,
    mix,
    confidence,
    turnId: facts?.turnId ?? "",
    eager: Boolean(facts?.eagerText) && sameWords(facts?.eagerText ?? "", input.text),
    speaker: facts?.speaker ?? null,
    env: facts?.env ?? null,
    clipped: facts?.clipped ?? false,
    interruptedPlayedMs:
      typeof played === "number" && Number.isFinite(played) && played >= 0
        ? Math.round(played)
        : null,
  };
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
