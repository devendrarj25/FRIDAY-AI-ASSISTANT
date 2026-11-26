/**
 * Turn-taking metrics: pure scorers over one recorded trace of a voice session. A trace is a list of events with
 * a time in milliseconds on one clock (the simulator's 80 ms frame clock in tests, a recorded session later); the
 * scorers read it and nothing else. No clock, no random, no I/O here, so the same trace always scores the same.
 *
 * Words used below:
 * - end of speech: the end of the last voiced frame of the owner's turn (not the ear's decision).
 * - first sound: the first sample at the output buffer (the `first-audio` event), not the moment speech was asked.
 * - truth: a label the script author puts on the owner's speech (a nod, a real interruption, a pause that goes
 *   on). Metrics that need a right answer read it; nothing else does.
 */
import { sameWords, type TurnEventName } from "./stream-session";

/** The frame clock every event sits on. */
export const FRAME_MS = 80;
/** A frame with at least this speech probability counts as voiced. */
export const VOICED_P = 0.5;

/** Proposed thresholds (the evaluation plan of the voice architecture); named so a later change is one line. */
export const TTFA_P50_MAX_MS = 1200;
export const TTFA_P90_MAX_MS = 2500;
export const FALSE_CUT_MAX_RATE = 0.03;
export const MID_SENTENCE_TAKEOVER_MAX_RATE = 0.15;
export const INTERRUPT_STOP_MIN_RATE = 0.95;
export const INTERRUPT_STOP_WITHIN_MS = 300;
export const BACKCHANNEL_FALSE_STOP_MAX_RATE = 0.02;

/**
 * The live gates of the voice architecture. Rates must be strictly below the number; `bargeToSilenceP95Ms` and
 * `ttfaP95Ms` are at most the number; `commandLaneP95Ms` is strictly below it. A gate with no samples is `null`.
 */
export const VOICE_TURN_GATES = Object.freeze({
  /** Barge-ins (voice over her) that stopped her though they were a nod or noise, over labelled barge-ins. */
  falseInterrupt: 0.1,
  /** Turns where she took the floor while the owner's voice was on. */
  falseCut: 0.03,
  /** Turns the owner had to carry on after the engine had closed them (the owner was cut off). */
  cutOff: 0.05,
  bargeToSilenceP95Ms: 300,
  ttfaP95Ms: 1500,
  /** The command lane: hand-over of the command to the lane report. */
  commandLaneP95Ms: 50,
});

/** After a turn ended, a continuation inside this window means the end was premature. */
export const CONTINUATION_WINDOW_MS = 3000;
/** A barge-in is looked at until this long after its first voiced frame. */
export const BARGE_STOP_WINDOW_MS = 5000;
/** A truth label counts for a barge-in when it sits within this long after the voice began. */
export const BARGE_TRUTH_WINDOW_MS = 1000;
/** A pause with no later voiced frame is judged inside this window. */
export const PAUSE_WINDOW_MS = 4000;

export type TruthKind =
  | "command"
  | "continuation"
  | "pause"
  | "backchannel"
  | "interruption"
  | "noise"
  | "stop-word"
  | "answer";

export type BrainEv = "lane" | "first-token" | "clause" | "done" | "refused";
export type TtsEv = "first-audio" | "clause-end" | "drained" | "failed";
export type ControlEv = "stop-all" | "mute" | "pause" | "wake" | "asked";
export type LaneName = "command" | "quick" | "full";

/** One thing that happened, with its time. `turnId` ties a reply event to the turn that caused it. */
export type TraceEvent = { t: number } & (
  | { k: "vad"; p: number }
  | { k: "ear"; event: TurnEventName; turnId: string; text: string }
  | { k: "final"; text: string; turnId?: string }
  | { k: "dispatch"; text: string; turnId?: string }
  | { k: "say"; text: string; turnId?: string }
  | { k: "brain"; ev: BrainEv; runId: string; turnId?: string; lane?: LaneName; reason?: string }
  | { k: "tts"; ev: TtsEv; utteranceId: string; playedMs: number; turnId?: string }
  | { k: "duck"; on: boolean }
  | { k: "stop" }
  | { k: "cancel" }
  | { k: "control"; ev: ControlEv }
  | { k: "truth"; kind: TruthKind }
);

type Of<K extends TraceEvent["k"]> = Extract<TraceEvent, { k: K }>;

export type StageMs = {
  listenMs: number | null;
  endpointMs: number | null;
  finalMs: number | null;
  brainMs: number | null;
  firstSoundMs: number | null;
};

export type TurnMetrics = {
  turnId: string;
  startAt: number;
  speechEndAt: number | null;
  /** The last transcript the controller received for this turn. */
  text: string;
  /** End of speech to the first sample at the output buffer. */
  ttfaMs: number | null;
  /** End of speech to the ear's `end` event. */
  eotWaitMs: number | null;
  /** True: an eager end after the last words had the final text and was not resumed. False: it was wrong. Null: none. */
  draftHit: boolean | null;
  eagerCount: number;
  resumedCount: number;
  /** Resumed over eager for this turn, null without an eager end. */
  eagerResumedRatio: number | null;
  /** The owner's voice began while she spoke: that voice to the output stopping. Null without a stop. */
  bargeToSilenceMs: number | null;
  /** She was stopped by something that was not an interruption (a nod, noise). */
  falseInterrupt: boolean;
  /** The agent started (speech asked, or first sound) while the owner's voice was on. */
  falseCut: boolean;
  /** The turn was closed and the owner went on speaking (whether or not the agent had started). */
  prematureEnd: boolean;
  stages: StageMs;
  /** How many voices failed before the one that played (0 = the first choice). */
  fallbackRung: number;
  /** The lane the Brain reported, when it did. */
  lane: LaneName | null;
  /** Hand-over of the command to the first report of the command lane. Null on any other lane. */
  commandLaneMs: number | null;
  refused: boolean;
};

export type BargeScore = {
  at: number;
  truth: TruthKind | null;
  ducked: boolean;
  stoppedAt: number | null;
  silenceMs: number | null;
  /** A real interruption or stop word that stopped her inside `INTERRUPT_STOP_WITHIN_MS`. */
  stoppedInTime: boolean;
  /** A nod or noise that stopped her. */
  falseStop: boolean;
  /** A real interruption, stop word or answer: voice to the output stopping (any time inside the window). */
  takeoverMs: number | null;
};

export type PauseScore = { at: number; resumedAt: number | null; takeover: boolean };

export type ControlScore = { ev: ControlEv; at: number; silenceMs: number | null };

export type TraceScore = {
  turns: TurnMetrics[];
  barges: BargeScore[];
  pauses: PauseScore[];
  controls: ControlScore[];
};

/** A voice over her that should stop her: an interruption, a stop word, or the answer to a question she asked. */
const isRealBarge = (truth: TruthKind | null): boolean =>
  truth === "interruption" || truth === "stop-word" || truth === "answer";

const first = <T>(list: readonly T[]): T | undefined => list[0];
const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

const voiced = (e: TraceEvent): e is Of<"vad"> => e.k === "vad" && e.p >= VOICED_P;

/** Barge episodes: the first voiced frame of a run of voice while the agent's voice was playing. */
function scoreBarges(trace: readonly TraceEvent[]): BargeScore[] {
  const out: BargeScore[] = [];
  let speaking = false;
  let wasVoiced = false;
  for (const e of trace) {
    if (e.k === "tts") {
      if (e.ev === "first-audio") speaking = true;
      else if (e.ev === "drained" || e.ev === "failed") speaking = false;
    } else if (e.k === "stop") speaking = false;
    else if (e.k === "control" && e.ev !== "wake" && e.ev !== "asked") speaking = false;
    if (e.k !== "vad") continue;
    const on = e.p >= VOICED_P;
    if (on && !wasVoiced && speaking) out.push(scoreBarge(trace, e.t));
    wasVoiced = on;
  }
  return out;
}

function scoreBarge(trace: readonly TraceEvent[], at: number): BargeScore {
  const truthEvent = first(
    trace.filter(
      (e): e is Of<"truth"> =>
        e.k === "truth" &&
        e.t >= at - FRAME_MS &&
        e.t <= at + BARGE_TRUTH_WINDOW_MS &&
        ["interruption", "backchannel", "noise", "stop-word", "answer"].includes(e.kind),
    ),
  );
  const truth = truthEvent?.kind ?? null;
  const stop = first(
    trace.filter((e) => e.k === "stop" && e.t >= at && e.t <= at + BARGE_STOP_WINDOW_MS),
  );
  const stoppedAt = stop ? stop.t : null;
  const silenceMs = stoppedAt === null ? null : stoppedAt - at;
  const until = stoppedAt ?? at + BARGE_STOP_WINDOW_MS;
  const ducked = trace.some((e) => e.k === "duck" && e.on && e.t >= at && e.t <= until);
  const real = isRealBarge(truth);
  return {
    at,
    truth,
    ducked,
    stoppedAt,
    silenceMs,
    stoppedInTime: real && silenceMs !== null && silenceMs <= INTERRUPT_STOP_WITHIN_MS,
    falseStop: (truth === "backchannel" || truth === "noise") && stoppedAt !== null,
    takeoverMs: real ? silenceMs : null,
  };
}

/** Pauses the owner marked as "I am not done": did the engine take the turn before the voice came back? */
function scorePauses(trace: readonly TraceEvent[]): PauseScore[] {
  return trace
    .filter((e): e is Of<"truth"> => e.k === "truth" && e.kind === "pause")
    .map((pause) => {
      const resume = first(trace.filter((e) => voiced(e) && e.t > pause.t));
      const resumedAt = resume ? resume.t : null;
      const until = resumedAt ?? pause.t + PAUSE_WINDOW_MS;
      const takeover = trace.some(
        (e) =>
          e.t >= pause.t &&
          e.t < until &&
          (e.k === "dispatch" || e.k === "say" || (e.k === "ear" && e.event === "end")),
      );
      return { at: pause.t, resumedAt, takeover };
    });
}

/** Stop everything, mute and pause: how long until the output was silent. */
function scoreControls(trace: readonly TraceEvent[]): ControlScore[] {
  return trace
    .filter(
      (e): e is Of<"control"> =>
        e.k === "control" && (e.ev === "stop-all" || e.ev === "mute" || e.ev === "pause"),
    )
    .map((c) => {
      const stop = first(trace.filter((e) => e.k === "stop" && e.t >= c.t));
      return { ev: c.ev, at: c.t, silenceMs: stop ? stop.t - c.t : null };
    });
}

type TurnWindow = { turnId: string; startAt: number; endAt: number };

function turnWindows(trace: readonly TraceEvent[]): TurnWindow[] {
  const starts = trace.filter((e): e is Of<"ear"> => e.k === "ear" && e.event === "start");
  return starts.map((s, i) => ({
    turnId: s.turnId,
    startAt: s.t,
    endAt: starts[i + 1]?.t ?? Number.POSITIVE_INFINITY,
  }));
}

/** An event belongs to the turn it names, else to the turn whose window holds its time. */
function belongs(e: TraceEvent, window: TurnWindow): boolean {
  const named = (e as { turnId?: string }).turnId;
  if (named !== undefined && named !== "") return named === window.turnId;
  return e.t >= window.startAt && e.t < window.endAt;
}

const gap = (from: number | null | undefined, to: number | null | undefined): number | null =>
  from == null || to == null || to < from ? null : to - from;

function scoreTurn(trace: readonly TraceEvent[], window: TurnWindow): TurnMetrics {
  const own = trace.filter((e) => belongs(e, window));
  const ears = own.filter((e): e is Of<"ear"> => e.k === "ear" && e.turnId === window.turnId);
  const endEvent = first(ears.filter((e) => e.event === "end"));
  const endAt = endEvent ? endEvent.t : null;
  // The owner's own voiced frames up to the ear's end (or the window's end when it never ended).
  const frames = trace.filter(
    (e): e is Of<"vad"> =>
      voiced(e) && e.t >= window.startAt - FRAME_MS && e.t < (endAt ?? window.endAt),
  );
  const lastFrame = last(frames);
  const speechEndAt = lastFrame ? lastFrame.t + FRAME_MS : null;

  const eagers = ears.filter((e) => e.event === "eager");
  const resumes = ears.filter((e) => e.event === "resumed");
  const finals = own.filter((e): e is Of<"final"> => e.k === "final");
  const finalEvent = last(finals);
  const finalText = finalEvent?.text ?? "";
  // The eager end that came after the last words is the one that can be right.
  const lateEager = last(eagers.filter((e) => speechEndAt === null || e.t >= speechEndAt));
  const resumedAfter = lateEager ? resumes.some((r) => r.t > lateEager.t) : false;
  const draftHit =
    lateEager === undefined
      ? null
      : !resumedAfter && finalText !== "" && sameWords(lateEager.text, finalText);

  const dispatch = first(own.filter((e): e is Of<"dispatch"> => e.k === "dispatch"));
  const brains = own.filter((e): e is Of<"brain"> => e.k === "brain");
  const firstToken = first(brains.filter((e) => e.ev === "first-token"));
  const tts = own.filter((e): e is Of<"tts"> => e.k === "tts");
  const firstAudio = first(tts.filter((e) => e.ev === "first-audio"));
  const signalAt = lateEager?.t ?? endAt;

  const stages: StageMs = {
    listenMs: gap(window.startAt, speechEndAt),
    endpointMs: gap(speechEndAt, signalAt),
    finalMs: gap(endAt, dispatch?.t),
    brainMs: gap(dispatch?.t, firstToken?.t),
    firstSoundMs: gap(firstToken?.t, firstAudio?.t),
  };

  const barges = scoreBarges(trace).filter(
    (b) => b.at >= window.startAt - 2 * FRAME_MS && b.at < window.endAt,
  );
  const barge = first(barges);

  const continuation =
    endAt !== null &&
    trace.some(
      (e) =>
        e.k === "truth" &&
        e.kind === "continuation" &&
        e.t >= endAt &&
        e.t < endAt + CONTINUATION_WINDOW_MS,
    );
  // The agent took the floor: speech asked of the voice, or sound at the output, while the owner's voice was on.
  const talkedOver = own.some(
    (e) =>
      (e.k === "say" || (e.k === "tts" && e.ev === "first-audio")) &&
      trace.some((v) => voiced(v) && v.t >= e.t - FRAME_MS && v.t <= e.t),
  );
  const lane = last(brains.filter((e) => e.lane !== undefined))?.lane ?? null;
  const firstCommandReport = first(brains.filter((e) => e.lane === "command"));
  const commandLaneMs = gap(dispatch?.t, firstCommandReport?.t);

  return {
    turnId: window.turnId,
    startAt: window.startAt,
    speechEndAt,
    text: finalText,
    ttfaMs: gap(speechEndAt, firstAudio?.t),
    eotWaitMs: gap(speechEndAt, endAt),
    draftHit,
    eagerCount: eagers.length,
    resumedCount: resumes.length,
    eagerResumedRatio: eagers.length === 0 ? null : Math.min(1, resumes.length / eagers.length),
    bargeToSilenceMs: barge?.silenceMs ?? null,
    falseInterrupt: barges.some((b) => b.falseStop),
    falseCut: talkedOver,
    prematureEnd: continuation,
    stages,
    fallbackRung: tts.filter((e) => e.ev === "failed").length,
    lane,
    commandLaneMs,
    refused: brains.some((e) => e.ev === "refused"),
  };
}

/** Score one trace: every turn, barge-in, mid-sentence pause and control in it. */
export function scoreTrace(trace: readonly TraceEvent[]): TraceScore {
  const ordered = [...trace].sort((a, b) => a.t - b.t);
  return {
    turns: turnWindows(ordered).map((w) => scoreTurn(ordered, w)),
    barges: scoreBarges(ordered),
    pauses: scorePauses(ordered),
    controls: scoreControls(ordered),
  };
}

/** Nearest-rank percentile of a list (q in 0..1); null for an empty list. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1] ?? null;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Wilson score interval for `successes` out of `n` (z = 1.96 is 95%). With no samples it is the whole range. */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = Math.min(1, Math.max(0, successes / n));
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: round4(Math.max(0, centre - half)), high: round4(Math.min(1, centre + half)) };
}

export type RateStat = { k: number; n: number; rate: number | null; low: number; high: number };

export function rateStat(k: number, n: number): RateStat {
  const { low, high } = wilsonInterval(k, n);
  return { k, n, rate: n === 0 ? null : round4(k / n), low, high };
}

export type SpreadStat = { n: number; p50: number | null; p90: number | null };

export function spreadStat(values: readonly number[]): SpreadStat {
  return { n: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9) };
}

export type RunMetrics = {
  turns: number;
  ttfa: SpreadStat;
  eotWait: SpreadStat;
  draftHit: RateStat;
  eagerResumed: RateStat;
  falseCut: RateStat;
  falseInterrupt: RateStat;
  /** Real interruptions and stop words that stopped her inside the limit. */
  interruptStopped: RateStat;
  bargeToSilence: SpreadStat;
  /** Nods and noise that stopped her. */
  backchannelFalseStop: RateStat;
  midSentenceTakeover: RateStat;
  /** Pause takeover rate: marked pauses the engine took over (the same numbers as `midSentenceTakeover`). */
  pauseTOR: RateStat;
  /** Turns the engine closed and the owner carried on inside the window: the owner was cut off. */
  cutOff: RateStat;
  /** Real interruptions, stop words and answers: voice to the output stopping. */
  takeoverLatency: SpreadStat;
  ttfaP95Ms: number | null;
  bargeToSilenceP95Ms: number | null;
  commandLaneP95Ms: number | null;
  fallbackRungs: Record<string, number>;
};

/** Run-level numbers over one or many scored traces. */
export function aggregateRun(scores: readonly TraceScore[]): RunMetrics {
  const turns = scores.flatMap((s) => s.turns);
  const barges = scores.flatMap((s) => s.barges);
  const pauses = scores.flatMap((s) => s.pauses);
  const nums = (pick: (t: TurnMetrics) => number | null): number[] =>
    turns.map(pick).filter((v): v is number => v !== null);
  const eagers = turns.reduce((sum, t) => sum + t.eagerCount, 0);
  const resumed = turns.reduce((sum, t) => sum + t.resumedCount, 0);
  const drafts = turns.filter((t) => t.draftHit !== null);
  const real = barges.filter((b) => isRealBarge(b.truth));
  const nods = barges.filter((b) => b.truth === "backchannel" || b.truth === "noise");
  const rungs: Record<string, number> = {};
  for (const t of turns) rungs[String(t.fallbackRung)] = (rungs[String(t.fallbackRung)] ?? 0) + 1;
  return {
    turns: turns.length,
    ttfa: spreadStat(nums((t) => t.ttfaMs)),
    eotWait: spreadStat(nums((t) => t.eotWaitMs)),
    draftHit: rateStat(drafts.filter((t) => t.draftHit === true).length, drafts.length),
    eagerResumed: rateStat(Math.min(resumed, eagers), eagers),
    falseCut: rateStat(turns.filter((t) => t.falseCut).length, turns.length),
    falseInterrupt: rateStat(
      barges.filter((b) => b.falseStop).length,
      barges.filter((b) => b.truth !== null).length,
    ),
    interruptStopped: rateStat(real.filter((b) => b.stoppedInTime).length, real.length),
    bargeToSilence: spreadStat(
      barges.map((b) => b.silenceMs).filter((v): v is number => v !== null),
    ),
    backchannelFalseStop: rateStat(nods.filter((b) => b.falseStop).length, nods.length),
    midSentenceTakeover: rateStat(pauses.filter((p) => p.takeover).length, pauses.length),
    pauseTOR: rateStat(pauses.filter((p) => p.takeover).length, pauses.length),
    cutOff: rateStat(turns.filter((t) => t.prematureEnd).length, turns.length),
    takeoverLatency: spreadStat(
      barges.map((b) => b.takeoverMs).filter((v): v is number => v !== null),
    ),
    ttfaP95Ms: percentile(
      nums((t) => t.ttfaMs),
      0.95,
    ),
    bargeToSilenceP95Ms: percentile(
      barges.map((b) => b.silenceMs).filter((v): v is number => v !== null),
      0.95,
    ),
    commandLaneP95Ms: percentile(
      nums((t) => t.commandLaneMs),
      0.95,
    ),
    fallbackRungs: rungs,
  };
}

export type Verdict = {
  name: string;
  /** Null when the run held no sample for this check. */
  pass: boolean | null;
  value: number | null;
  limit: number;
};

const atMost = (name: string, value: number | null, limit: number): Verdict => ({
  name,
  pass: value === null ? null : value <= limit,
  value,
  limit,
});
const atLeast = (name: string, value: number | null, limit: number): Verdict => ({
  name,
  pass: value === null ? null : value >= limit,
  value,
  limit,
});

/** The run against the proposed thresholds. A threshold with no samples is `null`, never a pass. */
export function judgeRun(run: RunMetrics): Verdict[] {
  return [
    atMost("ttfa p50 ms", run.ttfa.p50, TTFA_P50_MAX_MS),
    atMost("ttfa p90 ms", run.ttfa.p90, TTFA_P90_MAX_MS),
    atMost("false cut rate", run.falseCut.rate, FALSE_CUT_MAX_RATE),
    atMost(
      "mid-sentence takeover rate",
      run.midSentenceTakeover.rate,
      MID_SENTENCE_TAKEOVER_MAX_RATE,
    ),
    atLeast("interrupt stopped in time rate", run.interruptStopped.rate, INTERRUPT_STOP_MIN_RATE),
    atMost(
      "backchannel false stop rate",
      run.backchannelFalseStop.rate,
      BACKCHANNEL_FALSE_STOP_MAX_RATE,
    ),
  ];
}

const below = (name: string, value: number | null, limit: number): Verdict => ({
  name,
  pass: value === null ? null : value < limit,
  value,
  limit,
});

/** The run against `VOICE_TURN_GATES`. A gate with no samples is `null`, never a pass. */
export function judgeGates(run: RunMetrics): Verdict[] {
  return [
    below("false interrupt rate", run.falseInterrupt.rate, VOICE_TURN_GATES.falseInterrupt),
    below("false cut rate", run.falseCut.rate, VOICE_TURN_GATES.falseCut),
    below("cut off rate", run.cutOff.rate, VOICE_TURN_GATES.cutOff),
    atMost(
      "barge to silence p95 ms",
      run.bargeToSilenceP95Ms,
      VOICE_TURN_GATES.bargeToSilenceP95Ms,
    ),
    atMost("ttfa p95 ms", run.ttfaP95Ms, VOICE_TURN_GATES.ttfaP95Ms),
    below("command lane p95 ms", run.commandLaneP95Ms, VOICE_TURN_GATES.commandLaneP95Ms),
  ];
}

export type TurnMetricsSummary = {
  /** Events held now. */
  events: number;
  /** Events thrown away because the recorder was full (the oldest go first). */
  dropped: number;
  score: TraceScore;
  run: RunMetrics;
  gates: Verdict[];
};

export type TurnMetricsRecorder = {
  /** Add one event. Its time `t` is the caller's (a frame clock or a session clock); a bad time is refused. */
  record(event: TraceEvent): void;
  /** Score what was recorded. Reading it changes nothing; recording can go on after it. */
  summary(): TurnMetricsSummary;
};

/** Events one recorder keeps before it drops the oldest. About an hour of a busy session. */
export const DEFAULT_RECORDER_EVENTS = 50_000;

/**
 * A recorder for the live app and the simulator. It never reads a clock: every event carries its own time, so the
 * same events always give the same numbers. Events may arrive out of order; they are scored by time.
 */
export function createTurnMetricsRecorder(
  options: { maxEvents?: number } = {},
): TurnMetricsRecorder {
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? DEFAULT_RECORDER_EVENTS));
  let events: TraceEvent[] = [];
  let dropped = 0;
  return {
    record(event) {
      if (!Number.isFinite(event.t) || event.t < 0)
        throw new RangeError(`turn metrics event needs a finite time of 0 or more, got ${event.t}`);
      events.push({ ...event });
      if (events.length > maxEvents) {
        dropped += events.length - maxEvents;
        events = events.slice(events.length - maxEvents);
      }
    },
    summary() {
      const score = scoreTrace(events);
      const run = aggregateRun([score]);
      return { events: events.length, dropped, score, run, gates: judgeGates(run) };
    },
  };
}
