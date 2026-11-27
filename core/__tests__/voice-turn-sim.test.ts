/**
 * The turn simulator and its scorers. Part one is pure: the scorers read hand-written traces. Part two plays scripted
 * scenarios on a fake 80 ms frame clock into the real Auto mode controller (no microphone, speaker or timer) and pins
 * what the controller does TODAY, exactly. Where today's behaviour is a known defect, the test pins the number that
 * exposes it and names the audit or plan id in its title, so the packet that fixes it flips that one assertion.
 * Each scenario prints its metrics as one JSON line (console.info) so a baseline can be pasted from a run.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  aggregateRun,
  BACKCHANNEL_FALSE_STOP_MAX_RATE,
  BARGE_STOP_WINDOW_MS,
  CONTINUATION_WINDOW_MS,
  createTurnMetricsRecorder,
  FALSE_CUT_MAX_RATE,
  FRAME_MS,
  INTERRUPT_STOP_MIN_RATE,
  INTERRUPT_STOP_WITHIN_MS,
  judgeGates,
  judgeRun,
  MID_SENTENCE_TAKEOVER_MAX_RATE,
  percentile,
  rateStat,
  scoreTrace,
  spreadStat,
  TTFA_P50_MAX_MS,
  TTFA_P90_MAX_MS,
  VOICE_TURN_GATES,
  wilsonInterval,
  type TraceEvent,
} from "../../src/lib/friday/voice-engine/turn-metrics";
import {
  brainEv,
  ctl,
  ear,
  fin,
  quiet,
  runScenario,
  script,
  truth,
  ttsEv,
  vad,
  type Scenario,
  type SimResult,
} from "./helpers/voice-turn-sim";
import { REPLY, SCENARIOS } from "./helpers/voice-turn-scenarios";

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) =>
  (await import("./helpers/voice-turn-sim")).simLibraryMock(await importOriginal()),
);

// ---------------------------------------------------------------------------------------------------------------
// Part one: the pure scorers on hand-written traces
// ---------------------------------------------------------------------------------------------------------------

const frames = (from: number, to: number, p = 0.9): TraceEvent[] => {
  const out: TraceEvent[] = [];
  for (let t = from; t < to; t += FRAME_MS) out.push({ t, k: "vad", p });
  return out;
};
const earT = (
  t: number,
  event: "start" | "partial" | "eager" | "resumed" | "end" | "revised",
  turnId: string,
  text = "",
): TraceEvent => ({ t, k: "ear", event, turnId, text });
const tts = (
  t: number,
  ev: "first-audio" | "clause-end" | "drained" | "failed",
  turnId?: string,
): TraceEvent => ({
  t,
  k: "tts",
  ev,
  utteranceId: "u",
  playedMs: 0,
  ...(turnId ? { turnId } : {}),
});

describe("percentile", () => {
  it("is null for no values", () => expect(percentile([], 0.5)).toBeNull());
  it("is the value itself for one value", () => expect(percentile([7], 0.9)).toBe(7));
  it("takes the nearest rank, not an average", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
  it("does not depend on the order of the input", () => {
    expect(percentile([9, 1, 5, 3, 7], 0.5)).toBe(5);
  });
  it("treats q=0 as the smallest and q=1 as the largest", () => {
    expect(percentile([4, 2, 8], 0)).toBe(2);
    expect(percentile([4, 2, 8], 1)).toBe(8);
  });
  it("does not change the list it was given", () => {
    const list = [3, 1, 2];
    percentile(list, 0.5);
    expect(list).toEqual([3, 1, 2]);
  });
});

describe("wilsonInterval and rateStat", () => {
  it("is the whole range with no samples", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
  it("0 of 10 reaches 0 and stays well under 0.3", () => {
    const w = wilsonInterval(0, 10);
    expect(w.low).toBe(0);
    expect(w.high).toBeGreaterThan(0.25);
    expect(w.high).toBeLessThan(0.3);
  });
  it("10 of 10 reaches 1 and stays well over 0.7", () => {
    const w = wilsonInterval(10, 10);
    expect(w.high).toBe(1);
    expect(w.low).toBeGreaterThan(0.7);
  });
  it("5 of 10 is symmetric around one half", () => {
    const w = wilsonInterval(5, 10);
    expect(w.low).toBeCloseTo(0.2366, 3);
    expect(w.high).toBeCloseTo(0.7634, 3);
  });
  it("is narrower with more samples at the same rate", () => {
    const small = wilsonInterval(5, 10);
    const big = wilsonInterval(500, 1000);
    expect(big.high - big.low).toBeLessThan(small.high - small.low);
  });
  it("clamps a count above n instead of leaving the range", () => {
    const w = wilsonInterval(12, 10);
    expect(w.high).toBeLessThanOrEqual(1);
    expect(w.low).toBeGreaterThanOrEqual(0);
  });
  it("rateStat keeps the counts, rounds the rate and has a null rate with no samples", () => {
    expect(rateStat(1, 3)).toMatchObject({ k: 1, n: 3, rate: 0.3333 });
    expect(rateStat(0, 0).rate).toBeNull();
  });
  it("spreadStat gives n, p50 and p90", () => {
    expect(spreadStat([100, 200, 300, 400, 500])).toEqual({ n: 5, p50: 300, p90: 500 });
    expect(spreadStat([])).toEqual({ n: 0, p50: null, p90: null });
  });
});

describe("scoreTrace on hand-written traces", () => {
  const clean = (): TraceEvent[] => [
    earT(0, "start", "t1"),
    ...frames(0, 800),
    ...frames(800, 1600, 0.05),
    earT(1360, "eager", "t1", "open the calculator"),
    earT(1440, "end", "t1", "open the calculator"),
    { t: 1520, k: "final", text: "Open the calculator." },
    { t: 1520, k: "dispatch", text: "open the calculator" },
    { t: 1680, k: "brain", ev: "first-token", runId: "r1", lane: "quick" },
    tts(2000, "first-audio"),
  ];

  it("measures first sound from the end of the owner's voice, not from the ear's decision", () => {
    const [turn] = scoreTrace(clean()).turns;
    expect(turn?.speechEndAt).toBe(800);
    expect(turn?.ttfaMs).toBe(1200);
    expect(turn?.eotWaitMs).toBe(640);
  });

  it("splits the wait into listen, endpoint, final, brain and first sound", () => {
    const [turn] = scoreTrace(clean()).turns;
    expect(turn?.stages).toEqual({
      listenMs: 800,
      endpointMs: 560,
      finalMs: 80,
      brainMs: 160,
      firstSoundMs: 320,
    });
  });

  it("has no first sound number when nothing was heard at the output", () => {
    const trace = clean().filter((e) => !(e.k === "tts"));
    const [turn] = scoreTrace(trace).turns;
    expect(turn?.ttfaMs).toBeNull();
    expect(turn?.stages.firstSoundMs).toBeNull();
  });

  it("scores the order of the trace, not the order it was written in", () => {
    const shuffled = [...clean()].reverse();
    expect(scoreTrace(shuffled).turns[0]?.ttfaMs).toBe(1200);
  });

  it("calls an eager end a hit when the words match and nothing resumed", () => {
    expect(scoreTrace(clean()).turns[0]?.draftHit).toBe(true);
  });

  it("calls an eager end a miss when the final words differ", () => {
    const trace = clean().map((e) =>
      e.k === "final" ? { ...e, text: "Open the calendar" } : e,
    ) as TraceEvent[];
    expect(scoreTrace(trace).turns[0]?.draftHit).toBe(false);
  });

  it("calls an eager end a miss when the owner resumed after it", () => {
    const trace = [...clean(), earT(1480, "resumed", "t1")];
    const [turn] = scoreTrace(trace).turns;
    expect(turn?.draftHit).toBe(false);
    expect(turn?.resumedCount).toBe(1);
  });

  it("has no draft verdict without an eager end", () => {
    const trace = clean().filter((e) => !(e.k === "ear" && e.event === "eager"));
    const [turn] = scoreTrace(trace).turns;
    expect(turn?.draftHit).toBeNull();
    expect(turn?.eagerResumedRatio).toBeNull();
  });

  it("gives the resumed share of the eager ends of a turn", () => {
    const trace = [...clean(), earT(1100, "eager", "t1", "open"), earT(1200, "resumed", "t1")];
    expect(scoreTrace(trace).turns[0]?.eagerResumedRatio).toBe(0.5);
  });

  it("times a real interruption from the voice to the output stopping", () => {
    const trace: TraceEvent[] = [
      tts(0, "first-audio"),
      earT(1000, "start", "t2"),
      { t: 1000, k: "truth", kind: "interruption" },
      ...frames(1000, 1600),
      { t: 1240, k: "stop" },
    ];
    const score = scoreTrace(trace);
    expect(score.barges).toHaveLength(1);
    expect(score.barges[0]).toMatchObject({
      silenceMs: 240,
      stoppedInTime: true,
      falseStop: false,
    });
    expect(score.turns[0]?.bargeToSilenceMs).toBe(240);
  });

  it("does not count a stop later than the limit as in time", () => {
    const trace: TraceEvent[] = [
      tts(0, "first-audio"),
      { t: 1000, k: "truth", kind: "interruption" },
      ...frames(1000, 1600),
      { t: 1000 + INTERRUPT_STOP_WITHIN_MS + FRAME_MS, k: "stop" },
    ];
    expect(scoreTrace(trace).barges[0]?.stoppedInTime).toBe(false);
  });

  it("an answer to her question counts as a real barge, a stop word too", () => {
    for (const kind of ["answer", "stop-word"] as const) {
      const trace: TraceEvent[] = [
        tts(0, "first-audio"),
        { t: 1000, k: "truth", kind },
        ...frames(1000, 1200),
        { t: 1080, k: "stop" },
      ];
      expect(scoreTrace(trace).barges[0]?.stoppedInTime).toBe(true);
    }
  });

  it("a nod that only ducks her is no false stop; a nod that stops her is, and the turn says so", () => {
    const base: TraceEvent[] = [
      tts(0, "first-audio"),
      earT(1000, "start", "t2"),
      { t: 1000, k: "truth", kind: "backchannel" },
      ...frames(1000, 1160),
      { t: 1000, k: "duck", on: true },
    ];
    const ducked = scoreTrace(base);
    expect(ducked.barges[0]).toMatchObject({ ducked: true, stoppedAt: null, falseStop: false });
    const stopped = scoreTrace([...base, { t: 1160, k: "stop" }]);
    expect(stopped.barges[0]?.falseStop).toBe(true);
    expect(stopped.turns[0]?.falseInterrupt).toBe(true);
  });

  it("voice while she is silent is not a barge-in", () => {
    const score = scoreTrace([...frames(0, 400), { t: 0, k: "truth", kind: "noise" }]);
    expect(score.barges).toEqual([]);
  });

  it("a stop beyond the window after the voice began is not tied to it", () => {
    const trace: TraceEvent[] = [
      tts(0, "first-audio"),
      { t: 1000, k: "truth", kind: "interruption" },
      ...frames(1000, 1160),
      { t: 1000 + BARGE_STOP_WINDOW_MS + FRAME_MS, k: "stop" },
    ];
    expect(scoreTrace(trace).barges[0]?.stoppedAt).toBeNull();
  });

  it("flags a false cut when she starts while the owner's voice is on", () => {
    const trace: TraceEvent[] = [
      earT(0, "start", "t1"),
      ...frames(0, 1200),
      { t: 560, k: "say", text: "Which one?", turnId: "t1" },
    ];
    expect(scoreTrace(trace).turns[0]?.falseCut).toBe(true);
    const later = trace.map((e) => (e.k === "say" ? { ...e, t: 1600 } : e)) as TraceEvent[];
    expect(scoreTrace(later).turns[0]?.falseCut).toBe(false);
  });

  it("flags a premature end only when the owner went on inside the window", () => {
    const base: TraceEvent[] = [
      earT(0, "start", "t1"),
      ...frames(0, 800),
      earT(1360, "end", "t1", "open the"),
    ];
    const inside = scoreTrace([...base, { t: 1360 + FRAME_MS, k: "truth", kind: "continuation" }]);
    expect(inside.turns[0]?.prematureEnd).toBe(true);
    const outside = scoreTrace([
      ...base,
      { t: 1360 + CONTINUATION_WINDOW_MS + FRAME_MS, k: "truth", kind: "continuation" },
    ]);
    expect(outside.turns[0]?.prematureEnd).toBe(false);
  });

  it("a mid-sentence pause is a takeover when the turn ended, was sent or answered before the voice came back", () => {
    const pause: TraceEvent[] = [
      ...frames(0, 800),
      { t: 800, k: "truth", kind: "pause" },
      ...frames(1840, 2400),
    ];
    expect(scoreTrace(pause).pauses).toEqual([{ at: 800, resumedAt: 1840, takeover: false }]);
    for (const taken of [
      earT(1360, "end", "t1", "open the"),
      { t: 1440, k: "dispatch", text: "open the" } as TraceEvent,
      { t: 1500, k: "say", text: "Which one?" } as TraceEvent,
    ]) {
      expect(scoreTrace([...pause, taken]).pauses[0]?.takeover).toBe(true);
    }
  });

  it("a pause after which the voice never returns is judged inside its window", () => {
    const trace: TraceEvent[] = [{ t: 800, k: "truth", kind: "pause" }];
    expect(scoreTrace(trace).pauses[0]).toEqual({ at: 800, resumedAt: null, takeover: false });
  });

  it("times mute, pause and stop-all to the first stop", () => {
    const trace: TraceEvent[] = [
      { t: 1000, k: "control", ev: "mute" },
      { t: 1000, k: "stop" },
      { t: 2000, k: "control", ev: "stop-all" },
      { t: 2160, k: "stop" },
      { t: 3000, k: "control", ev: "wake" },
    ];
    expect(scoreTrace(trace).controls).toEqual([
      { ev: "mute", at: 1000, silenceMs: 0 },
      { ev: "stop-all", at: 2000, silenceMs: 160 },
    ]);
  });

  it("counts the voices that failed before the one that played", () => {
    const trace: TraceEvent[] = [
      earT(0, "start", "t1"),
      tts(100, "failed", "t1"),
      tts(200, "failed", "t1"),
      tts(300, "first-audio", "t1"),
    ];
    expect(scoreTrace(trace).turns[0]?.fallbackRung).toBe(2);
  });

  it("ties a reply to the turn that caused it, even after the next turn began", () => {
    const trace: TraceEvent[] = [
      earT(0, "start", "t1"),
      ...frames(0, 400),
      earT(1000, "start", "t2"),
      tts(1600, "first-audio", "t1"),
    ];
    const [one, two] = scoreTrace(trace).turns;
    expect(one?.ttfaMs).toBe(1200);
    expect(two?.ttfaMs).toBeNull();
  });

  it("carries the lane and a refusal the Brain reported", () => {
    const trace: TraceEvent[] = [
      earT(0, "start", "t1"),
      { t: 100, k: "brain", ev: "lane", runId: "r", lane: "full" },
      { t: 200, k: "brain", ev: "refused", runId: "r", reason: "busy" },
    ];
    const [turn] = scoreTrace(trace).turns;
    expect(turn?.lane).toBe("full");
    expect(turn?.refused).toBe(true);
  });
});

describe("aggregateRun and judgeRun", () => {
  const turnTrace = (id: string, at: number, firstAudio: number): TraceEvent[] => [
    earT(at, "start", id),
    ...frames(at, at + 400),
    earT(at + 960, "end", id, "x"),
    tts(firstAudio, "first-audio", id),
  ];

  it("exports the proposed thresholds under their names", () => {
    expect([TTFA_P50_MAX_MS, TTFA_P90_MAX_MS, FALSE_CUT_MAX_RATE]).toEqual([1200, 2500, 0.03]);
    expect([MID_SENTENCE_TAKEOVER_MAX_RATE, INTERRUPT_STOP_MIN_RATE]).toEqual([0.15, 0.95]);
    expect([INTERRUPT_STOP_WITHIN_MS, BACKCHANNEL_FALSE_STOP_MAX_RATE]).toEqual([300, 0.02]);
  });

  it("takes p50 and p90 of first sound over every turn of every trace", () => {
    const a = scoreTrace(turnTrace("a", 0, 1000));
    const b = scoreTrace(turnTrace("b", 0, 2000));
    const c = scoreTrace(turnTrace("c", 0, 3000));
    const run = aggregateRun([a, b, c]);
    expect(run.turns).toBe(3);
    expect(run.ttfa).toEqual({ n: 3, p50: 1600, p90: 2600 });
  });

  it("passes a run inside every threshold and fails one that is not", () => {
    const fast = judgeRun(aggregateRun([scoreTrace(turnTrace("a", 0, 1000))]));
    expect(fast.filter((v) => v.pass === false)).toEqual([]);
    expect(fast.find((v) => v.name === "ttfa p50 ms")?.pass).toBe(true);
    const slow = judgeRun(aggregateRun([scoreTrace(turnTrace("a", 0, 3600))]));
    expect(slow.find((v) => v.name === "ttfa p50 ms")?.pass).toBe(false);
    expect(slow.find((v) => v.name === "ttfa p90 ms")?.pass).toBe(false);
  });

  it("a threshold with no samples is null, never a pass", () => {
    const verdicts = judgeRun(aggregateRun([]));
    expect(verdicts.every((v) => v.pass === null)).toBe(true);
  });

  it("rates the interrupts that stopped in time and the nods that stopped her", () => {
    const barge = (
      kind: "interruption" | "backchannel",
      stopAfter: number | null,
    ): TraceEvent[] => [
      tts(0, "first-audio"),
      { t: 1000, k: "truth", kind },
      ...frames(1000, 1160),
      ...(stopAfter === null ? [] : [{ t: 1000 + stopAfter, k: "stop" } as TraceEvent]),
      { t: 1200, k: "tts", ev: "drained", utteranceId: "u", playedMs: 0 },
    ];
    const run = aggregateRun([
      scoreTrace(barge("interruption", 160)),
      scoreTrace(barge("interruption", 640)),
      scoreTrace(barge("backchannel", null)),
      scoreTrace(barge("backchannel", 80)),
    ]);
    expect(run.interruptStopped).toMatchObject({ k: 1, n: 2, rate: 0.5 });
    expect(run.backchannelFalseStop).toMatchObject({ k: 1, n: 2, rate: 0.5 });
    expect(run.bargeToSilence.n).toBe(3);
    const named = judgeRun(run);
    expect(named.find((v) => v.name === "interrupt stopped in time rate")?.pass).toBe(false);
    expect(named.find((v) => v.name === "backchannel false stop rate")?.pass).toBe(false);
  });

  it("counts turns by how many voices failed first", () => {
    const run = aggregateRun([
      scoreTrace([earT(0, "start", "a"), tts(10, "first-audio", "a")]),
      scoreTrace([earT(0, "start", "b"), tts(10, "failed", "b"), tts(20, "first-audio", "b")]),
    ]);
    expect(run.fallbackRungs).toEqual({ "0": 1, "1": 1 });
  });
});

describe("V3-E1: recorder, new metrics and gates (pure)", () => {
  /** A barge-in trace: she speaks from 0, the owner's voice begins at 1000, she stops `stopAfter` later (null: never). */
  const bargeTrace = (
    kind: "interruption" | "backchannel" | "stop-word",
    stopAfter: number | null,
  ): TraceEvent[] => [
    tts(0, "first-audio"),
    { t: 1000, k: "truth", kind },
    ...frames(1000, 1160),
    ...frames(1160, 1240, 0.05),
    ...(stopAfter === null ? [] : [{ t: 1000 + stopAfter, k: "stop" } as TraceEvent]),
    { t: 1400, k: "tts", ev: "drained", utteranceId: "u", playedMs: 0 },
  ];

  it("exports the gates under their names with the planned numbers", () => {
    expect(VOICE_TURN_GATES).toEqual({
      falseInterrupt: 0.1,
      falseCut: 0.03,
      cutOff: 0.05,
      bargeToSilenceP95Ms: 300,
      ttfaP95Ms: 1500,
      commandLaneP95Ms: 50,
    });
    expect(Object.isFrozen(VOICE_TURN_GATES)).toBe(true);
  });

  it("the recorder scores what it was given exactly as scoreTrace scores the same list", () => {
    const trace = [
      ...bargeTrace("interruption", 160),
      ...bargeTrace("backchannel", null).map((e) => ({ ...e, t: e.t + 5000 })),
    ];
    const rec = createTurnMetricsRecorder();
    for (const e of trace) rec.record(e);
    const summary = rec.summary();
    expect(summary.score).toEqual(scoreTrace(trace));
    expect(summary.run).toEqual(aggregateRun([scoreTrace(trace)]));
    expect(summary.events).toBe(trace.length);
    expect(summary.dropped).toBe(0);
  });

  it("summary does not change the recorder: it can be read twice and recording goes on", () => {
    const rec = createTurnMetricsRecorder();
    for (const e of bargeTrace("interruption", 160)) rec.record(e);
    const a = rec.summary();
    const b = rec.summary();
    expect(b).toEqual(a);
    expect(a.run.interruptStopped.n).toBe(1);
    for (const e of bargeTrace("interruption", 80).map((x) => ({ ...x, t: x.t + 9000 })))
      rec.record(e);
    expect(rec.summary().run.interruptStopped.n).toBe(2);
    expect(a.run.interruptStopped.n).toBe(1);
  });

  it("an event is copied on record: changing it afterwards does not change the score", () => {
    const rec = createTurnMetricsRecorder();
    const events = bargeTrace("interruption", 160);
    for (const e of events) rec.record(e);
    const before = rec.summary().run.takeoverLatency;
    for (const e of events) if (e.k === "stop") e.t = 99_000;
    expect(rec.summary().run.takeoverLatency).toEqual(before);
  });

  it("takes events out of order and refuses an event with no usable time", () => {
    const rec = createTurnMetricsRecorder();
    for (const e of [...bargeTrace("interruption", 160)].reverse()) rec.record(e);
    expect(rec.summary().run.takeoverLatency).toMatchObject({ n: 1, p50: 160 });
    expect(() => rec.record({ t: Number.NaN, k: "stop" })).toThrow(RangeError);
    expect(() => rec.record({ t: -1, k: "stop" })).toThrow(RangeError);
    expect(() => rec.record({ t: Number.POSITIVE_INFINITY, k: "stop" })).toThrow(RangeError);
    expect(rec.summary().events).toBe(bargeTrace("interruption", 160).length);
  });

  it("keeps at most maxEvents, drops the oldest first and says how many it dropped", () => {
    const rec = createTurnMetricsRecorder({ maxEvents: 4 });
    for (let i = 0; i < 10; i += 1) rec.record({ t: i * FRAME_MS, k: "vad", p: 0.9 });
    const summary = rec.summary();
    expect(summary.events).toBe(4);
    expect(summary.dropped).toBe(6);
    expect(createTurnMetricsRecorder({ maxEvents: 0 }).summary().events).toBe(0);
  });

  it("when full it forgets the oldest events, not the newest: the score is of the latest ones", () => {
    const first = bargeTrace("interruption", 160);
    const later = bargeTrace("interruption", 80).map((e) => ({ ...e, t: e.t + 9000 }));
    const rec = createTurnMetricsRecorder({ maxEvents: later.length });
    for (const e of [...first, ...later]) rec.record(e);
    const summary = rec.summary();
    expect(summary.dropped).toBe(first.length);
    expect(summary.run.takeoverLatency).toEqual({ n: 1, p50: 80, p90: 80 });
  });

  it("is empty-safe: no events means no samples and every gate is null, never a pass", () => {
    const summary = createTurnMetricsRecorder().summary();
    expect(summary.run.turns).toBe(0);
    expect(summary.gates).toHaveLength(6);
    expect(summary.gates.every((g) => g.pass === null)).toBe(true);
    expect(summary.run.pauseTOR.rate).toBeNull();
    expect(summary.run.cutOff.rate).toBeNull();
    expect(summary.run.takeoverLatency).toEqual({ n: 0, p50: null, p90: null });
    expect(summary.run.ttfaP95Ms).toBeNull();
  });

  it("takeoverLatency is the voice-to-stop time of real interruptions only, backchannel stops are not in it", () => {
    const run = aggregateRun([
      scoreTrace(bargeTrace("interruption", 160)),
      scoreTrace(bargeTrace("stop-word", 480)),
      scoreTrace(bargeTrace("interruption", null)),
      scoreTrace(bargeTrace("backchannel", 80)),
    ]);
    expect(run.takeoverLatency).toEqual({ n: 2, p50: 160, p90: 480 });
    expect(run.bargeToSilence.n).toBe(3);
    expect(run.backchannelFalseStop).toMatchObject({ k: 1, n: 1 });
  });

  it("bargeToSilenceP95Ms is the nearest-rank 95th percentile over every stop", () => {
    const stops = [80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 400];
    const run = aggregateRun(stops.map((ms) => scoreTrace(bargeTrace("interruption", ms))));
    expect(run.bargeToSilenceP95Ms).toBe(80);
    const run2 = aggregateRun(
      [...stops, 400].map((ms) => scoreTrace(bargeTrace("interruption", ms))),
    );
    expect(run2.bargeToSilenceP95Ms).toBe(400);
  });

  it("pauseTOR is the share of marked pauses the engine took over; cutOff is the share of turns closed too early", () => {
    const pauseTurn = (id: string, takeover: boolean): TraceEvent[] => [
      earT(0, "start", id),
      { t: 0, k: "truth", kind: "command" },
      ...frames(0, 400),
      { t: 400, k: "truth", kind: "pause" },
      ...(takeover
        ? [earT(800, "end", id, "x"), { t: 1200, k: "truth", kind: "continuation" } as TraceEvent]
        : []),
      ...frames(1600, 1920),
      earT(2400, "end", id, "x y"),
    ];
    const run = aggregateRun([
      scoreTrace(pauseTurn("a", true)),
      scoreTrace(pauseTurn("b", false)),
      scoreTrace(pauseTurn("c", false)),
      scoreTrace(pauseTurn("d", false)),
    ]);
    expect(run.pauseTOR).toMatchObject({ k: 1, n: 4, rate: 0.25 });
    expect(run.pauseTOR).toEqual(run.midSentenceTakeover);
    expect(run.cutOff).toMatchObject({ k: 1, n: 4, rate: 0.25 });
  });

  it("commandLaneMs is the time from the hand-over to the command lane, null for any other lane", () => {
    const laneTurn = (lane: "command" | "quick", laneAt: number): TraceEvent[] => [
      earT(0, "start", "a"),
      ...frames(0, 400),
      earT(560, "end", "a", "x"),
      { t: 640, k: "final", text: "x", turnId: "a" },
      { t: 640, k: "dispatch", text: "x", turnId: "a" },
      { t: laneAt, k: "brain", ev: "lane", runId: "r", turnId: "a", lane },
    ];
    const fast = scoreTrace(laneTurn("command", 640));
    expect(fast.turns[0]?.commandLaneMs).toBe(0);
    const slow = scoreTrace(laneTurn("command", 880));
    expect(slow.turns[0]?.commandLaneMs).toBe(240);
    expect(scoreTrace(laneTurn("quick", 640)).turns[0]?.commandLaneMs).toBeNull();
    const run = aggregateRun([fast, slow, scoreTrace(laneTurn("quick", 700))]);
    expect(run.commandLaneP95Ms).toBe(240);
  });

  it("judgeGates: rates are strictly below the limit, milliseconds are at most the limit (command lane strictly below)", () => {
    const at = (name: string, run: ReturnType<typeof aggregateRun>) =>
      judgeGates(run).find((g) => g.name === name);
    const base = aggregateRun([]);
    const withRun = (patch: Partial<typeof base>) => ({ ...base, ...patch });
    expect(at("false interrupt rate", withRun({ falseInterrupt: rateStat(1, 10) }))?.pass).toBe(
      false,
    );
    expect(at("false interrupt rate", withRun({ falseInterrupt: rateStat(1, 11) }))?.pass).toBe(
      true,
    );
    expect(at("false cut rate", withRun({ falseCut: rateStat(3, 100) }))?.pass).toBe(false);
    expect(at("false cut rate", withRun({ falseCut: rateStat(2, 100) }))?.pass).toBe(true);
    expect(at("cut off rate", withRun({ cutOff: rateStat(5, 100) }))?.pass).toBe(false);
    expect(at("cut off rate", withRun({ cutOff: rateStat(4, 100) }))?.pass).toBe(true);
    expect(at("barge to silence p95 ms", withRun({ bargeToSilenceP95Ms: 300 }))?.pass).toBe(true);
    expect(at("barge to silence p95 ms", withRun({ bargeToSilenceP95Ms: 301 }))?.pass).toBe(false);
    expect(at("ttfa p95 ms", withRun({ ttfaP95Ms: 1500 }))?.pass).toBe(true);
    expect(at("ttfa p95 ms", withRun({ ttfaP95Ms: 1501 }))?.pass).toBe(false);
    expect(at("command lane p95 ms", withRun({ commandLaneP95Ms: 49 }))?.pass).toBe(true);
    expect(at("command lane p95 ms", withRun({ commandLaneP95Ms: 50 }))?.pass).toBe(false);
    expect(judgeGates(base).map((g) => g.pass)).toEqual([null, null, null, null, null, null]);
  });

  it("the gate limits in the verdicts are the VOICE_TURN_GATES numbers", () => {
    const limits = Object.fromEntries(judgeGates(aggregateRun([])).map((g) => [g.name, g.limit]));
    expect(limits).toEqual({
      "false interrupt rate": VOICE_TURN_GATES.falseInterrupt,
      "false cut rate": VOICE_TURN_GATES.falseCut,
      "cut off rate": VOICE_TURN_GATES.cutOff,
      "barge to silence p95 ms": VOICE_TURN_GATES.bargeToSilenceP95Ms,
      "ttfa p95 ms": VOICE_TURN_GATES.ttfaP95Ms,
      "command lane p95 ms": VOICE_TURN_GATES.commandLaneP95Ms,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Part two: scripted scenarios on the real controller (the timelines live in helpers/voice-turn-scenarios.ts)
// ---------------------------------------------------------------------------------------------------------------

const played = new Map<string, SimResult>();
async function play(key: keyof typeof SCENARIOS | string): Promise<SimResult> {
  const cached = played.get(key);
  if (cached) return cached;
  const scenario = SCENARIOS[key];
  if (!scenario) throw new Error(`no scenario ${key}`);
  const result = await runScenario(scenario);
  played.set(key, result);
  console.info(
    JSON.stringify({
      scenario: scenario.name,
      turns: result.score.turns,
      barges: result.score.barges,
      pauses: result.score.pauses,
      controls: result.score.controls,
      run: result.run,
    }),
  );
  return result;
}

const events = (r: SimResult, k: TraceEvent["k"]) => r.trace.filter((e) => e.k === k);
const turn = (r: SimResult, i = 0) => {
  const t = r.score.turns[i];
  if (!t) throw new Error(`no turn ${i}`);
  return t;
};

describe("turn simulator: scenarios on the real controller", () => {
  it("a clean command is sent once, answered once, and first sound is 1.2 s after the owner stops", async () => {
    const r = await play("clean");
    expect(r.sent).toEqual(["what is the time"]);
    expect(r.spoken).toEqual(["It is ten past three."]);
    expect(turn(r)).toMatchObject({
      speechEndAt: 1200,
      ttfaMs: 1200,
      eotWaitMs: 560,
      draftHit: null,
      falseCut: false,
      prematureEnd: false,
      fallbackRung: 0,
      lane: "quick",
      stages: { listenMs: 1200, endpointMs: 560, finalMs: 80, brainMs: 160, firstSoundMs: 400 },
    });
    expect(events(r, "duck")).toEqual([]);
    expect(events(r, "stop")).toEqual([]);
    expect(r.cancelled).toBe(0);
  });

  it("a mid-sentence pause is not cut: nothing is sent or said until the sentence is finished", async () => {
    const r = await play("pauseKept");
    expect(r.score.pauses).toEqual([{ at: 800, resumedAt: 1840, takeover: false }]);
    expect(r.sent).toEqual(["open the report from last week"]);
    const dispatch = events(r, "dispatch")[0];
    expect(dispatch?.t).toBe(3280);
    expect(events(r, "say").every((e) => e.t >= 3280)).toBe(true);
    expect(turn(r)).toMatchObject({ prematureEnd: false, falseCut: false, speechEndAt: 2640 });
  });

  it("[P2-E end-of-turn prior] an end at a pause sends the half sentence and she answers over the rest", async () => {
    const r = await play("prematureEnd");
    // Today the controller acts on whatever final the ear sends: the half command goes to the Brain at once.
    expect(r.sent[0]).toBe("open the");
    expect(r.score.pauses[0]).toEqual({ at: 800, resumedAt: 1840, takeover: true });
    expect(turn(r, 0)).toMatchObject({ prematureEnd: true, falseCut: true, ttfaMs: 1200 });
    expect(r.run.midSentenceTakeover.rate).toBe(1);
    const verdict = judgeRun(r.run).find((v) => v.name === "mid-sentence takeover rate");
    expect(verdict?.pass).toBe(false);
  });

  it("[P2-E end-of-turn prior] a trailing 'aur' is sent as a finished command and answered over the owner", async () => {
    const r = await play("trailingAur");
    expect(r.sent).toEqual(["kal ka meeting aur", "dopahar ko rakho"]);
    expect(turn(r, 0)).toMatchObject({ prematureEnd: true, falseCut: true });
    expect(r.run.falseCut.rate).toBe(0.5);
    expect(judgeRun(r.run).find((v) => v.name === "false cut rate")?.pass).toBe(false);
  });

  it("a nod while she speaks only lowers her volume: she keeps speaking and nothing is sent", async () => {
    const r = await play("backchannel");
    expect(r.score.barges).toHaveLength(1);
    expect(r.score.barges[0]).toMatchObject({
      truth: "backchannel",
      ducked: true,
      stoppedAt: null,
      falseStop: false,
    });
    expect(events(r, "duck").map((e) => (e.k === "duck" ? [e.t, e.on] : null))).toEqual([
      [1600, true],
      [2480, false],
    ]);
    expect(events(r, "stop")).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.cancelled).toBe(0);
    expect(r.h.brainStops).toEqual([]);
    expect(r.spoken).toEqual([
      "First I will open the file.",
      "Then I will read the summary. After that I will send it.",
    ]);
    expect(r.run.backchannelFalseStop).toMatchObject({ k: 0, n: 1 });
  });

  it("[P2-F barge latency] a real interruption stops her at its first words, 400 ms after the voice began", async () => {
    const r = await play("interruption");
    expect(r.score.barges[0]).toMatchObject({
      truth: "interruption",
      at: 1600,
      stoppedAt: 2000,
      silenceMs: 400,
      stoppedInTime: false,
    });
    expect(turn(r).bargeToSilenceMs).toBe(400);
    expect(r.sent).toEqual(["wait open the budget sheet instead"]);
    expect(r.h.brainStops).toEqual(["foreground"]);
    // What the owner heard at full volume when the voice began is what the history keeps.
    expect(r.h.truncated).toEqual([["r0", REPLY, 1200]]);
    expect(r.h.d.lastTurn()?.interruptedPlayedMs).toBe(1200);
    expect(judgeRun(r.run).find((v) => v.name === "interrupt stopped in time rate")?.pass).toBe(
      false,
    );
  });

  it("[P2-F noise ducking] a TV burst with no words ducks her for 4.4 s but never stops her", async () => {
    const r = await play("tvNoise");
    expect(r.score.barges[0]).toMatchObject({ truth: "noise", ducked: true, stoppedAt: null });
    expect(events(r, "duck").map((e) => (e.k === "duck" ? [e.t, e.on] : null))).toEqual([
      [1600, true],
      [6000, false],
    ]);
    expect(events(r, "stop")).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.h.brainStops).toEqual([]);
    expect(turn(r)).toMatchObject({ falseInterrupt: false, falseCut: false });
  });

  it("an eager end the owner spoke past is thrown away, and the second one is adopted at the final", async () => {
    const r = await play("eagerResumed");
    expect(r.h.drafts).toEqual({
      started: ["what is the weather", "what is the weather in jaipur tomorrow"],
      discarded: ["draft-1"],
      adopted: ["draft-2"],
    });
    expect(r.sent).toEqual([]); // adopted: the draft is the turn
    expect(r.h.hints[0]).toMatchObject({ eager: true });
    expect(turn(r)).toMatchObject({
      eagerCount: 2,
      resumedCount: 1,
      eagerResumedRatio: 0.5,
      draftHit: true,
      eotWaitMs: 640,
      ttfaMs: 1200,
    });
    expect(turn(r).stages.endpointMs).toBe(560);
    expect(r.run.eagerResumed).toMatchObject({ k: 1, n: 2, rate: 0.5 });
  });

  it("an eager end that was right is adopted: the first sound does not wait for the end event", async () => {
    const r = await play("eagerAdopted");
    expect(r.h.drafts).toEqual({
      started: ["open the calculator"],
      discarded: [],
      adopted: ["draft-1"],
    });
    expect(turn(r)).toMatchObject({ draftHit: true, eagerResumedRatio: 0, eotWaitMs: 880 });
    expect(turn(r).stages.endpointMs).toBe(560);
    expect(turn(r).ttfaMs).toBe(1360);
  });

  it("two turns in a row are scored apart, each with its own first sound", async () => {
    const r = await play("twoQuick");
    expect(r.sent).toEqual(["open the calculator", "and the notepad"]);
    expect(r.score.turns.map((t) => t.ttfaMs)).toEqual([1040, 1040]);
    expect(r.score.turns.map((t) => t.falseCut)).toEqual([false, false]);
    expect(r.score.turns.map((t) => t.text)).toEqual([
      "Friday open the calculator",
      "Friday and the notepad",
    ]);
    expect(r.run.ttfa).toEqual({ n: 2, p50: 1040, p90: 1040 });
  });

  it("[L2 confirmed command keeps its own hints] a spoken yes over her question stops her at the first word and runs the command", async () => {
    const r = await play("confirmation");
    expect(r.spoken).toEqual(["Should I delete all the old invoices?"]);
    expect(r.score.barges[0]).toMatchObject({
      truth: "answer",
      silenceMs: 160,
      stoppedInTime: true,
    });
    expect(r.sent).toEqual(["delete all the old invoices"]);
    // The hints that went with the command are the command's own (no confidence), not those of the "yes" turn.
    expect(r.h.hints[0]?.confidence).toBeNull();
    expect(r.h.d.lastTurn()?.text).toBe("yes");
    expect(r.h.d.state.pending).toBeNull();
  });

  it("mute during speech silences the output in the same frame and says nothing more", async () => {
    const r = await play("mute");
    expect(r.score.controls).toEqual([{ ev: "mute", at: 2000, silenceMs: 0 }]);
    expect(r.h.d.state.muted).toBe(true);
    expect(r.cancelled).toBe(1);
    expect(r.h.brainStops).toEqual(["foreground"]);
    expect(events(r, "say").every((e) => e.t < 2000)).toBe(true);
  });

  it("stop everything silences the output in the same frame, halts the Brain and drops the next line", async () => {
    const r = await play("stopAll");
    expect(r.score.controls).toEqual([{ ev: "stop-all", at: 2000, silenceMs: 0 }]);
    expect(r.h.brainStops).toContain("all");
    expect(r.h.d.state.paused).toBe(true);
    expect(r.sent).toEqual([]);
    expect(events(r, "dispatch")).toEqual([]);
  });

  it("[L7 romanised Hinglish] a Hindi line in Latin letters that the recogniser calls English is read as hi-en", async () => {
    const r = await play("hinglish");
    expect(r.sent).toEqual(["kal subah ke liye alarm laga do"]);
    // The words decide, not the ear's language tag: the lexicon makes it hi-en (the L7 defect is closed).
    expect(r.h.hints[0]?.lang).toBe("hi-en");
    expect(turn(r).ttfaMs).toBe(1280);
  });

  it("a voice that failed twice before it played shows as fallback rung 2 and a long first sound", async () => {
    const r = await play("fallback");
    expect(turn(r)).toMatchObject({ fallbackRung: 2, ttfaMs: 2000 });
    expect(turn(r).stages.firstSoundMs).toBe(1200);
    expect(r.run.fallbackRungs).toEqual({ "2": 1 });
  });
});

describe("turn simulator: V3-E1 scenarios on the real controller", () => {
  const dots = (r: SimResult) =>
    events(r, "duck").map((e) => (e.k === "duck" ? [e.t, e.on] : null));

  it("a 1.5 s Hinglish pause after 'aur' is waited out: one command goes out, with the whole sentence", async () => {
    const r = await play("hinglishPause");
    expect(r.sent).toEqual(["mujhe ek file banani hai aur report wali"]);
    expect(r.spoken).toEqual(["Theek hai, file bana rahi hoon."]);
    expect(r.score.pauses).toEqual([{ at: 1520, resumedAt: 3040, takeover: false }]);
    expect(turn(r)).toMatchObject({ prematureEnd: false, falseCut: false, speechEndAt: 3920 });
    expect(events(r, "dispatch")[0]?.t).toBe(4880);
    expect(r.h.hints[0]?.lang).toBe("hi-en");
    expect(r.run.pauseTOR).toMatchObject({ k: 0, n: 1, rate: 0 });
    expect(r.run.cutOff).toMatchObject({ k: 0, n: 1, rate: 0 });
  });

  it("two nods ('haan haan') while she speaks only lower her volume each time: she is never stopped", async () => {
    const r = await play("haanHaan");
    expect(r.score.barges).toHaveLength(2);
    expect(r.score.barges.map((b) => [b.truth, b.ducked, b.stoppedAt, b.falseStop])).toEqual([
      ["backchannel", true, null, false],
      ["backchannel", true, null, false],
    ]);
    expect(dots(r)).toEqual([
      [1600, true],
      [2480, false],
      [3200, true],
      [4700, false],
    ]);
    expect(events(r, "stop")).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.cancelled).toBe(0);
    expect(r.h.brainStops).toEqual([]);
    expect(r.run.backchannelFalseStop).toMatchObject({ k: 0, n: 2, rate: 0 });
    expect(r.run.falseInterrupt).toMatchObject({ k: 0, n: 2, rate: 0 });
    expect(r.run.takeoverLatency.n).toBe(0);
  });

  it("[P2-F noise no words] a TV burst of 0.7 s with no words and no ear turn STOPS her and she repeats herself", async () => {
    const r = await play("tvBurstSilent");
    // Today a voiced burst that outlasts the hold timer is read as an interruption even with no words at all.
    expect(r.score.barges).toHaveLength(1);
    expect(r.score.barges[0]).toMatchObject({
      truth: "noise",
      at: 1600,
      ducked: true,
      stoppedAt: 2200,
      silenceMs: 600,
      falseStop: true,
      takeoverMs: null,
    });
    expect(r.spoken.filter((t) => t.startsWith("Then I will read"))).toHaveLength(2);
    expect(r.sent).toEqual([]);
    expect(r.score.turns).toEqual([]);
    // No turn was opened, yet the false stop is counted: the run-level false interrupt is per barge-in.
    expect(r.run.falseInterrupt).toMatchObject({ k: 1, n: 1, rate: 1 });
    expect(r.run.backchannelFalseStop).toMatchObject({ k: 1, n: 1, rate: 1 });
    expect(judgeGates(r.run).find((g) => g.name === "false interrupt rate")?.pass).toBe(false);
  });

  it("a three-word takeover stops her at the third word, 240 ms after the voice began, and the command goes out", async () => {
    const r = await play("takeover3");
    expect(r.score.barges[0]).toMatchObject({
      truth: "interruption",
      at: 1600,
      stoppedAt: 1840,
      silenceMs: 240,
      takeoverMs: 240,
      stoppedInTime: true,
    });
    expect(r.sent).toEqual(["wait open budget"]);
    expect(r.h.brainStops).toEqual(["foreground"]);
    expect(r.run.takeoverLatency).toEqual({ n: 1, p50: 240, p90: 240 });
    expect(r.run.bargeToSilenceP95Ms).toBe(240);
    expect(turn(r)).toMatchObject({
      bargeToSilenceMs: 240,
      falseInterrupt: false,
      commandLaneMs: 0,
    });
  });

  it("a yes to her question closes fast: sent at the final, the command lane reports in the same frame", async () => {
    const r = await play("yesNoClose");
    expect(r.spoken).toEqual(["Should I delete all the old invoices?", "Deleted."]);
    expect(r.sent).toEqual(["delete all the old invoices"]);
    expect(r.score.barges).toEqual([]);
    expect(r.score.turns).toHaveLength(2);
    expect(turn(r, 1)).toMatchObject({
      speechEndAt: 3840,
      eotWaitMs: 320,
      commandLaneMs: 0,
      falseCut: false,
      prematureEnd: false,
      lane: "command",
    });
    expect(r.run.commandLaneP95Ms).toBe(0);
    expect(r.run.eotWait.p90 ?? Infinity).toBeLessThanOrEqual(560);
  });

  it("a 3.2 s thinking pause in a dictated line is not taken over: one command with the whole line", async () => {
    const r = await play("dictationLongPause");
    expect(r.sent).toEqual(["likho aaj ka din bahut accha tha aur shaam ko baarish hui"]);
    expect(r.spoken).toEqual(["Likh diya."]);
    expect(r.score.pauses).toEqual([{ at: 2000, resumedAt: 5200, takeover: false }]);
    expect(events(r, "dispatch")[0]?.t).toBe(7280);
    expect(turn(r)).toMatchObject({ prematureEnd: false, falseCut: false });
    expect(r.run.pauseTOR).toMatchObject({ k: 0, n: 1 });
    expect(r.run.cutOff).toMatchObject({ k: 0, n: 1 });
  });
});

const BASELINE_15 = [
  "clean",
  "pauseKept",
  "prematureEnd",
  "trailingAur",
  "backchannel",
  "interruption",
  "tvNoise",
  "eagerResumed",
  "eagerAdopted",
  "twoQuick",
  "confirmation",
  "mute",
  "stopAll",
  "hinglish",
  "fallback",
];

describe("turn simulator: the whole set", () => {
  it("scores the baseline against the proposed thresholds and prints it", async () => {
    // The first fifteen scenarios and their pinned baseline stay as they were. One after the other: every scenario
    // owns the fake timers while it plays.
    const results: SimResult[] = [];
    for (const key of BASELINE_15) results.push(await play(key));
    expect(results.length).toBe(15);
    const run = aggregateRun(results.map((r) => r.score));
    const verdicts = judgeRun(run);
    console.info(JSON.stringify({ baseline: run, verdicts }));
    expect(run.turns).toBeGreaterThanOrEqual(12);
    // Today: first sound is inside its limits, and the turn-taking limits are the ones that fail.
    const byName = Object.fromEntries(verdicts.map((v) => [v.name, v.pass]));
    expect(byName["ttfa p50 ms"]).toBe(true);
    expect(byName["ttfa p90 ms"]).toBe(true);
    expect(byName["false cut rate"]).toBe(false);
    expect(byName["mid-sentence takeover rate"]).toBe(false);
    expect(byName["interrupt stopped in time rate"]).toBe(false);
    expect(byName["backchannel false stop rate"]).toBe(true);
  });

  it("scores the V3 gates over the whole set: today's pass and fail, printed", async () => {
    const results: SimResult[] = [];
    for (const key of Object.keys(SCENARIOS)) results.push(await play(key));
    expect(results.length).toBeGreaterThanOrEqual(21);
    const run = aggregateRun(results.map((r) => r.score));
    const gates = judgeGates(run);
    console.info(JSON.stringify({ gates, run }));
    expect(gates.map((g) => g.name)).toEqual([
      "false interrupt rate",
      "false cut rate",
      "cut off rate",
      "barge to silence p95 ms",
      "ttfa p95 ms",
      "command lane p95 ms",
    ]);
    // Every gate has samples in this set: none is null.
    expect(gates.every((g) => g.pass !== null)).toBe(true);
    // Today every gate fails over the set; the packets that fix a defect flip one line each. The first-sound and
    // command-lane numbers come from the scripted brain and voice events (the fallback scenario, the 160 ms hand-over).
    expect(gates.map((g) => [g.name, g.pass, g.value])).toEqual([
      ["false interrupt rate", false, 0.125],
      ["false cut rate", false, 0.08],
      ["cut off rate", false, 0.08],
      ["barge to silence p95 ms", false, 600],
      ["ttfa p95 ms", false, 2000],
      ["command lane p95 ms", false, 160],
    ]);
    expect(run.turns).toBe(25);
  });
});

describe("turn simulator: guards", () => {
  it("refuses an event that is off the 80 ms frame clock", async () => {
    await expect(
      runScenario({ name: "off the grid", script: script(ear(40, "start", "t1")) }),
    ).rejects.toThrow(/frame clock/);
  });

  it("the live recorder fed with a scenario's trace reports what the scorers report for it", async () => {
    for (const key of ["interruption", "hinglishPause", "tvBurstSilent"]) {
      const r = await play(key);
      expect(r.summary.score).toEqual(r.score);
      expect(r.summary.run).toEqual(r.run);
      expect(r.summary.events).toBe(r.trace.length);
      expect(r.summary.dropped).toBe(0);
      expect(r.summary.gates).toEqual(judgeGates(r.run));
    }
  });

  it("plays the same script to the same trace every time", async () => {
    const again = await runScenario(SCENARIOS["clean"] as Scenario);
    const first = await play("clean");
    expect(JSON.stringify(again.trace)).toBe(JSON.stringify(first.trace));
    expect(JSON.stringify(again.score)).toBe(JSON.stringify(first.score));
  });

  it("starts each scenario on a fresh controller: nothing is left over from the one before", async () => {
    const r = await runScenario({ name: "empty", script: script(vad(0, 160)) });
    expect(r.sent).toEqual([]);
    expect(r.spoken).toEqual([]);
    expect(r.trace.filter((e) => e.k !== "vad")).toEqual([]);
  });

  it("mirrors the speech-start branch of the real dictation callback (source pin for the simulator seam)", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../src/lib/friday/assistant-mode.ts"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const start = source.indexOf("onSpeechStart: () => {");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, start + 1800);
    expect(body).toMatch(/if \(this\.speculativeKind === "brain"\) this\.discardEager\(\)/);
    expect(body).toMatch(
      /if \(this\.state\.speaking\) \{\s*if \(this\.gateEnabled\(\)\) this\.beginInterruptCandidate\(\);\s*else \{[\s\S]*?this\.holdForInterruption\(\);/,
    );
  });
});

afterAll(() => {
  played.clear();
});
