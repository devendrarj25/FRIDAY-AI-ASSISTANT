import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FRAME_MS,
  createTurnEngine,
  frameOf,
  step,
  type BargeVerdict,
  type TurnCommand,
  type TurnEngineConfig,
  type TurnEngineState,
  type TurnInput,
} from "../../src/lib/friday/voice-engine/turn-engine";
import type { StreamTurn } from "../../src/lib/friday/voice-engine/stream-session";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const at = (frame: number) => frame * FRAME_MS;

function ear(
  frame: number,
  event: StreamTurn["event"],
  text: string,
  turnId = "t1",
  extra: Partial<StreamTurn> = {},
): TurnInput {
  return {
    t: at(frame),
    k: "ear",
    turn: { turnId, event, text, vadP: null, speechMs: null, ...extra },
  };
}
const tick = (frame: number): TurnInput => ({ t: at(frame), k: "tick" });
const vad = (frame: number, p = 0.9, echoClean = true): TurnInput => ({
  t: at(frame),
  k: "vad",
  p,
  echoClean,
});
const control = (
  frame: number,
  ev: "stop-all" | "mute" | "pause" | "wake" | "asked",
  expect?: "yesno" | "number" | "name" | "open",
): TurnInput => ({ t: at(frame), k: "control", ev, ...(expect ? { expect } : {}) });
const tts = (
  frame: number,
  ev: "first-audio" | "clause-end" | "drained" | "failed",
  utteranceId = "u1",
): TurnInput => ({ t: at(frame), k: "tts", ev, utteranceId, playedMs: 0 });

/** Runs inputs through the engine on deep-frozen state; returns the last state and every command. */
function run(
  start: TurnEngineState,
  inputs: TurnInput[],
): { s: TurnEngineState; commands: TurnCommand[] } {
  let s = start;
  const commands: TurnCommand[] = [];
  for (const input of inputs) {
    deepFreeze(s);
    deepFreeze(input);
    const out = step(s, input);
    s = out.state;
    commands.push(...out.commands);
  }
  return { s, commands };
}

const kinds = (cmds: TurnCommand[]) => cmds.map((c) => c.k);
const open = (cfg: Partial<TurnEngineConfig> = {}) => createTurnEngine({ handsFree: true, ...cfg });
/** Drafts are off until the conductor passes the real read-only check; these tests turn them on. */
const drafting = (cfg: Partial<TurnEngineConfig> = {}) => open({ isReadOnly: () => true, ...cfg });

/** A heard turn "hello there" ending at frame 10, thinking from frame 16. */
function thinking(cfg: Partial<TurnEngineConfig> = {}) {
  return run(open(cfg), [ear(0, "start", "hello"), ear(10, "partial", "hello there"), tick(16)]);
}
function speaking(cfg: Partial<TurnEngineConfig> = {}) {
  const t = thinking(cfg);
  return run(t.s, [tts(17, "first-audio")]);
}

describe("turn engine: frames and construction", () => {
  it("cuts time into 80 ms frames and defaults to the planned numbers", () => {
    expect(FRAME_MS).toBe(80);
    expect(frameOf(0)).toBe(0);
    expect(frameOf(79)).toBe(0);
    expect(frameOf(80)).toBe(1);
    expect(frameOf(Number.NaN)).toBe(0);
    const s = createTurnEngine({});
    expect(s.cfg.eotBaseFrames).toBe(6);
    expect(s.cfg.maxListenFrames).toBe(125);
    expect(s.cfg.handsFree).toBe(false);
    expect(s.state).toBe("idle");
    expect(s.v).toBe(1);
  });
});

describe("turn engine: end of turn", () => {
  it("think only after 6 quiet frames, not 5", () => {
    const heard = run(open(), [
      ear(0, "start", "open the file"),
      ear(10, "partial", "open the file"),
    ]);
    const at15 = run(heard.s, [tick(15)]);
    expect(at15.s.state).toBe("listen");
    expect(at15.commands).toEqual([]);
    const at16 = run(heard.s, [tick(16)]);
    expect(at16.s.state).toBe("think");
    expect(kinds(at16.commands)).toEqual(["commit"]);
    const commit = at16.commands[0];
    expect(commit?.k === "commit" && commit.record.text).toBe("open the file");
    expect(commit?.k === "commit" && commit.record.turnId).toBe("t1");
  });

  it("voice from the VAD pushes the end of the turn back", () => {
    const heard = run(open(), [ear(0, "start", "wait"), vad(12)]);
    expect(run(heard.s, [tick(17)]).s.state).toBe("listen");
    expect(run(heard.s, [tick(18)]).s.state).toBe("think");
  });

  it("holdFor adds quiet frames for these words and for the expected answer", () => {
    const holdFor = (text: string, expectKind: string | undefined) =>
      text.endsWith("and") ? 4 : expectKind === "number" ? 2 : 0;
    const heard = run(open({ holdFor }), [ear(0, "partial", "tea and")]);
    expect(heard.s.eotAtFrame).toBe(10);
    expect(run(heard.s, [tick(9)]).s.state).toBe("listen");
    expect(run(heard.s, [tick(10)]).s.state).toBe("think");
    const asked = run(open({ holdFor }), [control(0, "asked", "number"), ear(1, "partial", "42")]);
    expect(asked.s.eotAtFrame).toBe(1 + 6 + 2);
  });

  it("maxListenFrames forces think, and an empty turn falls back to idle", () => {
    const talking = run(open(), [ear(0, "start", "long story")]);
    // keep the voice alive so only the cap can end the turn
    let s = talking.s;
    let commands: TurnCommand[] = [];
    for (let f = 1; f <= 124; f += 1) {
      const out = run(s, [vad(f)]);
      s = out.s;
      commands = commands.concat(out.commands);
    }
    expect(s.state).toBe("listen");
    const capped = run(s, [vad(125)]);
    expect(capped.s.state).toBe("think");
    expect(kinds(capped.commands)).toEqual(["commit"]);
    const silent = run(open(), [vad(0)]);
    expect(silent.s.state).toBe("listen");
    expect(run(silent.s, [tick(125)]).s.state).toBe("idle");
  });
});

describe("turn engine: wake and kill switches", () => {
  it("idle -> listen on voice when hands-free; a needed wake word holds it in idle", () => {
    expect(run(open(), [vad(0)]).s.state).toBe("listen");
    const closed = createTurnEngine({ handsFree: false });
    const heard = run(closed, [vad(0), ear(1, "start", "hello", "a1")]);
    expect(heard.s.state).toBe("idle");
    expect(heard.commands).toEqual([{ k: "require-wake", why: "wake-needed" }]);
    const woken = run(closed, [control(0, "wake")]);
    expect(woken.s.state).toBe("listen");
    expect(woken.s.needWake).toBe(false);
  });

  it("honours the ear's needsWake when hands-free is off, not when it is on", () => {
    const awake = run(createTurnEngine({ handsFree: false }), [
      control(0, "wake"),
      control(1, "stop-all"),
    ]);
    expect(awake.s.needWake).toBe(true);
    const needs = ear(2, "start", "hi", "n1", { needsWake: true });
    const base = createTurnEngine({ handsFree: false });
    base.needWake = false;
    expect(run(base, [needs]).s.state).toBe("idle");
    expect(run(open(), [needs]).s.state).toBe("listen");
  });

  it("stop-all from speak emits stop-speech and returns idle", () => {
    const sp = speaking();
    expect(sp.s.state).toBe("speak");
    const out = run(sp.s, [control(20, "stop-all")]);
    expect(out.s.state).toBe("idle");
    expect(out.commands).toContainEqual({ k: "stop-speech", reason: "stop-all", resumable: false });
    expect(kinds(out.commands)).toContain("draft-cancel");
    expect(kinds(out.commands)).not.toContain("require-wake");
  });

  it("stop-all works from every state and asks for the wake word when hands-free is off", () => {
    for (const handsFree of [true, false]) {
      const cfg = { handsFree };
      const states: TurnEngineState[] = [
        createTurnEngine(cfg),
        run(createTurnEngine(cfg), [control(0, "wake"), ear(1, "start", "x")]).s,
        run(createTurnEngine(cfg), [control(0, "wake"), ear(1, "partial", "x"), tick(9)]).s,
        run(createTurnEngine(cfg), [
          control(0, "wake"),
          ear(1, "partial", "x"),
          tick(9),
          tts(10, "first-audio"),
        ]).s,
        run(createTurnEngine(cfg), [
          control(0, "wake"),
          ear(1, "partial", "x"),
          tick(9),
          tts(10, "first-audio"),
          vad(11),
        ]).s,
      ];
      expect(states.map((x) => x.state)).toEqual(["idle", "listen", "think", "speak", "yield"]);
      for (const s of states) {
        const out = run(s, [control(30, "stop-all")]);
        expect(out.s.state).toBe("idle");
        expect(out.commands.some((c) => c.k === "stop-speech" && !c.resumable)).toBe(true);
        expect(out.commands.some((c) => c.k === "require-wake")).toBe(!handsFree);
        expect(out.s.needWake).toBe(!handsFree);
      }
    }
  });

  it("mute then voice without the wake word stays idle", () => {
    const awake = run(createTurnEngine({ handsFree: false }), [control(0, "wake")]);
    const muted = run(awake.s, [control(1, "mute"), vad(2), ear(3, "start", "hello", "m1")]);
    expect(muted.s.state).toBe("idle");
    expect(muted.commands.some((c) => c.k === "require-wake" && c.why === "mute")).toBe(true);
    expect(muted.commands.some((c) => c.k === "commit")).toBe(false);
  });

  it("the pause kill switch holds the engine shut, even hands-free, until a wake", () => {
    const paused = run(open(), [
      control(0, "pause"),
      vad(1),
      ear(2, "start", "hello", "p1"),
      tick(40),
    ]);
    expect(paused.s.state).toBe("idle");
    expect(paused.s.halted).toBe(true);
    expect(paused.commands.some((c) => c.k === "commit")).toBe(false);
    const back = run(paused.s, [control(41, "wake")]);
    expect(back.s.halted).toBe(false);
    expect(back.s.state).toBe("listen");
  });
});

describe("turn engine: think, speak and yield", () => {
  it("think -> speak on first audio, speak -> idle on drained; a stale utterance is ignored", () => {
    const sp = speaking();
    expect(sp.s.state).toBe("speak");
    expect(sp.s.utteranceId).toBe("u1");
    expect(run(sp.s, [tts(30, "drained", "other")]).s.state).toBe("speak");
    expect(run(sp.s, [tts(30, "clause-end")]).s.state).toBe("speak");
    expect(run(sp.s, [tts(30, "drained")]).s.state).toBe("idle");
    expect(run(sp.s, [tts(30, "failed")]).s.state).toBe("idle");
  });

  it("a refused run goes back to idle with an ack; a stale run id is ignored", () => {
    const t = thinking();
    const first = run(t.s, [{ t: at(17), k: "brain", ev: "lane", runId: "r1", lane: "quick" }]);
    expect(first.s.runId).toBe("r1");
    const stale = run(first.s, [{ t: at(18), k: "brain", ev: "refused", runId: "r0" }]);
    expect(stale.s.state).toBe("think");
    const refused = run(first.s, [{ t: at(18), k: "brain", ev: "refused", runId: "r1" }]);
    expect(refused.s.state).toBe("idle");
    expect(refused.commands).toEqual([{ k: "ack", key: "refused" }]);
  });

  it("an echo-clean voice in speak yields with a -12 dB duck; an echo-polluted one does not", () => {
    const sp = speaking();
    expect(run(sp.s, [vad(20, 0.9, false)]).s.state).toBe("speak");
    expect(run(sp.s, [vad(20, 0.2, true)]).s.state).toBe("speak");
    const out = run(sp.s, [vad(20)]);
    expect(out.s.state).toBe("yield");
    expect(out.commands).toEqual([{ k: "duck", db: -12 }]);
  });

  it("yield resumes speech after 5 quiet frames, not 4", () => {
    const y = run(speaking().s, [vad(20)]);
    const at24 = run(y.s, [tick(24)]);
    expect(at24.s.state).toBe("yield");
    const at25 = run(y.s, [tick(25)]);
    expect(at25.s.state).toBe("speak");
    expect(at25.commands).toEqual([{ k: "resume-speech" }]);
    const kept = run(y.s, [vad(23), tick(27)]);
    expect(kept.s.state).toBe("yield");
    expect(run(kept.s, [tick(28)]).s.state).toBe("speak");
  });

  it("a new turn in yield takes over: speech stops for good and a fresh turn listens", () => {
    const y = run(speaking().s, [vad(20)]);
    const out = run(y.s, [ear(22, "start", "actually", "t2")]);
    expect(out.s.state).toBe("listen");
    expect(out.s.turnId).toBe("t2");
    expect(out.commands).toContainEqual({ k: "stop-speech", reason: "takeover", resumable: false });
    const same = run(y.s, [ear(22, "revised", "hello there", "t1")]);
    expect(same.s.state).toBe("yield");
    expect(run(speaking().s, [ear(20, "start", "noise", "t2")]).s.state).toBe("speak");
  });

  it("a spoken question opens the mic for its answer after the speech drains", () => {
    const sp = run(speaking().s, [control(18, "asked", "yesno")]);
    expect(sp.s.expect).toBe("yesno");
    const out = run(sp.s, [tts(30, "drained")]);
    expect(out.s.state).toBe("listen");
    expect(out.s.turnId).toBe("");
  });
});

describe("turn engine: drafts", () => {
  it("an eager turn starts a draft; the same words at the end adopt it", () => {
    const eager = run(drafting(), [ear(0, "partial", "play music"), ear(4, "eager", "play music")]);
    expect(eager.commands).toEqual([{ k: "draft-start", turnId: "t1", text: "play music" }]);
    const done = run(eager.s, [tick(10)]);
    expect(kinds(done.commands)).toEqual(["draft-adopt", "commit"]);
    const commit = done.commands[1];
    expect(commit?.k === "commit" && commit.record.eager).toBe(true);
  });

  it("resumed speech cancels the draft; changed words at the end cancel it; at most 3 drafts per turn", () => {
    const eager = run(drafting(), [ear(0, "partial", "play music"), ear(4, "eager", "play music")]);
    const resumed = run(eager.s, [ear(5, "resumed", "play music now")]);
    expect(kinds(resumed.commands)).toEqual(["draft-cancel"]);
    const changed = run(eager.s, [ear(5, "partial", "play jazz"), tick(20)]);
    expect(kinds(changed.commands)).toEqual(["draft-cancel", "commit"]);
    let s = drafting();
    let starts = 0;
    for (let n = 0; n < 5; n += 1) {
      const out = run(s, [
        ear(n * 2, "eager", `play ${n}`),
        ear(n * 2 + 1, "resumed", `play ${n}!`),
      ]);
      starts += out.commands.filter((c) => c.k === "draft-start").length;
      s = out.s;
    }
    expect(starts).toBe(3);
  });

  it("the draft hook can refuse", () => {
    const out = run(drafting({ draft: () => ({ allow: false }) }), [ear(0, "eager", "play music")]);
    expect(out.commands).toEqual([]);
  });
});

describe("turn engine: purity", () => {
  const script: TurnInput[] = [
    control(0, "wake"),
    ear(1, "start", "hello", "t1"),
    ear(3, "partial", "hello there", "t1"),
    ear(5, "eager", "hello there", "t1"),
    tick(12),
    { t: at(13), k: "brain", ev: "lane", runId: "r1", lane: "full" },
    tts(14, "first-audio"),
    vad(15),
    tick(21),
    tts(22, "drained"),
  ];

  it("the same input list gives byte-identical commands and state", () => {
    const cfg = { handsFree: false, isReadOnly: () => true };
    const a = run(createTurnEngine(cfg), script);
    const b = run(createTurnEngine(cfg), script);
    expect(JSON.stringify(a.commands)).toBe(JSON.stringify(b.commands));
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(b.s));
    expect(a.s.state).toBe("idle");
    expect(kinds(a.commands)).toEqual([
      "draft-start",
      "draft-adopt",
      "commit",
      "duck",
      "resume-speech",
    ]);
  });

  it("never mutates its input, and a late clock cannot run time backwards", () => {
    const start = deepFreeze(open());
    const out = step(start, ear(5, "start", "hello"));
    expect(start.state).toBe("idle");
    expect(out.state).not.toBe(start);
    expect(step(out.state, tick(1)).state.frame).toBe(5);
  });

  it("never emits a run or an approval command", () => {
    const all = run(
      createTurnEngine({ handsFree: false, isReadOnly: () => true }),
      script,
    ).commands;
    for (const c of all) expect(["run", "approve", "approval"]).not.toContain(c.k);
    const src = readFileSync(
      resolve(__dirname, "../../src/lib/friday/voice-engine/turn-engine.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/k:\s*"(run|approve|approval)"/);
    expect(src).not.toMatch(/from\s+"\.\.\/(assistant-mode|preferences)"/);
    expect(src).not.toMatch(/Date\.now|window|document|setTimeout/);
    expect(src).not.toMatch(/interruption|classif/i);
  });
});

describe("turn engine: defaults come from the calibration and the governor", () => {
  it("holdFor defaults to the end-of-turn prior and drafts stay off without a read-only check", () => {
    const s = createTurnEngine({ handsFree: true });
    expect(typeof s.cfg.holdFor).toBe("function");
    expect(s.cfg.holdFor?.("chai aur", undefined)).toBe(6);
    const eager = run(s, [ear(0, "partial", "play music"), ear(4, "eager", "play music")]);
    expect(eager.commands).toEqual([]);
    const throws = open({
      isReadOnly: () => {
        throw new Error("boom");
      },
    });
    expect(run(throws, [ear(0, "eager", "play music")]).commands).toEqual([]);
  });

  it("think waits longer after a dangling aur", () => {
    const plain = run(open(), [ear(0, "partial", "chai pilao")]);
    const dangling = run(open(), [ear(0, "partial", "chai aur")]);
    expect(plain.s.eotAtFrame).toBe(6);
    expect(dangling.s.eotAtFrame).toBe(12);
    expect(run(dangling.s, [tick(11)]).s.state).toBe("listen");
    expect(run(dangling.s, [tick(12)]).s.state).toBe("think");
    const finished = run(open(), [ear(0, "partial", "chai aur biscuit.")]);
    expect(finished.s.eotAtFrame).toBe(6);
  });

  it("a bare yes to a yes/no question closes faster, a digit run waits", () => {
    const yes = run(open(), [control(0, "asked", "yesno"), ear(1, "partial", "haan")]);
    expect(yes.s.eotAtFrame).toBe(1 + 6 - 4);
    expect(run(yes.s, [tick(3)]).s.state).toBe("think");
    const num = run(open(), [control(0, "asked", "number"), ear(1, "partial", "forty two")]);
    expect(num.s.eotAtFrame).toBe(1 + 6 + 4);
  });

  it("a hold can never take more than four frames off", () => {
    const heard = run(open({ holdFor: () => -50 }), [ear(0, "partial", "yes")]);
    expect(heard.s.eotAtFrame).toBe(2);
  });

  it("resumed cancels draft; next eager starts draft 2 of 3", () => {
    const first = run(drafting(), [ear(0, "eager", "play music")]);
    expect(first.s.gov.thisTurn).toBe(1);
    const resumed = run(first.s, [ear(2, "resumed", "play music now")]);
    expect(resumed.commands).toEqual([{ k: "draft-cancel", turnId: "t1", text: "play music" }]);
    expect(resumed.s.draft.inFlight).toBe(false);
    const second = run(resumed.s, [ear(4, "eager", "play music now")]);
    expect(second.commands).toEqual([{ k: "draft-start", turnId: "t1", text: "play music now" }]);
    expect(second.s.gov.thisTurn).toBe(2);
  });

  it("fourth draft refused", () => {
    let s = drafting();
    const starts: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const out = run(s, [
        ear(n * 2, "eager", `play ${n}`),
        ear(n * 2 + 1, "resumed", `play ${n}!`),
      ]);
      for (const c of out.commands) if (c.k === "draft-start") starts.push(c.text);
      s = out.s;
    }
    expect(starts).toEqual(["play 0", "play 1", "play 2"]);
    expect(s.gov.thisTurn).toBe(3);
  });

  it("a new turn id starts the draft count again", () => {
    let s = drafting();
    for (let n = 0; n < 3; n += 1) {
      s = run(s, [ear(n * 2, "eager", `a${n}`), ear(n * 2 + 1, "resumed", `a${n}!`)]).s;
    }
    const fresh = run(s, [ear(8, "eager", "play music", "t2")]);
    expect(fresh.commands).toEqual([{ k: "draft-start", turnId: "t2", text: "play music" }]);
    expect(fresh.s.gov.thisTurn).toBe(1);
  });

  it("the governor's audio cap refuses a draft after ten seconds of listening", () => {
    const s = run(drafting({ maxListenFrames: 400, eotBaseFrames: 400 }), [ear(0, "start", "x")]);
    const late = run(s.s, [ear(126, "eager", "play music")]);
    expect(late.commands).toEqual([]);
    const soon = run(s.s, [ear(100, "eager", "play music")]);
    expect(kinds(soon.commands)).toEqual(["draft-start"]);
  });

  it("adopt only on same words", () => {
    const base = run(drafting(), [ear(0, "eager", "Play  music!")]);
    const same = run(base.s, [ear(2, "partial", "play music"), tick(12)]);
    expect(kinds(same.commands)).toEqual(["draft-adopt", "commit"]);
    const other = run(base.s, [ear(2, "partial", "play music loudly"), tick(12)]);
    expect(kinds(other.commands)).toEqual(["draft-cancel", "commit"]);
    expect(other.commands[0]).toEqual({ k: "draft-cancel", turnId: "t1", text: "Play  music!" });
  });
});

describe("turn engine: the committed record", () => {
  it("carries v2, the quiet wait from the frame clock, and the quick lane when a draft was adopted", () => {
    const heard = run(drafting(), [ear(0, "eager", "play music"), ear(3, "partial", "play music")]);
    const done = run(heard.s, [tick(9)]);
    const commit = done.commands.find((c) => c.k === "commit");
    expect(commit?.k === "commit" && commit.record.v).toBe(2);
    expect(commit?.k === "commit" && commit.record.eotWaitMs).toBe((9 - 3) * FRAME_MS);
    expect(commit?.k === "commit" && commit.record.lane).toBe("quick");
    expect(commit?.k === "commit" && commit.record.eager).toBe(true);
    const plain = run(open(), [ear(0, "partial", "open the file"), tick(6)]);
    const rec = plain.commands[0];
    expect(rec?.k === "commit" && rec.record.eotWaitMs).toBe(6 * FRAME_MS);
    expect(rec?.k === "commit" && "lane" in rec.record).toBe(false);
  });

  it("a voice frame moves the wait measure with it", () => {
    const heard = run(open(), [ear(0, "partial", "wait"), vad(5)]);
    const done = run(heard.s, [tick(11)]);
    const rec = done.commands[0];
    expect(rec?.k === "commit" && rec.record.eotWaitMs).toBe(6 * FRAME_MS);
  });
});

describe("turn engine: barge verdicts", () => {
  it("takeover is the default at p >= 0.5: duck and yield", () => {
    const sp = speaking();
    const out = run(sp.s, [vad(20, 0.5)]);
    expect(out.s.state).toBe("yield");
    expect(out.commands).toEqual([{ k: "duck", db: -12 }]);
    expect(run(sp.s, [vad(20, 0.49)]).s.state).toBe("speak");
  });

  it("keep talks on, ducked once, and restores after five quiet frames", () => {
    const sp = speaking({ barge: () => "keep" });
    const first = run(sp.s, [vad(20), vad(21)]);
    expect(first.s.state).toBe("speak");
    expect(first.commands).toEqual([{ k: "duck", db: -12 }]);
    expect(run(first.s, [tick(25)]).commands).toEqual([]);
    const back = run(first.s, [tick(26)]);
    expect(back.commands).toEqual([{ k: "resume-speech" }]);
    expect(back.s.ducked).toBe(false);
  });

  it("ignore does nothing", () => {
    const sp = speaking({ barge: () => "ignore" });
    const out = run(sp.s, [vad(20), vad(21), tick(40)]);
    expect(out.s.state).toBe("speak");
    expect(out.commands).toEqual([]);
  });

  it("is told the voice level and the milliseconds played, and a throwing or odd hook means takeover", () => {
    const seen: Array<[number, number]> = [];
    const sp = speaking({
      barge: (p, played) => {
        seen.push([p, played]);
        return "keep";
      },
    });
    const played = run(sp.s, [
      { t: at(18), k: "tts", ev: "clause-end", utteranceId: "u1", playedMs: 640 },
      vad(19, 0.8),
    ]);
    expect(seen).toEqual([[0.8, 640]]);
    expect(played.s.playedMs).toBe(640);
    const odd = speaking({
      barge: (() => "maybe") as unknown as (p: number, playedMs: number) => BargeVerdict,
    });
    expect(run(odd.s, [vad(20)]).s.state).toBe("yield");
    const bad = speaking({
      barge: () => {
        throw new Error("x");
      },
    });
    expect(run(bad.s, [vad(20)]).s.state).toBe("yield");
  });

  it("an echo-polluted frame never reaches the hook", () => {
    let calls = 0;
    const sp = speaking({
      barge: () => {
        calls += 1;
        return "takeover";
      },
    });
    run(sp.s, [vad(20, 0.9, false)]);
    expect(calls).toBe(0);
  });
});

describe("turn engine: determinism and immutability with the new parts", () => {
  const script2: TurnInput[] = [
    control(0, "wake"),
    ear(1, "start", "chai aur", "t1"),
    ear(3, "eager", "chai aur", "t1"),
    ear(4, "resumed", "chai aur biscuit", "t1"),
    ear(6, "eager", "chai aur biscuit", "t1"),
    tick(30),
    tts(31, "first-audio"),
    vad(32, 0.7),
    tick(40),
    tts(41, "drained"),
  ];
  const cfg = () => ({
    isReadOnly: () => true,
    barge: (p: number) => (p > 0.6 ? "keep" : "takeover") as BargeVerdict,
  });

  it("same inputs give byte-identical commands and state", () => {
    const a = run(createTurnEngine({ handsFree: false, ...cfg() }), script2);
    const b = run(createTurnEngine({ handsFree: false, ...cfg() }), script2);
    expect(JSON.stringify(a.commands)).toBe(JSON.stringify(b.commands));
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(b.s));
    expect(kinds(a.commands)).toEqual([
      "draft-start",
      "draft-cancel",
      "draft-start",
      "draft-adopt",
      "commit",
      "duck",
      "resume-speech",
    ]);
  });

  it("run() deep-freezes every state and input, so any write would have thrown", () => {
    const out = run(createTurnEngine({ handsFree: false, ...cfg() }), script2);
    expect(out.s.state).toBe("idle");
    const frozen = deepFreeze(createTurnEngine({ handsFree: true, ...cfg() }));
    const next = step(frozen, ear(1, "eager", "hello"));
    expect(next.state.gov.thisTurn).toBe(1);
    expect(frozen.gov.thisTurn).toBe(0);
    expect(frozen.draft.inFlight).toBe(false);
  });
});
