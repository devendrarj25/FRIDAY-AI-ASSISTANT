import { describe, expect, it } from "vitest";
import {
  normalizeWakeGuardConfig,
  SCENE_BOOST_MAX,
  SCENE_HOLD_MS,
  WAKE_GUARD_DEFAULTS,
  WakeGuard,
  type WakeCandidate,
} from "../../src/lib/friday/wake-guard";

/* A fake clock and hand-fed frames: no real timers, no devices, synthetic frames only. */

const T = 0.5;
const START = 100_000;

function room(config: Record<string, unknown> = {}) {
  const guard = new WakeGuard(config);
  let now = START;
  let tick = 0;
  const frame = (speech: boolean, highBandShare?: number) => {
    // A wobbling level reads as speech; a flat one would read as a steady hum and raise the threshold.
    const level = speech ? (tick % 2 === 0 ? 0.1 : 0.3) : 0.003;
    guard.observe({
      nowMs: now,
      level,
      speech,
      speaking: false,
      ...(highBandShare === undefined ? {} : { highBandShare }),
    });
    tick += 1;
    now += 20;
  };
  return {
    guard,
    get now() {
      return now;
    },
    talk(ms: number, highBandShare?: number) {
      for (let n = 0; n < ms / 20; n += 1) frame(true, highBandShare);
    },
    quiet(ms: number) {
      for (let n = 0; n < ms / 20; n += 1) frame(false);
    },
    advance(ms: number) {
      now += ms;
    },
    cand(extra: Partial<WakeCandidate> = {}): WakeCandidate {
      return {
        nowMs: now,
        score: 1,
        threshold: T,
        kind: "utterance",
        ownerEnergy: 0.3,
        playbackEnergy: 0,
        ...extra,
      };
    },
    near(extra: Partial<WakeCandidate> = {}): WakeCandidate {
      return this.cand({ kind: "frame", score: T - 0.05, ...extra });
    },
  };
}

const ON = { secondPassMargin: 0.1 };

describe("config", () => {
  it("defaults are off and keep today's behaviour", () => {
    expect(WAKE_GUARD_DEFAULTS.secondPassMargin).toBe(0);
    expect(WAKE_GUARD_DEFAULTS.ultrasonicShare).toBe(0);
    expect(normalizeWakeGuardConfig()).toEqual(WAKE_GUARD_DEFAULTS);
    expect(new WakeGuard().handsFree).toBe(false);
  });

  it("clamps both keys and turns junk into the default 0", () => {
    const high = normalizeWakeGuardConfig({ secondPassMargin: 9, ultrasonicShare: 9 });
    expect([high.secondPassMargin, high.ultrasonicShare]).toEqual([0.2, 1]);
    const low = normalizeWakeGuardConfig({ secondPassMargin: -1, ultrasonicShare: -1 });
    expect([low.secondPassMargin, low.ultrasonicShare]).toEqual([0, 0]);
    const junk = normalizeWakeGuardConfig({ secondPassMargin: "x", ultrasonicShare: NaN });
    expect([junk.secondPassMargin, junk.ultrasonicShare]).toEqual([0, 0]);
    const nul = normalizeWakeGuardConfig({ secondPassMargin: null, ultrasonicShare: Infinity });
    expect([nul.secondPassMargin, nul.ultrasonicShare]).toEqual([0, 0]);
  });
});

describe("second pass: off is byte-for-byte today", () => {
  it("a near miss is a plain below-threshold with no verify key at all", () => {
    const r = room();
    r.talk(600);
    const verdict = r.guard.consider(r.near());
    expect(verdict).toEqual({ accept: false, reason: "below-threshold" });
    expect("verify" in verdict).toBe(false);
    const snap = r.guard.snapshot(r.now).counters;
    expect([snap.verifyAsked, snap.verifyAccepted, snap.ultrasonic]).toEqual([0, 0, 0]);
    expect(snap.blocked["below-threshold"]).toBe(1);
  });
});

describe("second pass: a near miss earns one look, never an accept", () => {
  it("score threshold - 0.05 with margin 0.1 asks for a verify and does not accept", () => {
    const r = room(ON);
    r.talk(600);
    const verdict = r.guard.consider(r.near());
    expect(verdict).toEqual({ accept: false, reason: "below-threshold", verify: true });
    const snap = r.guard.snapshot(r.now);
    expect(snap.counters.verifyAsked).toBe(1);
    expect(snap.counters.accepted).toBe(0);
    expect(snap.state).toBe("asleep");
    expect(snap.counters.blocked["below-threshold"]).toBe(1);
  });

  it("the edge of the margin asks, one step under it does not, the bar itself is not a near miss", () => {
    const edge = room(ON);
    edge.talk(600);
    expect(edge.guard.consider(edge.near({ score: T - 0.1 })).verify).toBe(true);
    const under = room(ON);
    under.talk(600);
    expect(under.guard.consider(under.near({ score: T - 0.1001 }))).toEqual({
      accept: false,
      reason: "below-threshold",
    });
  });

  it("an utterance never asks (only a frame candidate does)", () => {
    const r = room(ON);
    r.talk(600);
    expect(r.guard.consider(r.cand({ score: T - 0.05 }))).toEqual({
      accept: false,
      reason: "below-threshold",
    });
    expect(r.guard.snapshot(r.now).counters.verifyAsked).toBe(0);
  });

  it("a transcript-sourced candidate never asks", () => {
    const r = room(ON);
    r.talk(600);
    const verdict = r.guard.consider(r.near({ source: "transcript" }));
    expect(verdict.verify).toBeUndefined();
  });

  it("a score that clears the bar is judged as before, with no verify", () => {
    const r = room(ON);
    r.talk(600);
    for (let n = 0; n < WAKE_GUARD_DEFAULTS.patienceFrames - 1; n += 1) {
      expect(r.guard.consider(r.near({ score: T + 0.1 }))).toEqual({
        accept: false,
        reason: "patience",
      });
    }
    expect(r.guard.consider(r.near({ score: T + 0.1 }))).toEqual({
      accept: true,
      reason: "accepted",
    });
  });

  it("the second look is an ordinary utterance through every gate, and is counted", () => {
    const r = room(ON);
    r.talk(600);
    expect(r.guard.consider(r.near()).verify).toBe(true);
    r.advance(800);
    expect(r.guard.consider(r.cand())).toEqual({ accept: true, reason: "accepted" });
    const counters = r.guard.snapshot(r.now).counters;
    expect([counters.verifyAsked, counters.verifyAccepted, counters.accepted]).toEqual([1, 1, 1]);
  });

  it("a second look that fails its own gates stays a refusal and is not counted as accepted", () => {
    const r = room(ON);
    r.talk(600);
    r.guard.consider(r.near());
    r.advance(500);
    const verdict = r.guard.consider(r.cand({ score: 0.2 }));
    expect(verdict).toEqual({ accept: false, reason: "below-threshold" });
    expect(r.guard.snapshot(r.now).counters.verifyAccepted).toBe(0);
  });

  it("an utterance that comes after the 1500 ms window is not credited to the verify", () => {
    const r = room(ON);
    r.talk(600);
    r.guard.consider(r.near());
    r.advance(1600);
    r.talk(400);
    expect(r.guard.consider(r.cand()).accept).toBe(true);
    expect(r.guard.snapshot(r.now).counters.verifyAccepted).toBe(0);
  });

  it("one verify, one second look: a later utterance is not credited twice", () => {
    const r = room(ON);
    r.talk(600);
    r.guard.consider(r.near());
    r.advance(300);
    r.guard.consider(r.cand({ score: 0.1 }));
    r.advance(200);
    expect(r.guard.consider(r.cand()).accept).toBe(true);
    expect(r.guard.snapshot(r.now).counters.verifyAccepted).toBe(0);
  });
});

describe("second pass: the rate cap", () => {
  it("at most one ask per 5000 ms, and another after the spacing", () => {
    const r = room(ON);
    r.talk(600);
    expect(r.guard.consider(r.near()).verify).toBe(true);
    r.advance(4000);
    expect(r.guard.consider(r.near())).toEqual({ accept: false, reason: "below-threshold" });
    r.advance(1000);
    expect(r.guard.consider(r.near()).verify).toBe(true);
    expect(r.guard.snapshot(r.now).counters.verifyAsked).toBe(2);
  });

  it("never more than 12 asks inside any minute", () => {
    const r = room(ON);
    r.talk(600);
    let asks = 0;
    const stamps: number[] = [];
    for (let n = 0; n < 40; n += 1) {
      r.advance(5000);
      if (r.guard.consider(r.near()).verify) {
        asks += 1;
        stamps.push(r.now);
      }
    }
    expect(asks).toBe(40);
    for (const at of stamps) {
      expect(stamps.filter((t) => t >= at && t < at + 60_000).length).toBeLessThanOrEqual(12);
    }
  });
});

describe("second pass: no gate is skipped", () => {
  it("locked beats verify", () => {
    const r = room(ON);
    r.talk(600);
    r.guard.forceAsleep("mute", r.now);
    expect(r.guard.consider(r.near())).toEqual({ accept: false, reason: "locked" });
    expect(r.guard.snapshot(r.now).counters.verifyAsked).toBe(0);
  });

  it("cooldown beats verify", () => {
    const r = room(ON);
    r.talk(600);
    r.guard.reportFalseWake(r.now);
    expect(r.guard.consider(r.near())).toEqual({ accept: false, reason: "cooldown" });
    expect(r.guard.snapshot(r.now).counters.verifyAsked).toBe(0);
  });

  it("self-voice beats verify", () => {
    const r = room(ON);
    r.talk(600);
    r.guard.speakStart(r.now);
    const verdict = r.guard.consider(r.near({ playbackEnergy: 0.5, ownerEnergy: 0.1 }));
    expect(verdict).toEqual({ accept: false, reason: "self-voice" });
    expect(r.guard.snapshot(r.now).counters.verifyAsked).toBe(0);
  });

  it("no speech heard beats verify", () => {
    const r = room(ON);
    r.quiet(600);
    expect(r.guard.consider(r.near())).toEqual({ accept: false, reason: "no-speech" });
    expect(r.guard.snapshot(r.now).counters.verifyAsked).toBe(0);
  });

  it("a second look cannot wake her in a cooldown, a lock or her own voice", () => {
    const r = room(ON);
    r.talk(600);
    expect(r.guard.consider(r.near()).verify).toBe(true);
    r.guard.reportFalseWake(r.now);
    r.advance(300);
    expect(r.guard.consider(r.cand())).toEqual({ accept: false, reason: "cooldown" });
    r.guard.forceAsleep("tray", r.now);
    expect(r.guard.consider(r.cand())).toEqual({ accept: false, reason: "locked" });
    expect(r.guard.snapshot(r.now).counters.verifyAccepted).toBe(0);
  });

  it("a speaker tag changes nothing about the ask", () => {
    const a = room(ON);
    a.talk(600);
    const b = room(ON);
    b.talk(600);
    expect(b.guard.consider(b.near({ speaker: "match" }))).toEqual(a.guard.consider(a.near()));
  });

  it("a music scene still raises: a score between the bar and the raised bar is room-noise", () => {
    const r = room(ON);
    r.talk(600);
    r.guard.observeScene({ kind: "music", score: 1 }, r.now);
    expect(r.guard.consider(r.near({ score: T + 0.05 }))).toEqual({
      accept: false,
      reason: "room-noise",
    });
  });

  it("hands-free stays false and a verify does not turn it on", () => {
    const r = room(ON);
    r.talk(600);
    r.guard.consider(r.near());
    expect(r.guard.handsFree).toBe(false);
    expect(r.guard.wakeRequired(r.now)).toBe(true);
  });
});

describe("ultrasonic flag: only ever tightens", () => {
  const CFG = { ultrasonicShare: 0.35 };

  it("three consecutive frames at 0.5 raise the bar by at most SCENE_BOOST_MAX for 4 s, then it decays", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(60, 0.5);
    const at = r.now;
    const raised = r.guard.consider(r.cand({ score: T + 0.05, kind: "utterance" }));
    expect(raised).toEqual({ accept: false, reason: "room-noise" });
    expect(r.guard.snapshot(r.now).counters.ultrasonic).toBe(1);
    // the hold is SCENE_HOLD_MS from the last flagged frame
    r.advance(SCENE_HOLD_MS - 100);
    expect(r.guard.consider(r.cand({ score: T + 0.05 })).reason).toBe("room-noise");
    r.advance(200);
    expect(r.guard.consider(r.cand({ score: T + 0.05 }))).toEqual({
      accept: true,
      reason: "accepted",
    });
    expect(r.now - at).toBeGreaterThan(SCENE_HOLD_MS);
  });

  it("the raise is no more than SCENE_BOOST_MAX: a score above bar + 0.15 still wakes", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(60, 0.9);
    const ok = r.guard.consider(r.cand({ score: T + SCENE_BOOST_MAX + 0.01 }));
    expect(ok).toEqual({ accept: true, reason: "accepted" });
  });

  it("a flagged room never raises more than a music scene (they do not add up)", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(60, 0.9);
    r.guard.observeScene({ kind: "music", score: 1 }, r.now);
    const ok = r.guard.consider(r.cand({ score: T + SCENE_BOOST_MAX + 0.01 }));
    expect(ok).toEqual({ accept: true, reason: "accepted" });
  });

  it("two flagged frames do nothing", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(40, 0.9);
    expect(r.guard.consider(r.cand({ score: T + 0.05 })).accept).toBe(true);
    expect(r.guard.snapshot(r.now).counters.ultrasonic).toBe(0);
  });

  it("a clean frame in between breaks the run", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(40, 0.9);
    r.talk(20, 0.01);
    r.talk(40, 0.9);
    expect(r.guard.consider(r.cand({ score: T + 0.05 })).accept).toBe(true);
    expect(r.guard.snapshot(r.now).counters.ultrasonic).toBe(0);
  });

  it("frames without highBandShare (unknown) do nothing, and break a run", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(200);
    expect(r.guard.consider(r.cand({ score: T + 0.05 })).accept).toBe(true);
    const b = room(CFG);
    b.talk(600);
    b.talk(40, 0.9);
    b.talk(20);
    b.talk(40, 0.9);
    expect(b.guard.snapshot(b.now).counters.ultrasonic).toBe(0);
  });

  it("a share just under the bar does not count, a share on it does", () => {
    const under = room(CFG);
    under.talk(600);
    under.talk(100, 0.34);
    expect(under.guard.snapshot(under.now).counters.ultrasonic).toBe(0);
    const on = room(CFG);
    on.talk(600);
    on.talk(60, 0.35);
    expect(on.guard.snapshot(on.now).counters.ultrasonic).toBe(1);
  });

  it("with ultrasonicShare 0 (off) nothing is read, whatever the frames carry", () => {
    const r = room();
    r.talk(600);
    r.talk(400, 1);
    expect(r.guard.consider(r.cand({ score: T + 0.05 })).accept).toBe(true);
    expect(r.guard.snapshot(r.now).counters.ultrasonic).toBe(0);
  });

  it("junk shares (NaN, negative, above 1) are unknown and never flag", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(100, Number.NaN);
    r.talk(100, -3);
    r.talk(100, 7);
    expect(r.guard.snapshot(r.now).counters.ultrasonic).toBe(0);
  });

  it("a flagged room never wakes, lowers a bar or approves: a weak score is still refused", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(400, 1);
    expect(r.guard.consider(r.cand({ score: T - 0.01 }))).toEqual({
      accept: false,
      reason: "below-threshold",
    });
    expect(r.guard.snapshot(r.now).state).toBe("asleep");
    expect(r.guard.snapshot(r.now).counters.accepted).toBe(0);
  });

  it("a flagged room gives no second look: a near miss is a plain refusal even with the verify on", () => {
    const r = room({ ...ON, ...CFG });
    r.talk(600);
    r.talk(60, 0.9);
    expect(r.guard.consider(r.near())).toEqual({ accept: false, reason: "below-threshold" });
    expect(r.guard.snapshot(r.now).counters.verifyAsked).toBe(0);
  });

  it("an episode counts once however long the frames run, and again after it ended", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(1000, 0.9);
    expect(r.guard.snapshot(r.now).counters.ultrasonic).toBe(1);
    r.advance(SCENE_HOLD_MS + 500);
    r.talk(600);
    r.talk(60, 0.9);
    expect(r.guard.snapshot(r.now).counters.ultrasonic).toBe(2);
  });

  it("the mic closing forgets the flag", () => {
    const r = room(CFG);
    r.talk(600);
    r.talk(60, 0.9);
    r.guard.resetAudio();
    r.talk(600);
    expect(r.guard.consider(r.cand({ score: T + 0.05 })).accept).toBe(true);
  });
});
