/**
 * FRIDAY · interruption controller (barge-in).
 *
 * Decides, from real frame facts, whether the owner is talking over FRIDAY, and when it does, stops the audible
 * speech first and everything else after it. Three separate rules:
 *   1. Debounce and echo guard. Speech only counts after `minSpeechMs` of continuous voice that is louder than
 *      the speaker echo reaching the microphone (`echoMargin` x the playback level). The first `guardMs` of a
 *      reply is ignored so the start of FRIDAY's own voice cannot interrupt her.
 *   2. Order. The playback stop runs first, so audible speech ends before the slower cancellations; then the
 *      TTS request, the streaming answer, the queued chunks. Each step is isolated: one that throws is
 *      reported, and the rest still run.
 *   3. Scope. A spoken stop ends speech only. A background task is cancelled, paused or resumed only by words
 *      that name it (`classifyVoiceControl`).
 */

export type Frame = {
  /** Milliseconds, from any monotonic clock. */
  t: number;
  /** The VAD verdict for this frame. */
  speech: boolean;
  /** Microphone level after echo cancellation, 0..1. */
  micLevel: number;
  /** Level currently sent to the speaker, 0..1. */
  playbackLevel: number;
};

export type BargeInOptions = {
  minSpeechMs?: number;
  guardMs?: number;
  echoMargin?: number;
  /** Lowest microphone level that can be a person even with silent playback. */
  floorLevel?: number;
};

export class BargeInDetector {
  private speechSince: number | null = null;
  private playbackStart: number | null = null;
  /** One barge-in per stretch of voice: set when it fires, cleared by a quiet frame. */
  private latched = false;
  private readonly minSpeechMs: number;
  private readonly guardMs: number;
  private readonly echoMargin: number;
  private readonly floorLevel: number;

  constructor(options: BargeInOptions = {}) {
    this.minSpeechMs = options.minSpeechMs ?? 180;
    this.guardMs = options.guardMs ?? 250;
    this.echoMargin = options.echoMargin ?? 1.6;
    this.floorLevel = options.floorLevel ?? 0.02;
  }

  /** Call when a reply starts to play. */
  playbackStarted(t: number): void {
    this.playbackStart = t;
    this.speechSince = null;
    this.latched = false;
  }

  playbackEnded(): void {
    this.playbackStart = null;
    this.speechSince = null;
  }

  /** True once, when a frame completes a barge-in. */
  push(frame: Frame): boolean {
    if (this.playbackStart === null) return false;
    if (frame.t - this.playbackStart < this.guardMs) return false;
    const louderThanEcho =
      frame.micLevel >= this.floorLevel && frame.micLevel >= frame.playbackLevel * this.echoMargin;
    if (!frame.speech || !louderThanEcho) {
      this.speechSince = null;
      this.latched = false;
      return false;
    }
    if (this.latched) return false;
    this.speechSince ??= frame.t;
    if (frame.t - this.speechSince < this.minSpeechMs) return false;
    this.speechSince = null;
    this.latched = true;
    return true;
  }
}

/**
 * Shadow comparison of the acoustic detector with what the live path really did. It changes nothing: it counts how
 * often the detector fires, how often the live path pauses her for speech, and how often both happen within
 * `windowMs` of each other. A detector that fires with no live pause, or the reverse, shows where the guard and
 * the detector disagree on the owner's own microphone and speakers.
 */
/** What the shadow knew when one side fired, so a disagreement can be read against the room it happened in. */
export type ShadowContext = { playbackLevel: number; micLevel: number };

export type ShadowResolved =
  | { kind: "both"; leadMs: number; playbackLevel: number; micLevel: number }
  | { kind: "detectorOnly"; playbackLevel: number; micLevel: number }
  | { kind: "liveOnly"; playbackLevel: number; micLevel: number };

export class BargeShadow {
  private pending: Array<{
    t: number;
    by: "detector" | "live";
    matched: boolean;
    context: ShadowContext;
  }> = [];
  detectorOnly = 0;
  liveOnly = 0;
  both = 0;

  /** `onResolved` hears every outcome once, when it is known (a pair at once, a one-sided hit when its window ends). */
  constructor(
    private readonly windowMs = 700,
    private readonly onResolved?: (outcome: ShadowResolved) => void,
  ) {}

  detectorFired(t: number, context: ShadowContext = { playbackLevel: 0, micLevel: 0 }): void {
    this.add(t, "detector", context);
  }

  liveFired(t: number, context: ShadowContext = { playbackLevel: 0, micLevel: 0 }): void {
    this.add(t, "live", context);
  }

  private add(t: number, by: "detector" | "live", context: ShadowContext): void {
    const other = this.pending.find(
      (e) => e.by !== by && !e.matched && Math.abs(e.t - t) <= this.windowMs,
    );
    if (other) {
      other.matched = true;
      this.both += 1;
      this.pending.push({ t, by, matched: true, context });
      const detectorAt = by === "detector" ? t : other.t;
      const liveAt = by === "live" ? t : other.t;
      this.onResolved?.({
        kind: "both",
        leadMs: detectorAt - liveAt,
        playbackLevel: Math.max(context.playbackLevel, other.context.playbackLevel),
        micLevel: Math.max(context.micLevel, other.context.micLevel),
      });
    } else this.pending.push({ t, by, matched: false, context });
    this.tick(t);
  }

  /** Count as one-sided every event that found no partner within the window. Call with the current time. */
  tick(now: number): void {
    const keep: typeof this.pending = [];
    for (const e of this.pending) {
      if (now - e.t <= this.windowMs) keep.push(e);
      else if (!e.matched) {
        if (e.by === "detector") this.detectorOnly += 1;
        else this.liveOnly += 1;
        this.onResolved?.({
          kind: e.by === "detector" ? "detectorOnly" : "liveOnly",
          playbackLevel: e.context.playbackLevel,
          micLevel: e.context.micLevel,
        });
      }
    }
    this.pending = keep;
  }

  line(now?: number): string {
    if (now !== undefined) this.tick(now);
    return this.both + this.detectorOnly + this.liveOnly === 0
      ? "no barge-in seen yet"
      : `${this.both} agreed · ${this.detectorOnly} detector only · ${this.liveOnly} live only`;
  }
}

export type StepName = "playback" | "ttsRequest" | "answerStream" | "queue" | "providerTruncate";

export type InterruptSteps = Partial<Record<StepName, (reason: string) => void | Promise<void>>>;

export type InterruptReport = {
  reason: string;
  /** Time until the playback stop returned, the figure that matters for what is audible. */
  audibleStopMs: number | null;
  totalMs: number;
  failed: { step: StepName; error: string }[];
  ran: StepName[];
};

const ORDER: StepName[] = ["playback", "ttsRequest", "answerStream", "queue", "providerTruncate"];

export class InterruptController {
  private active = false;
  constructor(
    private readonly steps: InterruptSteps,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** Stop speaking. Background tasks are not touched. A second call while one runs is ignored. */
  async interrupt(reason: string): Promise<InterruptReport | null> {
    if (this.active) return null;
    this.active = true;
    const start = this.clock();
    const report: InterruptReport = {
      reason,
      audibleStopMs: null,
      totalMs: 0,
      failed: [],
      ran: [],
    };
    try {
      for (const name of ORDER) {
        const step = this.steps[name];
        if (!step) continue;
        try {
          await step(reason);
          report.ran.push(name);
        } catch (error) {
          report.failed.push({
            step: name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (name === "playback") report.audibleStopMs = this.clock() - start;
      }
    } finally {
      report.totalMs = this.clock() - start;
      this.active = false;
    }
    return report;
  }
}

export type VoiceControl =
  | { kind: "stop-speaking" }
  | { kind: "stop-listening" }
  | { kind: "cancel-task" }
  | { kind: "pause-task" }
  | { kind: "resume-task" }
  | { kind: "none" };

const norm = (text: string): string =>
  text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const TASK = /\b(task|kaam|kam|background|report)\b|टास्क|काम/u;
const has = (text: string, pattern: RegExp): boolean => pattern.test(text);

/**
 * Words that control the voice session. "ruk jao" stops speech and nothing else; a task is cancelled, paused or
 * resumed only when the sentence names a task. Anything else is an ordinary request (`none`).
 */
export function classifyVoiceControl(heard: string): VoiceControl {
  const text = norm(heard.replace(/^(hey\s+)?friday\b[, ]*/i, ""));
  if (!text) return { kind: "none" };
  const names = has(text, TASK);
  if (names && has(text, /\b(cancel|band|stop|ruk|ruko|hata)\b|रद्द|बंद|रुको/u))
    return { kind: "cancel-task" };
  if (names && has(text, /\b(pause|rok)\b|\bruk(o|a)?\b|रोक/u)) return { kind: "pause-task" };
  if (names && has(text, /\b(resume|continue|jaari|dobara|phir se|chalu)\b|जारी|फिर से/u))
    return { kind: "resume-task" };
  if (
    has(text, /^(stop|quiet|silence|chup|shant)( please)?$|^chup (ho )?(jao|raho)$|^shant$|चुप|शांत/u)
  )
    return { kind: "stop-speaking" };
  if (
    has(
      text,
      /^(ruk|ruko|rukiye|ruk jao|ruko zara|ruk ja|wait|hold on|stop|stop it|bas|bas karo)\b/u,
    )
  )
    return { kind: "stop-speaking" };
  if (has(text, /^(रुक|रुको|रुकिए|बस)/u)) return { kind: "stop-speaking" };
  if (has(text, /\b(stop|band kar|mat) (listening|suno)\b|\bmat suno\b|सुनना बंद/u))
    return { kind: "stop-listening" };
  return { kind: "none" };
}

/**
 * The one list of nods ("I am following you"), shared by the interruption gate and by `isFollowingAlong` in
 * voice-session.ts. Single words first, then the phrases that are a nod only together.
 */
export const BACKCHANNEL_WORDS: readonly string[] = (
  "hmm hm haan han ha ji jee accha acha achha theek thik ok okay yes yeah yep yup right sure oh uh um hanji haanji " +
  "mhm mmhmm hmmm sahi bilkul हाँ हां जी अच्छा ठीक हम्म"
).split(" ");
export const BACKCHANNEL_PHRASES: readonly string[] = [
  "theek hai",
  "theek hai ji",
  "thik hai",
  "thik hai ji",
  "sahi hai",
  "accha hai",
  "achha hai",
  "acha hai",
  "ho gaya",
  "samajh gaya",
  "samajh gayi",
  "samajh gaye",
  "got it",
  "i see",
  "i know",
  "uh huh",
  "mm hmm",
  "ठीक है",
  "हां जी",
  "हाँ जी",
  "अच्छा जी",
];
const BACKCHANNEL = new Set(BACKCHANNEL_WORDS);
const BACKCHANNEL_PHRASE_SET = new Set(BACKCHANNEL_PHRASES);
/** Filled sounds in any length: "hmmmm", "mmm", "uhh", "aaa". */
const FILLED_SOUND = /^(?:h?m{1,}|hm+h?m*|u+h+|u+m+|a+h+|o+h+|a+c+h+a+|ha+n+|ji+)$/u;

/** A short sound of agreement ("haan", "hmm", "ok", "theek hai") is not an interruption. */
export function isBackchannel(heard: string): boolean {
  const text = norm(heard);
  if (!text) return false;
  if (BACKCHANNEL_PHRASE_SET.has(text)) return true;
  const words = text.split(" ").filter(Boolean);
  const nod = (w: string) => BACKCHANNEL.has(w) || FILLED_SOUND.test(w);
  if (words.length > 0 && words.length <= 2 && words.every(nod)) return true;
  // "haan theek hai", "ok ok right": up to three nods, where "hai" may stand beside one.
  return words.length === 3 && words.every((w) => nod(w) || w === "hai") && words.some(nod);
}

/**
 * Words that always stop her at once, whatever their length: a voice control ("ruk jao", "stop", a task word) and
 * a plain request to hold ("wait", "ruko", "ek minute", "one second", "hold on"). Ending speech is all this does.
 */
const HOLD_REQUEST =
  /^(?:(?:wait|ruko|ruk|rukiye|ek (?:minute|min|second|sec|pal)|one (?:minute|second|sec|moment)|just a (?:minute|second|sec|moment)|hold on|hold it|stop|bas|hang on)\b|रुको|रुक|रुकिए|एक (?:मिनट|सेकंड|पल)|बस)/u;

/** A bare refusal ("no", "nahi", "cancel", "galat") is a stop only when it is the whole line (or said twice). */
const REFUSAL_ONLY =
  /^(?:no|nope|nahi|nahin|nai|cancel|galat|नहीं|नही|गलत)(?: (?:no|nope|nahi|nahin|nai|cancel|it|please|yaar|ji))?$/u;

export function isImmediateStop(heard: string): boolean {
  if (classifyVoiceControl(heard).kind !== "none") return true;
  const text = norm(heard.replace(/^(hey\s+)?friday\b[, ]*/i, ""));
  return HOLD_REQUEST.test(text) || REFUSAL_ONLY.test(text);
}

export type InterruptionVerdict = "interrupt" | "resume" | "wait";

/**
 * After a possible barge-in, speech that turns out to be a backchannel or fewer than `minWords` words lets the
 * reply resume. A control word ("ruk jao") always interrupts. Until a transcript exists the verdict is "wait",
 * and after `timeoutMs` without words the interruption is judged false (noise, a cough).
 */
export function judgeInterruption(
  heard: string | null,
  waitedMs: number,
  options: { minWords?: number; timeoutMs?: number } = {},
): InterruptionVerdict {
  const minWords = options.minWords ?? 2;
  const timeoutMs = options.timeoutMs ?? 1500;
  if (heard === null || !norm(heard)) return waitedMs >= timeoutMs ? "resume" : "wait";
  if (classifyVoiceControl(heard).kind !== "none") return "interrupt";
  if (isBackchannel(heard)) return "resume";
  return norm(heard).split(" ").length < minWords ? "resume" : "interrupt";
}

/**
 * The backchannel gate (adapted from the adaptive-interruption idea of LiveKit Agents: voice activity alone does not
 * stop an agent that is talking). While FRIDAY speaks, the owner's voice only lowers her volume and starts a
 * candidate. The candidate becomes a real interruption only when the speech lasts `minDurationMs` and the recogniser
 * gives `minWords` words that are not a backchannel and not her own voice coming back. A stop or hold word ("ruko",
 * "wait", "ek minute") interrupts at once. Anything said while an answer is awaited (an approval question) reaches
 * the approval path at once, because a bare "yes" there is an answer, not a nod. Otherwise, after
 * `falseTimeoutMs` of silence the volume comes back and she carries on. The gate never hears who is speaking: a
 * speaker match cannot approve, interrupt or release anything here.
 */
export type InterruptGatePrefs = {
  /** Off: voice activity alone pauses her, as before the gate existed. */
  enabled: boolean;
  /** Speech must last this long before words can escalate it. */
  minDurationMs: number;
  /** Words that are not a backchannel before it escalates. */
  minWords: number;
  /** Silence after which a candidate with no words is judged false and the volume is restored. */
  falseTimeoutMs: number;
  /** Voice that continues this long (and is not a nod or her echo) pauses her playback; 0 never pauses. */
  pauseAfterMs: number;
  /** Voice that goes on this long with no word from the recogniser at all is treated as a real interruption. */
  noWordsEscalateMs: number;
  /** Real sound with no words yet: how long after it ends the final transcript is waited for. */
  finalWaitMs: number;
  /** How loud her voice is while the owner may be talking over her (0.05 to 0.8 of its own level). */
  duckLevel: number;
  /**
   * Opt-in (`BargeLadder`): duck at 150 ms of echo-cleaned speech, stop at 500 ms or one real word, resume with no
   * words by 2 s. Absent (the shipped default) the gate above rules exactly as before.
   */
  ladder?: boolean;
};

export const DEFAULT_INTERRUPT_GATE: InterruptGatePrefs = {
  enabled: true,
  minDurationMs: 400,
  minWords: 2,
  falseTimeoutMs: 1200,
  pauseAfterMs: 600,
  noWordsEscalateMs: 2500,
  finalWaitMs: 4000,
  duckLevel: 0.3,
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

const clampNum = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
};

/** A stored or odd shape reads the shipped defaults; every number is held inside a range that keeps her usable. */
export function sanitizeInterruptGate(raw: unknown): InterruptGatePrefs {
  const row: Partial<Record<keyof InterruptGatePrefs, unknown>> =
    raw && typeof raw === "object"
      ? (raw as Partial<Record<keyof InterruptGatePrefs, unknown>>)
      : {};
  const d = DEFAULT_INTERRUPT_GATE;
  return {
    enabled: row.enabled === undefined ? d.enabled : row.enabled === true,
    minDurationMs: clampInt(row.minDurationMs, 100, 3000, d.minDurationMs),
    minWords: clampInt(row.minWords, 1, 6, d.minWords),
    falseTimeoutMs: clampInt(row.falseTimeoutMs, 400, 5000, d.falseTimeoutMs),
    pauseAfterMs: clampInt(row.pauseAfterMs, 0, 3000, d.pauseAfterMs),
    noWordsEscalateMs: clampInt(row.noWordsEscalateMs, 1000, 10_000, d.noWordsEscalateMs),
    finalWaitMs: clampInt(row.finalWaitMs, 1000, 15_000, d.finalWaitMs),
    duckLevel: clampNum(row.duckLevel, 0.05, 0.8, d.duckLevel),
    ...(row.ladder === true ? { ladder: true } : {}),
  };
}

/** The numbers of the barge-in ladder (LiveKit and Unmute practice, starting values to be tuned on the owner's PC). */
export const BARGE_LADDER = {
  /** Echo-cleaned speech this long ducks her. */
  duckAtMs: 150,
  duckDb: -12,
  /** Echo-cleaned speech this long stops her (resumable), words or not. */
  stopAtMs: 500,
  /** No real word by now since the voice began: she carries on. */
  resumeAtMs: 2000,
  /** Around the start and the end of her turn a short overlap is a nod or a turn-taking blip, not a barge-in. */
  backchannelWindowMs: 1000,
} as const;

/** A level in dB as the gain the player applies (-12 dB is about 0.25). */
export const dbToGain = (db: number): number => Math.round(10 ** (db / 20) * 1000) / 1000;

/**
 * True when `t` is inside a window around her turn start or end, where duration alone never stops her. The end is
 * `null` while the reply is still being written (its length is not known yet), so only the start window applies.
 */
export function inBackchannelWindow(
  t: number,
  turn: { startedAt: number | null; endsAt: number | null },
  windowMs: number = BARGE_LADDER.backchannelWindowMs,
): boolean {
  if (turn.startedAt !== null && t >= turn.startedAt && t - turn.startedAt < windowMs) return true;
  return turn.endsAt !== null && Math.abs(t - turn.endsAt) < windowMs;
}

/** The milliseconds of her reply that were audible when the owner cut in, for the turn record. Null when unknown. */
export function interruptedPlayedMs(
  heard: { playedMs?: unknown } | null | undefined,
): number | null {
  const ms = heard?.playedMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
}

export type LadderInput = {
  /** Milliseconds from any monotonic clock. */
  t: number;
  /**
   * The owner's voice is heard on the echo-cleaned signal (the kernel's turn events, or the echo canceller running
   * with its reference). The reference-gated level test alone (mic louder than the speaker) is NOT this: pass false.
   */
  echoCleanedSpeech: boolean;
  /** The recogniser's words so far, or the final; null when none. */
  text: string | null;
  final?: boolean;
  waitingForAnswer?: boolean;
  /** `text` is her own voice coming back. */
  selfEcho?: boolean;
  /** When her reply began to sound, and when it is expected to end (null while unknown). */
  replyStartedAt: number | null;
  replyEndsAt: number | null;
};

export type LadderVerdict =
  | { kind: "wait" }
  | { kind: "duck"; gain: number }
  | { kind: "stop"; why: "duration" | "word" | "stop-word" | "approval-answer" }
  | { kind: "resume"; why: "no-words" | "backchannel" | "echo" };

/**
 * The barge-in ladder for one candidate (the owner's voice while she speaks): wait, duck, stop, or resume. It acts
 * only on echo-cleaned speech, so her own voice in the microphone, which the reference-gated level test cannot tell
 * from the owner, never ducks or stops her; words from the recogniser are the other way in. A nod ("haan", "hmm",
 * "ok", "acha") never stops her, and neither does duration alone inside the backchannel windows. It hears nothing
 * about who is speaking: a speaker match cannot duck, stop, resume or approve here.
 */
export class BargeLadder {
  private startedAt: number | null = null;
  private lastTick = 0;
  private speechMs = 0;
  private ducked = false;
  private stopped = false;
  private echoSeen = false;
  private nodSeen = false;

  constructor(private readonly config: typeof BARGE_LADDER = BARGE_LADDER) {}

  get active(): boolean {
    return this.startedAt !== null;
  }

  get duckedNow(): boolean {
    return this.ducked;
  }

  begin(t: number): void {
    if (this.startedAt !== null) return;
    this.startedAt = t;
    this.lastTick = t;
    this.speechMs = 0;
    this.ducked = false;
    this.stopped = false;
    this.echoSeen = false;
    this.nodSeen = false;
  }

  end(): void {
    this.startedAt = null;
    this.ducked = false;
    this.stopped = false;
  }

  /** Echo-cleaned speech heard so far in this candidate (ms). */
  heardMs(): number {
    return this.speechMs;
  }

  evaluate(input: LadderInput): LadderVerdict {
    if (this.startedAt === null) return { kind: "wait" };
    const cfg = this.config;
    if (input.echoCleanedSpeech) {
      // Never more than one poll's worth per look, so a stalled page cannot fake a long voice.
      this.speechMs += Math.min(250, Math.max(0, input.t - this.lastTick));
    }
    this.lastTick = Math.max(this.lastTick, input.t);
    const heard = input.text?.trim() ? input.text : null;
    if (heard && input.selfEcho) {
      this.echoSeen = true;
      if (input.final) return { kind: "resume", why: "echo" };
    } else if (heard) {
      if (isImmediateStop(heard)) return { kind: "stop", why: "stop-word" };
      if (input.waitingForAnswer) return { kind: "stop", why: "approval-answer" };
      if (isBackchannel(heard)) {
        this.nodSeen = true;
        if (input.final) return { kind: "resume", why: "backchannel" };
      } else if (this.speechMs > 0 || input.final) {
        // One real word is enough, but only from a voice the cleaned signal confirmed (or a final transcript).
        return { kind: "stop", why: "word" };
      }
    }
    const waited = input.t - this.startedAt;
    const speaking = input.echoCleanedSpeech;
    if (waited >= cfg.resumeAtMs && !speaking) return { kind: "resume", why: "no-words" };
    if (this.echoSeen || this.nodSeen) return { kind: "wait" };
    const windowed = inBackchannelWindow(input.t, {
      startedAt: input.replyStartedAt,
      endsAt: input.replyEndsAt,
    });
    if (windowed) return { kind: "wait" };
    if (!this.stopped && this.speechMs >= cfg.stopAtMs) {
      this.stopped = true;
      return { kind: "stop", why: "duration" };
    }
    if (!this.stopped && !this.ducked && this.speechMs >= cfg.duckAtMs) {
      this.ducked = true;
      return { kind: "duck", gain: dbToGain(cfg.duckDb) };
    }
    return { kind: "wait" };
  }
}

export type GateWhy =
  | "stop-word"
  | "approval-answer"
  | "words"
  | "long-speech"
  | "backchannel"
  | "echo"
  | "too-few-words"
  | "noise"
  | "silence";

export type GateVerdict =
  | { kind: "wait" }
  | { kind: "pause" }
  | { kind: "interrupt"; why: GateWhy }
  | { kind: "restore"; why: GateWhy };

export type GateInput = {
  /** Milliseconds from any monotonic clock. */
  t: number;
  /** The VAD hears speech now. */
  speechActive: boolean;
  /** The recogniser's words so far (a partial) or in all (the final), null when none came. */
  text: string | null;
  /** `text` is the final transcript of the utterance. */
  final?: boolean;
  /** A yes or no is being waited for (an approval, a read-back, a question). */
  waitingForAnswer?: boolean;
  /** `text` is FRIDAY's own voice coming back through the microphone. */
  selfEcho?: boolean;
};

export class InterruptGate {
  private startedAt: number | null = null;
  private lastSpeechAt = 0;
  /** Time the voice was really heard (a gap of silence between two coughs is not speech). */
  private speechAccumMs = 0;
  private lastTick = 0;
  private echoSeen = false;
  private pausedSent = false;

  constructor(private readonly config: () => InterruptGatePrefs = () => DEFAULT_INTERRUPT_GATE) {}

  get active(): boolean {
    return this.startedAt !== null;
  }

  /** The owner's voice was heard while she speaks. A second call during a candidate only notes the voice again. */
  begin(t: number): void {
    if (this.startedAt === null) {
      this.startedAt = t;
      this.echoSeen = false;
      this.pausedSent = false;
      this.speechAccumMs = 0;
    }
    this.lastSpeechAt = t;
    this.lastTick = t;
  }

  /** The candidate is over, whatever the outcome. */
  end(): void {
    this.startedAt = null;
    this.echoSeen = false;
    this.pausedSent = false;
  }

  /** How long the voice has lasted so far (0 when no candidate). */
  speechMs(): number {
    return this.startedAt === null ? 0 : this.speechAccumMs;
  }

  evaluate(input: GateInput): GateVerdict {
    if (this.startedAt === null) return { kind: "wait" };
    const cfg = this.config();
    if (input.speechActive) {
      // Count the time between looks, never more than one poll's worth, so a stalled page cannot fake a long voice.
      this.speechAccumMs += Math.min(250, Math.max(0, input.t - this.lastTick));
      this.lastSpeechAt = Math.max(this.lastSpeechAt, input.t);
    }
    this.lastTick = Math.max(this.lastTick, input.t);
    const text = input.text?.trim() ? input.text : null;
    const final = input.final === true;
    if (text && input.selfEcho) this.echoSeen = true;
    let shortWhy: GateWhy | null = null;
    if (text && !input.selfEcho) {
      if (isImmediateStop(text)) return { kind: "interrupt", why: "stop-word" };
      if (input.waitingForAnswer) return { kind: "interrupt", why: "approval-answer" };
      if (isBackchannel(text)) {
        if (final) return { kind: "restore", why: "backchannel" };
        shortWhy = "backchannel";
      } else {
        // A final line that is not a nod and not her own voice is a turn of the owner's: it is never dropped,
        // however few words it has ("kya", "wapas"). Earlier, a partial must reach `minWords` and `minDurationMs`.
        if (final) return { kind: "interrupt", why: "words" };
        const words = norm(text).split(" ").filter(Boolean).length;
        if (words >= cfg.minWords && this.speechMs() >= cfg.minDurationMs)
          return { kind: "interrupt", why: "words" };
        shortWhy = "too-few-words";
      }
    } else if (text && final) {
      return { kind: "restore", why: "echo" };
    }
    const silentFor = input.t - this.lastSpeechAt;
    // Pause on voice, decide on words: playback stops (it can resume) once real voice has gone on long enough.
    if (
      !this.pausedSent &&
      cfg.pauseAfterMs > 0 &&
      this.speechAccumMs >= cfg.pauseAfterMs &&
      !this.echoSeen &&
      shortWhy !== "backchannel"
    ) {
      this.pausedSent = true;
      return { kind: "pause" };
    }
    if (input.speechActive) {
      const heardNothing = text === null && !this.echoSeen;
      if (heardNothing && input.t - this.startedAt >= cfg.noWordsEscalateMs)
        return { kind: "interrupt", why: "long-speech" };
      return { kind: "wait" };
    }
    if (shortWhy) {
      return silentFor >= cfg.falseTimeoutMs
        ? { kind: "restore", why: shortWhy }
        : { kind: "wait" };
    }
    if (this.echoSeen) {
      return silentFor >= cfg.falseTimeoutMs ? { kind: "restore", why: "echo" } : { kind: "wait" };
    }
    if (this.speechMs() < cfg.minDurationMs) {
      return silentFor >= cfg.falseTimeoutMs ? { kind: "restore", why: "noise" } : { kind: "wait" };
    }
    // Real sound and no words yet: the final transcript can still come.
    return silentFor >= Math.max(cfg.finalWaitMs, cfg.falseTimeoutMs)
      ? { kind: "restore", why: "silence" }
      : { kind: "wait" };
  }
}
