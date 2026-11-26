/**
 * Conformance of the pure turn engine against the simulator's scripted timelines. The simulator plays a scenario into
 * the real Auto mode controller on an 80 ms frame clock; here the same kind of script (voice frames, the ear's turn
 * events, brain events, voice output events, controls) is turned into engine inputs by a small adapter that lives in
 * this file, the engine is stepped frame by frame, and what it asks for is written to one trace that the same pure
 * scorers in `turn-metrics.ts` read. No microphone, speaker, timer or network is touched.
 *
 * Adapter rules (the engine decides the end of a turn itself, so the ear's own `end` and the `final` lines are not
 * inputs): a streaming ear gives the words at the last voiced frame, so every scripted turn carries one `partial`
 * there. The engine's commit is traced as the turn's end and as the dispatch. A speech-output event the engine did
 * not accept (a first sound after it took the floor) is dropped from the trace, as the conductor would have stopped
 * that speech. The `asked` control carries a yes/no expectation.
 *
 * The last part runs the real controller on the same voice timeline for the four defects the simulator pins
 * ([P2-E end-of-turn prior], [P2-F barge latency], [P2-F noise ducking]) and shows the engine passes where it fails.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FRAME_MS,
  createTurnEngine,
  step,
  type TurnCommand,
  type TurnEngineConfig,
  type TurnEngineState,
  type TurnInput,
  type TurnRecordV2,
  type TurnState,
} from "../../src/lib/friday/voice-engine/turn-engine";
import {
  aggregateRun,
  INTERRUPT_STOP_WITHIN_MS,
  scoreTrace,
  type TraceEvent,
  type TraceScore,
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
  type ScriptEvent,
  type SimResult,
} from "./helpers/voice-turn-sim";

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) =>
  (await import("./helpers/voice-turn-sim")).simLibraryMock(await importOriginal()),
);

// ---------------------------------------------------------------------------------------------------------------
// The adapter: a scripted timeline in, engine inputs out, one trace for the scorers
// ---------------------------------------------------------------------------------------------------------------

type Timed = { t: number; cmd: TurnCommand };
type FrameLog = { t: number; state: TurnState; commands: TurnCommand[] };
type Run = {
  frames: FrameLog[];
  commands: Timed[];
  records: Array<{ t: number; record: TurnRecordV2 }>;
  trace: TraceEvent[];
  score: TraceScore;
  final: TurnEngineState;
};

function toInput(e: ScriptEvent): TurnInput | null {
  switch (e.k) {
    case "vad":
      return { t: e.t, k: "vad", p: e.p, echoClean: true };
    case "ear":
      return {
        t: e.t,
        k: "ear",
        turn: {
          turnId: e.turnId,
          event: e.event,
          text: e.text ?? "",
          vadP: null,
          speechMs: e.speechMs ?? null,
          ...(e.env ? { env: e.env } : {}),
          ...(e.speaker ? { speaker: e.speaker } : {}),
        },
      };
    case "brain":
      return {
        t: e.t,
        k: "brain",
        ev: e.ev,
        runId: e.runId,
        ...(e.lane ? { lane: e.lane } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
      };
    case "tts":
      return { t: e.t, k: "tts", ev: e.ev, utteranceId: e.utteranceId, playedMs: e.playedMs ?? 0 };
    case "control":
      return {
        t: e.t,
        k: "control",
        ev: e.ev,
        ...(e.ev === "asked" ? { expect: "yesno" as const } : {}),
      };
    case "final":
    case "truth":
      return null;
  }
}

/** The script's own record of what the owner and the world did (not what the engine asked for). */
function inputTrace(e: ScriptEvent): TraceEvent | null {
  switch (e.k) {
    case "vad":
      return { t: e.t, k: "vad", p: e.p };
    case "ear":
      return { t: e.t, k: "ear", event: e.event, turnId: e.turnId, text: e.text ?? "" };
    case "final":
      return { t: e.t, k: "final", text: e.text, ...(e.turnId ? { turnId: e.turnId } : {}) };
    case "brain":
      return {
        t: e.t,
        k: "brain",
        ev: e.ev,
        runId: e.runId,
        ...(e.turnId ? { turnId: e.turnId } : {}),
        ...(e.lane ? { lane: e.lane } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
      };
    case "control":
      return { t: e.t, k: "control", ev: e.ev };
    case "truth":
      return { t: e.t, k: "truth", kind: e.kind };
    case "tts":
      return null;
  }
}

function drive(events: ScriptEvent[], cfg: Partial<TurnEngineConfig> = {}, tailMs = 3000): Run {
  const sorted = script(events);
  for (const e of sorted) {
    if (e.t % FRAME_MS !== 0)
      throw new Error(`event at ${e.t} ms is off the ${FRAME_MS} ms frame clock`);
  }
  let state = createTurnEngine({ handsFree: true, ...cfg });
  const frames: FrameLog[] = [];
  const commands: Timed[] = [];
  const records: Run["records"] = [];
  const trace: TraceEvent[] = [];
  const end = Math.ceil(((sorted.at(-1)?.t ?? 0) + tailMs) / FRAME_MS) * FRAME_MS;
  let next = 0;
  for (let t = 0; t <= end; t += FRAME_MS) {
    const here: ScriptEvent[] = [];
    while (next < sorted.length && (sorted[next]?.t ?? Infinity) === t) {
      const e = sorted[next];
      if (e) here.push(e);
      next += 1;
    }
    if (!here.some((e) => e.k === "vad")) trace.push({ t, k: "vad", p: 0 });
    const inputs: Array<{ e: ScriptEvent | null; input: TurnInput }> = here.map((e) => ({
      e,
      input: toInput(e) ?? { t, k: "tick" },
    }));
    if (inputs.length === 0) inputs.push({ e: null, input: { t, k: "tick" } });
    const cmds: TurnCommand[] = [];
    for (const { e, input } of inputs) {
      const before = state;
      const out = step(state, input);
      state = out.state;
      const traced = e ? inputTrace(e) : null;
      if (traced) trace.push(traced);
      if (e?.k === "tts") {
        const accepted =
          e.ev === "first-audio"
            ? state.state === "speak" && state.utteranceId === e.utteranceId
            : (before.state === "speak" || before.state === "yield") &&
              before.utteranceId === e.utteranceId;
        if (accepted) {
          trace.push({
            t,
            k: "tts",
            ev: e.ev,
            utteranceId: e.utteranceId,
            playedMs: e.playedMs ?? 0,
            ...(e.turnId ? { turnId: e.turnId } : {}),
          });
        }
      }
      for (const cmd of out.commands) {
        cmds.push(cmd);
        commands.push({ t, cmd });
        if (cmd.k === "commit") {
          records.push({ t, record: cmd.record });
          trace.push({
            t,
            k: "ear",
            event: "end",
            turnId: cmd.record.turnId,
            text: cmd.record.text,
          });
          trace.push({ t, k: "dispatch", text: cmd.record.text, turnId: cmd.record.turnId });
        } else if (cmd.k === "stop-speech") trace.push({ t, k: "stop" });
        else if (cmd.k === "duck") trace.push({ t, k: "duck", on: true });
        else if (cmd.k === "resume-speech") trace.push({ t, k: "duck", on: false });
      }
    }
    frames.push({ t, state: state.state, commands: cmds });
  }
  return { frames, commands, records, trace, score: scoreTrace(trace), final: state };
}

// ---------------------------------------------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------------------------------------------

/** The owner says `text` between `from` and `to`; the ear has the words at the last voiced frame. */
const heard = (
  id: string,
  text: string,
  from: number,
  to: number,
  kind: "command" | "answer" = "command",
): ScriptEvent[] =>
  script(
    vad(from, to),
    ear(from, "start", id),
    truth(from, kind),
    ear(to - FRAME_MS, "partial", id, text),
  );

const REPLY =
  "First I will open the file. Then I will read the summary. After that I will send it.";

/**
 * She is mid-answer: an owner turn `t0` is committed at 720 ms, her reply starts at 2000 ms and plays to 8800 ms.
 * (The simulator's own `herAnswer` has no owner turn before it; the engine needs one to be in the speak state.)
 */
const speakingLead = (wake = false): ScriptEvent[] =>
  script(
    wake ? ctl(0, "wake") : [],
    heard("t0", "Friday summary padho", 0, 320),
    brainEv(1600, "first-token", "r0", { lane: "full" }),
    brainEv(1680, "done", "r0", { text: REPLY }),
    ttsEv(2000, "first-audio", "u0"),
    ttsEv(8800, "drained", "u0", { playedMs: 6800 }),
  );

const kindsOf = (cmds: Timed[]) => cmds.map((c) => c.cmd.k);
const commitsOf = (r: Run) => r.records.map((x) => x.record.text);
const stopsOf = (r: Run) => r.commands.filter((c) => c.cmd.k === "stop-speech");
const between = (r: Run, from: number, to: number) =>
  r.commands.filter((c) => c.t > from && c.t < to);
const BARGE_HOOK = (p: number): "takeover" | "ignore" => (p >= 0.8 ? "takeover" : "ignore");

/** Milliseconds the output was ducked in a trace (a duck that never ends runs to the last event). */
function duckedMs(trace: readonly TraceEvent[]): number {
  let on: number | null = null;
  let total = 0;
  let lastT = 0;
  for (const e of trace) {
    lastT = e.t;
    if (e.k !== "duck") continue;
    if (e.on && on === null) on = e.t;
    if (!e.on && on !== null) {
      total += e.t - on;
      on = null;
    }
  }
  return on === null ? total : total + (lastT - on);
}

// ---------------------------------------------------------------------------------------------------------------
// Conformance: one scenario per behaviour
// ---------------------------------------------------------------------------------------------------------------

describe("turn engine on simulator timelines: kill switches", () => {
  it("stop everything during speech asks the speech to stop in the same frame, then nothing until a new voice event", () => {
    const r = drive(
      script(
        speakingLead(),
        ctl(3600, "stop-all"),
        heard("t2", "Friday open the calculator", 5600, 6400),
      ),
      { handsFree: true },
    );
    const frame = r.frames.find((f) => f.t === 3600);
    expect(frame?.commands.map((c) => c.k)).toEqual(["draft-cancel", "stop-speech"]);
    expect(stopsOf(r)).toHaveLength(1);
    expect(stopsOf(r)[0]).toMatchObject({
      t: 3600,
      cmd: { k: "stop-speech", reason: "stop-all", resumable: false },
    });
    expect(r.score.controls).toEqual([{ ev: "stop-all", at: 3600, silenceMs: 0 }]);
    // Quiet time, then her old utterance draining at 8800 ms: no command of any kind until the voice at 5600.
    expect(between(r, 3600, 5600)).toEqual([]);
    expect(r.frames.filter((f) => f.t > 3600 && f.t < 5600).every((f) => f.state === "idle")).toBe(
      true,
    );
    // A new voice event opens a fresh turn and that turn is heard.
    expect(commitsOf(r)).toEqual(["Friday summary padho", "Friday open the calculator"]);
  });

  it("with hands-free off a stop-all asks for the wake word and the next line is never committed", () => {
    const r = drive(
      script(
        speakingLead(true),
        ctl(3600, "stop-all"),
        heard("t2", "Friday open the calculator", 5600, 6400),
      ),
      { handsFree: false },
    );
    expect(r.frames.find((f) => f.t === 3600)?.commands.map((c) => c.k)).toEqual([
      "draft-cancel",
      "stop-speech",
      "require-wake",
    ]);
    expect(between(r, 3600, 5600)).toEqual([]);
    expect(commitsOf(r)).toEqual(["Friday summary padho"]);
    expect(r.commands.filter((c) => c.t >= 5600).map((c) => c.cmd.k)).toEqual(["require-wake"]);
  });

  it("mute during speech silences her at once; voice without the wake word never opens a listen", () => {
    const r = drive(
      script(
        speakingLead(true),
        ctl(3600, "mute"),
        heard("t2", "Friday open the calculator", 5600, 6400),
      ),
      { handsFree: false },
    );
    expect(r.score.controls).toEqual([{ ev: "mute", at: 3600, silenceMs: 0 }]);
    expect(r.commands.filter((c) => c.t > 3600)).toEqual([]);
    expect(r.frames.filter((f) => f.t > 3600).some((f) => f.state === "listen")).toBe(false);
    expect(r.final.halted).toBe(true);
    expect(commitsOf(r)).toEqual(["Friday summary padho"]);
  });

  it("mute holds the engine shut even hands-free, until an explicit wake opens it again", () => {
    const r = drive(
      script(
        speakingLead(),
        ctl(3600, "mute"),
        heard("t2", "Friday open the calculator", 5600, 6400),
        ctl(7200, "wake"),
        heard("t3", "Friday time kya hua hai", 7600, 8400),
      ),
      { handsFree: true },
    );
    expect(r.frames.filter((f) => f.t > 3600 && f.t < 7200).some((f) => f.state === "listen")).toBe(
      false,
    );
    expect(commitsOf(r)).toEqual(["Friday summary padho", "Friday time kya hua hai"]);
  });
});

describe("turn engine on simulator timelines: end of turn", () => {
  const CLEAN = script(
    heard("t1", "Friday what is the time", 0, 1200),
    brainEv(2000, "first-token", "r1", { lane: "quick" }),
    brainEv(2080, "done", "r1", { text: "It is ten past three." }),
    ttsEv(2400, "first-audio", "u1"),
    ttsEv(4000, "drained", "u1", { playedMs: 1600 }),
  );

  it("a clean command is committed once, 480 ms after its last voiced frame, and first sound is in the limits", () => {
    const r = drive(CLEAN);
    expect(commitsOf(r)).toEqual(["Friday what is the time"]);
    expect(r.records[0]?.record).toMatchObject({
      v: 2,
      turnId: "t1",
      eotWaitMs: 480,
      eager: false,
    });
    expect(r.records[0]?.record.lane).toBeUndefined();
    expect(r.score.turns[0]).toMatchObject({ speechEndAt: 1200, eotWaitMs: 400, falseCut: false });
    expect(r.score.turns[0]?.ttfaMs).toBe(1200);
    expect(kindsOf(r.commands)).toEqual(["commit"]);
  });

  it("the eotWaitMs p50 over clean commands (English, Hinglish, two in a row) is at most 560 ms", () => {
    const runs = [
      drive(CLEAN),
      drive(script(heard("t1", "Friday kal subah ke liye alarm laga do", 0, 1760))),
      drive(
        script(
          heard("t1", "Friday open the calculator", 0, 800),
          brainEv(1600, "first-token", "r1", { lane: "command" }),
          ttsEv(1840, "first-audio", "u1"),
          ttsEv(2400, "drained", "u1", { playedMs: 560 }),
          heard("t2", "Friday and the notepad", 2480, 3280),
        ),
      ),
    ];
    const run = aggregateRun(runs.map((r) => r.score));
    expect(run.eotWait.n).toBe(4);
    expect(run.eotWait.p50).not.toBeNull();
    expect(run.eotWait.p50 ?? Infinity).toBeLessThanOrEqual(560);
    expect(run.eotWait.p90 ?? Infinity).toBeLessThanOrEqual(560);
    expect(run.falseCut.k).toBe(0);
  });

  it("a trailing 'aur' holds the turn: nothing is committed in the pause, one turn goes out with the whole sentence", () => {
    const r = drive(
      script(
        heard("t1", "mujhe ek file kholni hai aur", 0, 1280),
        truth(1280, "pause"),
        truth(2080, "continuation"),
        ear(2080, "resumed", "t1", "mujhe ek file kholni hai aur"),
        vad(2080, 2880),
        ear(2800, "partial", "t1", "mujhe ek file kholni hai aur report wali"),
      ),
    );
    expect(commitsOf(r)).toEqual(["mujhe ek file kholni hai aur report wali"]);
    expect(r.records[0]?.t).toBeGreaterThan(2880);
    expect(r.score.pauses).toEqual([{ at: 1280, resumedAt: 2080, takeover: false }]);
    expect(r.score.turns[0]).toMatchObject({ falseCut: false, prematureEnd: false });
    expect(aggregateRun([r.score]).falseCut.k).toBe(0);
  });

  it("the same sentence without 'aur' is closed after the base wait: the hold is the words, not a slower engine", () => {
    const r = drive(script(heard("t1", "mujhe ek file kholni hai", 0, 1280)));
    expect(commitsOf(r)).toEqual(["mujhe ek file kholni hai"]);
    expect(r.records[0]?.record.eotWaitMs).toBe(480);
  });

  it("a trailing Devanagari 'और' holds the same way as 'aur'", () => {
    const r = drive(script(heard("t1", "मुझे एक फ़ाइल खोलनी है और", 0, 1280)));
    expect(r.records[0]?.record.eotWaitMs).toBe(960);
    expect(r.records[0]?.record.text).toBe("मुझे एक फ़ाइल खोलनी है और");
  });

  it("an 800 ms pause in the middle of a sentence does not think; the turn goes out once, with every word", () => {
    const r = drive(
      script(
        heard("t1", "Friday open the", 0, 800),
        truth(800, "pause"),
        ear(1600, "resumed", "t1", "Friday open the"),
        vad(1600, 2400),
        ear(2320, "partial", "t1", "Friday open the report from last week"),
      ),
    );
    expect(r.commands.filter((c) => c.t < 2400 && c.cmd.k === "commit")).toEqual([]);
    expect(commitsOf(r)).toEqual(["Friday open the report from last week"]);
    expect(r.score.pauses).toEqual([{ at: 800, resumedAt: 1600, takeover: false }]);
    expect(r.score.turns[0]?.falseCut).toBe(false);
  });

  it("[known limit] a pause longer than the base wait plus the hold still ends the turn; the calibration ring tunes that, not the engine", () => {
    // The simulator's own pauses are 1040 and 1120 ms: past the 880 ms an 'aur' or 'the' buys, so the half sentence goes.
    const r = drive(
      script(
        heard("t1", "Friday open the", 0, 800),
        truth(800, "pause"),
        ear(1840, "start", "t2"),
        vad(1840, 2640),
        ear(2560, "partial", "t2", "report from last week"),
      ),
    );
    expect(commitsOf(r)).toEqual(["Friday open the", "report from last week"]);
  });

  it("a confirmation turn closes fast: a bare yes to her yes/no question is committed after 160 ms, not 480 ms", () => {
    const asked = script(
      heard("t1", "Friday delete all the old invoices", 0, 1120),
      ttsEv(2400, "first-audio", "u1", { turnId: "t1" }),
      ctl(2480, "asked"),
      heard("t2", "yes", 2640, 2880, "answer"),
    );
    const fast = drive(asked);
    const slow = drive(asked.filter((e) => e.k !== "control"));
    expect(commitsOf(fast)).toEqual(["Friday delete all the old invoices", "yes"]);
    expect(fast.records[1]?.record.eotWaitMs).toBe(160);
    expect(slow.records[1]?.record.eotWaitMs).toBe(480);
    // Her question is cut at the first sound of the answer.
    expect(fast.score.barges[0]).toMatchObject({
      truth: "answer",
      silenceMs: 0,
      stoppedInTime: true,
    });
    expect(fast.records[1]?.record.text).toBe("yes");
    expect(fast.final.expect).toBeUndefined();
  });

  it("a Hinglish line in Latin letters is committed as hi-en with its words untouched", () => {
    const r = drive(
      script(
        heard("t1", "Friday kal subah ke liye alarm laga do", 0, 1760),
        brainEv(2560, "first-token", "r1", { lane: "quick" }),
        brainEv(2640, "done", "r1", { text: "Theek hai, alarm laga diya." }),
        ttsEv(3040, "first-audio", "u1"),
        ttsEv(4400, "drained", "u1", { playedMs: 1360 }),
      ),
    );
    expect(commitsOf(r)).toEqual(["Friday kal subah ke liye alarm laga do"]);
    expect(r.records[0]?.record.lang).toBe("hi-en");
    expect(r.score.turns[0]?.ttfaMs).toBe(1280);
    expect(r.score.turns[0]?.eotWaitMs).toBe(400);
  });

  it("two quick turns are two commits with their own ids and words; the second never carries the first", () => {
    const r = drive(
      script(
        heard("t1", "Friday open the calculator", 0, 800),
        brainEv(1600, "first-token", "r1", { lane: "command" }),
        brainEv(1680, "done", "r1", { text: "Opening the calculator." }),
        ttsEv(1840, "first-audio", "u1"),
        ttsEv(2400, "drained", "u1", { playedMs: 560 }),
        heard("t2", "Friday and the notepad", 2480, 3280),
        brainEv(4080, "first-token", "r2", { lane: "command" }),
        ttsEv(4320, "first-audio", "u2"),
        ttsEv(5200, "drained", "u2", { playedMs: 880 }),
      ),
    );
    expect(r.records.map((x) => [x.record.turnId, x.record.text])).toEqual([
      ["t1", "Friday open the calculator"],
      ["t2", "Friday and the notepad"],
    ]);
    expect(r.score.turns.map((t) => t.ttfaMs)).toEqual([1040, 1040]);
    expect(r.score.turns.map((t) => t.falseCut)).toEqual([false, false]);
    expect(r.final.state).toBe("idle");
  });
});

describe("turn engine on simulator timelines: drafts", () => {
  const eager = (cfg: Partial<TurnEngineConfig> = {}) => ({
    isReadOnly: () => true,
    eotBaseFrames: 10,
    ...cfg,
  });

  it("resumed speech after an eager draft cancels it; the second draft is adopted at the end", () => {
    const first = "Friday what is the weather";
    const second = "Friday what is the weather in Jaipur tomorrow";
    const r = drive(
      script(
        vad(0, 880),
        ear(0, "start", "t1"),
        truth(0, "command"),
        ear(800, "partial", "t1", first),
        ear(1360, "eager", "t1", first, { speechMs: 880 }),
        ear(1600, "resumed", "t1", first),
        vad(1600, 2400),
        ear(2320, "partial", "t1", second),
        ear(2960, "eager", "t1", second, { speechMs: 1680 }),
        fin(3120, second),
      ),
      eager(),
    );
    expect(kindsOf(r.commands)).toEqual([
      "draft-start",
      "draft-cancel",
      "draft-start",
      "draft-adopt",
      "commit",
    ]);
    const [start1, cancel, start2, adopt] = r.commands.map((c) => c.cmd);
    expect(start1).toMatchObject({ text: first });
    expect(cancel).toMatchObject({ k: "draft-cancel", text: first, turnId: "t1" });
    expect(start2).toMatchObject({ text: second });
    expect(adopt).toMatchObject({ k: "draft-adopt", text: second });
    expect(r.commands[1]?.t).toBe(1600);
    expect(r.records[0]?.record).toMatchObject({ text: second, eager: true, lane: "quick" });
    expect(r.score.turns[0]).toMatchObject({
      eagerCount: 2,
      resumedCount: 1,
      eagerResumedRatio: 0.5,
      draftHit: true,
    });
  });

  it("an eager draft that was right is adopted without a second one", () => {
    const text = "Friday open the calculator";
    const r = drive(
      script(
        vad(0, 800),
        ear(0, "start", "t1"),
        ear(720, "partial", "t1", text),
        ear(1360, "eager", "t1", text),
      ),
      eager(),
    );
    expect(kindsOf(r.commands)).toEqual(["draft-start", "draft-adopt", "commit"]);
    expect(r.records[0]?.record).toMatchObject({ eager: true, lane: "quick" });
  });

  it("drafts stay off without the read-only check, so an eager end alone commits nothing early", () => {
    const text = "Friday open the calculator";
    const r = drive(
      script(
        vad(0, 800),
        ear(0, "start", "t1"),
        ear(720, "partial", "t1", text),
        ear(1360, "eager", "t1", text),
      ),
      { eotBaseFrames: 10 },
    );
    expect(kindsOf(r.commands)).toEqual(["commit"]);
    expect(r.records[0]?.record.lane).toBeUndefined();
  });

  it("at most 3 drafts start in one turn, however often the owner resumes", () => {
    const cycles: Array<ScriptEvent | ScriptEvent[]> = [];
    for (let i = 0; i < 5; i += 1) {
      const b = i * 1200;
      const text = `Friday part ${"one two three four five".split(" ")[i]} of the plan`;
      cycles.push(
        vad(b, b + 400),
        ear(b + 320, "partial", "t1", text),
        ear(b + 800, "eager", "t1", text),
        ear(b + 1040, "resumed", "t1", text),
      );
    }
    const r = drive(script(ear(0, "start", "t1"), ...cycles), eager());
    const starts = r.commands.filter((c) => c.cmd.k === "draft-start");
    const cancels = r.commands.filter((c) => c.cmd.k === "draft-cancel");
    expect(starts).toHaveLength(3);
    expect(cancels).toHaveLength(3);
    expect(r.commands.filter((c) => c.cmd.k === "draft-adopt")).toHaveLength(0);
  });
});

describe("turn engine on simulator timelines: barge-in", () => {
  it("a real interruption stops her in the frame the owner takes the floor: 0 ms, inside 160 ms and inside the 300 ms limit", () => {
    const r = drive(
      script(
        speakingLead(),
        vad(3200, 4240),
        ear(3200, "start", "t2"),
        truth(3200, "interruption"),
        ear(3600, "partial", "t2", "wait open the budget"),
        ear(4160, "partial", "t2", "wait open the budget sheet instead"),
      ),
    );
    expect(stopsOf(r)).toHaveLength(1);
    expect(stopsOf(r)[0]).toMatchObject({
      t: 3200,
      cmd: { k: "stop-speech", reason: "takeover", resumable: false },
    });
    expect(r.score.barges[0]).toMatchObject({
      truth: "interruption",
      at: 3200,
      stoppedAt: 3200,
      silenceMs: 0,
      stoppedInTime: true,
      falseStop: false,
    });
    expect(
      r.score.turns.find((t) => t.turnId === "t2")?.bargeToSilenceMs ?? Infinity,
    ).toBeLessThanOrEqual(160);
    expect(INTERRUPT_STOP_WITHIN_MS).toBeGreaterThanOrEqual(160);
    expect(commitsOf(r)).toEqual(["Friday summary padho", "wait open the budget sheet instead"]);
    expect(r.final.state).toBe("think");
  });

  it("a nod while she speaks, with a keep verdict, ducks her and she carries on after five quiet frames", () => {
    const r = drive(
      script(
        speakingLead(),
        vad(3200, 3440),
        ear(3200, "start", "t2"),
        truth(3200, "backchannel"),
        ear(3360, "partial", "t2", "haan"),
        ear(3680, "end", "t2", "haan"),
      ),
      { barge: () => "keep" },
    );
    const afterNod = r.commands.filter((c) => c.t >= 3200);
    expect(afterNod.map((c) => [c.t, c.cmd.k])).toEqual([
      [3200, "duck"],
      [3760, "resume-speech"],
    ]);
    expect(stopsOf(r)).toEqual([]);
    expect(commitsOf(r)).toEqual(["Friday summary padho"]);
    expect(r.score.barges[0]).toMatchObject({
      truth: "backchannel",
      ducked: true,
      stoppedAt: null,
      falseStop: false,
    });
    expect(r.frames.find((f) => f.t === 3840)?.state).toBe("speak");
    expect(aggregateRun([r.score]).backchannelFalseStop).toMatchObject({ k: 0, n: 1 });
  });

  it("a TV burst below the hook's takeover level, told to ignore, never stops her, ducks her or opens a turn", () => {
    const burst = script(
      speakingLead(),
      vad(3200, 3520, 0.7),
      ear(3200, "start", "t2", "", { env: { kind: "tv", score: 0.8 } }),
      truth(3200, "noise"),
    );
    const r = drive(burst, { barge: BARGE_HOOK });
    expect(r.commands.filter((c) => c.t >= 3200)).toEqual([]);
    expect(duckedMs(r.trace)).toBe(0);
    expect(r.frames.find((f) => f.t === 3600)?.state).toBe("speak");
    expect(r.score.barges[0]).toMatchObject({ truth: "noise", stoppedAt: null, falseStop: false });
    expect(commitsOf(r)).toEqual(["Friday summary padho"]);
    // The hook is what protects her: with the default verdict the same burst takes the floor.
    const plain = drive(burst);
    expect(stopsOf(plain).map((c) => c.t)).toEqual([3200]);
    expect(plain.score.barges[0]?.falseStop).toBe(true);
  });

  it("a voice that is not echo-clean while she speaks is her own echo: nothing happens", () => {
    let state = createTurnEngine({ handsFree: true });
    for (const input of [
      { t: 0, k: "vad", p: 0.9, echoClean: true },
      {
        t: 240,
        k: "ear",
        turn: { turnId: "t0", event: "partial", text: "Friday time", vadP: null, speechMs: null },
      },
      { t: 1200, k: "tick" },
      { t: 1280, k: "tts", ev: "first-audio", utteranceId: "u0", playedMs: 0 },
    ] as TurnInput[]) {
      state = step(state, input).state;
    }
    expect(state.state).toBe("speak");
    const out = step(state, { t: 1360, k: "vad", p: 0.95, echoClean: false });
    expect(out.commands).toEqual([]);
    expect(out.state.state).toBe("speak");
  });
});

describe("turn engine on simulator timelines: the engine is a pure function of the script", () => {
  it("the same script gives the same commands and the same trace, byte for byte", () => {
    const events = script(
      speakingLead(),
      vad(3200, 4240),
      ear(3200, "start", "t2"),
      ear(4160, "partial", "t2", "wait open the budget sheet instead"),
    );
    const a = drive(events);
    const b = drive(events);
    expect(JSON.stringify(a.commands)).toBe(JSON.stringify(b.commands));
    expect(JSON.stringify(a.trace)).toBe(JSON.stringify(b.trace));
  });

  it("refuses an event that is off the 80 ms frame clock", () => {
    expect(() => drive([ear(40, "start", "t1")])).toThrow(/frame clock/);
  });

  it("an empty script commits nothing and stays idle", () => {
    const r = drive([], {}, 800);
    expect(r.commands).toEqual([]);
    expect(r.final.state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The comparison: the controller's four pinned defects, the same voice timeline, the engine
// ---------------------------------------------------------------------------------------------------------------

type Case = {
  tag: string;
  /** The simulator script played into the real controller. */
  controller: ScriptEvent[];
  /** The same voice timeline for the engine. */
  engine: ScriptEvent[];
  engineCfg?: Partial<TurnEngineConfig>;
  /** What "good" means for this defect, read from a trace score. */
  good: (score: TraceScore, trace: readonly TraceEvent[]) => boolean;
  /** One number that shows the difference. */
  number: (score: TraceScore, trace: readonly TraceEvent[]) => number;
  unit: string;
};

const noTakeover = (s: TraceScore): boolean =>
  s.pauses.length > 0 &&
  s.pauses.every((p) => !p.takeover) &&
  s.turns.every((t) => !t.falseCut && !t.prematureEnd);
const takeoverCount = (s: TraceScore): number => s.pauses.filter((p) => p.takeover).length;

const REPLY_SIM = REPLY;
const herAnswerSim = script(
  brainEv(0, "first-token", "r0", { lane: "full" }),
  brainEv(80, "done", "r0", { text: REPLY_SIM }),
  ttsEv(400, "first-audio", "u0"),
  ttsEv(7200, "drained", "u0", { playedMs: 6800 }),
);

const CASES: Case[] = [
  {
    tag: "[P2-E end-of-turn prior] end at a pause",
    controller: script(
      ear(0, "start", "t1"),
      truth(0, "command"),
      vad(0, 800),
      truth(800, "pause"),
      quiet(800, 1600),
      ear(1360, "end", "t1", "Friday open the", { speechMs: 800 }),
      fin(1440, "Friday open the"),
      brainEv(1600, "first-token", "r1", { lane: "command" }),
      brainEv(1680, "done", "r1", { text: "Which one?" }),
      ttsEv(2000, "first-audio", "u1", { turnId: "t1" }),
      ttsEv(2640, "drained", "u1", { playedMs: 600, turnId: "t1" }),
      truth(1600, "continuation"),
      ear(1600, "start", "t2"),
      vad(1600, 2400),
      quiet(2400, 3200),
      ear(3040, "end", "t2", "report from last week", { speechMs: 800 }),
      fin(3120, "report from last week"),
    ),
    engine: script(
      heard("t1", "Friday open the", 0, 800),
      truth(800, "pause"),
      truth(1600, "continuation"),
      ear(1600, "resumed", "t1", "Friday open the"),
      vad(1600, 2400),
      ear(2320, "partial", "t1", "Friday open the report from last week"),
    ),
    good: noTakeover,
    number: takeoverCount,
    unit: "takeovers at the pause",
  },
  {
    tag: "[P2-E end-of-turn prior] trailing aur",
    controller: script(
      ear(0, "start", "t1"),
      truth(0, "command"),
      vad(0, 1280),
      truth(1280, "pause"),
      quiet(1280, 2080),
      ear(1840, "end", "t1", "Friday kal ka meeting aur", { speechMs: 1280 }),
      fin(1920, "Friday kal ka meeting aur"),
      brainEv(2080, "first-token", "r1", { lane: "quick" }),
      brainEv(2160, "done", "r1", { text: "Kal ka meeting. Aur kya?" }),
      ttsEv(2480, "first-audio", "u1", { turnId: "t1" }),
      truth(2080, "continuation"),
      ear(2080, "start", "t2"),
      vad(2080, 2880),
      quiet(2880, 3680),
      ear(3440, "end", "t2", "dopahar ko rakho", { speechMs: 800 }),
      fin(3520, "dopahar ko rakho"),
    ),
    engine: script(
      heard("t1", "Friday kal ka meeting aur", 0, 1280),
      truth(1280, "pause"),
      truth(2080, "continuation"),
      ear(2080, "resumed", "t1", "Friday kal ka meeting aur"),
      vad(2080, 2880),
      ear(2800, "partial", "t1", "Friday kal ka meeting aur dopahar ko rakho"),
    ),
    good: noTakeover,
    number: takeoverCount,
    unit: "takeovers at the pause",
  },
  {
    tag: "[P2-F barge latency] real interruption",
    controller: script(
      herAnswerSim,
      ear(1600, "start", "t2"),
      truth(1600, "interruption"),
      vad(1600, 2640),
      quiet(2640, 4000),
      ear(2000, "partial", "t2", "wait open the budget"),
      ear(3200, "end", "t2", "wait open the budget sheet instead", { speechMs: 1040 }),
      fin(3280, "wait open the budget sheet instead"),
    ),
    engine: script(
      speakingLead(),
      vad(3200, 4240),
      ear(3200, "start", "t2"),
      truth(3200, "interruption"),
      ear(3600, "partial", "t2", "wait open the budget"),
      ear(4160, "partial", "t2", "wait open the budget sheet instead"),
    ),
    good: (s) => s.barges.length === 1 && s.barges.every((b) => b.stoppedInTime),
    number: (s) => s.barges[0]?.silenceMs ?? -1,
    unit: "ms from the voice to silence",
  },
  {
    tag: "[P2-F noise ducking] TV burst",
    controller: script(
      herAnswerSim,
      ear(1600, "start", "t2", "", { env: { kind: "tv", score: 0.8 } }),
      truth(1600, "noise"),
      vad(1600, 1920, 0.7),
      quiet(1920, 4000),
    ),
    engine: script(
      speakingLead(),
      vad(3200, 3520, 0.7),
      ear(3200, "start", "t2", "", { env: { kind: "tv", score: 0.8 } }),
      truth(3200, "noise"),
    ),
    engineCfg: { barge: BARGE_HOOK },
    good: (s, trace) => duckedMs(trace) <= 640 && s.barges.every((b) => !b.falseStop),
    number: (_s, trace) => duckedMs(trace),
    unit: "ms she was ducked",
  },
];

describe("turn engine against the real controller on the defects the simulator pins", () => {
  const results: Array<{ tag: string; controller: number; engine: number; unit: string }> = [];

  for (const c of CASES) {
    it(`${c.tag}: the controller fails it, the pure engine passes it`, async () => {
      const sim: SimResult = await runScenario({ name: c.tag, script: c.controller });
      const simGood = c.good(sim.score, sim.trace);
      const run = drive(c.engine, c.engineCfg);
      const engineGood = c.good(run.score, run.trace);
      results.push({
        tag: c.tag,
        controller: c.number(sim.score, sim.trace),
        engine: c.number(run.score, run.trace),
        unit: c.unit,
      });
      // Today's controller (the pinned baseline of voice-turn-sim.test.ts): this flips when the engine drives it.
      expect(simGood).toBe(false);
      expect(engineGood).toBe(true);
    }, 30_000);
  }

  it("prints the table: the four defects and the numbers on each side", () => {
    expect(results).toHaveLength(CASES.length);
    console.info(JSON.stringify({ comparison: results }));
    const byTag = Object.fromEntries(results.map((x) => [x.tag, x]));
    const premature = byTag["[P2-E end-of-turn prior] end at a pause"];
    const aur = byTag["[P2-E end-of-turn prior] trailing aur"];
    const barge = byTag["[P2-F barge latency] real interruption"];
    const noise = byTag["[P2-F noise ducking] TV burst"];
    expect([premature?.controller, premature?.engine]).toEqual([1, 0]);
    expect([aur?.controller, aur?.engine]).toEqual([1, 0]);
    expect([barge?.controller, barge?.engine]).toEqual([400, 0]);
    expect([noise?.controller, noise?.engine]).toEqual([4400, 0]);
  });
});
