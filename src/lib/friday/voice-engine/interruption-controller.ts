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
    has(
      text,
      /^(stop|quiet|silence|chup|shant)( please)?$|^chup (ho )?(jao|raho)$|^shant$|चुप|शांत/u,
    )
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

const BACKCHANNEL = new Set(
  (
    "hmm hm haan han ha ji accha acha theek thik ok okay yes yeah yep right sure oh uh um achha hanji haanji " +
    "हाँ हां जी अच्छा ठीक हम्म"
  ).split(" "),
);

/** A short sound of agreement ("haan", "hmm", "ok") is not an interruption. */
export function isBackchannel(heard: string): boolean {
  const words = norm(heard).split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 2 && words.every((w) => BACKCHANNEL.has(w));
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
