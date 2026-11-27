import { describe, expect, it } from "vitest";
import {
  normalizeWakeGuardConfig,
  SCENE_HOLD_MS,
  WAKE_GUARD_DEFAULTS,
  WakeGuard,
  type WakeCandidate,
} from "../../src/lib/friday/wake-guard";
import { matchWakeWord } from "../../src/lib/friday/wake-word";

/* A fake clock and hand-fed VAD frames: no real timers, no devices. */

const T = 0.5;
const START = 100_000;

function guardWith(config: Record<string, unknown> = {}) {
  const guard = new WakeGuard(config);
  let now = START;
  let tick = 0;
  const frame = (speech: boolean) => {
    // A wobbling level reads as speech; a flat one would read as a steady hum and raise the threshold.
    const level = speech ? (tick % 2 === 0 ? 0.1 : 0.3) : 0.003;
    guard.observe({ nowMs: now, level, speech, speaking: false });
    tick += 1;
    now += 20;
  };
  return {
    guard,
    get now() {
      return now;
    },
    talk(ms: number) {
      for (let n = 0; n < ms / 20; n += 1) frame(true);
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
  };
}

const transcript = { source: "transcript", leading: true } as const;

describe("config", () => {
  it("defaults keep today's behaviour: second chance off, lead-in 300, window 1500", () => {
    expect(WAKE_GUARD_DEFAULTS.nearBand).toBe(0);
    expect(WAKE_GUARD_DEFAULTS.secondChanceMs).toBe(1500);
    expect(WAKE_GUARD_DEFAULTS.leadInMs).toBe(300);
    expect(normalizeWakeGuardConfig()).toEqual(WAKE_GUARD_DEFAULTS);
    expect(new WakeGuard().handsFree).toBe(false);
  });

  it("bounds the new keys and keeps junk at the default", () => {
    const high = normalizeWakeGuardConfig({ nearBand: 0.9, secondChanceMs: 99_999, leadInMs: 1e9 });
    expect([high.nearBand, high.secondChanceMs, high.leadInMs]).toEqual([0.2, 3000, 1500]);
    const low = normalizeWakeGuardConfig({ nearBand: -1, secondChanceMs: 1, leadInMs: 1 });
    expect([low.nearBand, low.secondChanceMs, low.leadInMs]).toEqual([0, 500, 100]);
    const junk = normalizeWakeGuardConfig({ nearBand: "x", secondChanceMs: NaN, leadInMs: null });
    expect([junk.nearBand, junk.secondChanceMs, junk.leadInMs]).toEqual([0, 1500, 300]);
  });
});

describe("matchWakeWord leading flag", () => {
  it("is true for a leading name (with a carrier), false mid-sentence or unmatched", () => {
    expect(matchWakeWord("Friday open notepad").leading).toBe(true);
    expect(matchWakeWord("hey friday").leading).toBe(true);
    expect(matchWakeWord("फ्राइडे लाइट बंद करो").leading).toBe(true);
    expect(matchWakeWord("and friday please open chrome").leading).toBe(false);
    expect(matchWakeWord("open notepad").leading).toBe(false);
    expect(matchWakeWord("").leading).toBe(false);
  });
});

describe("second chance near band", () => {
  it("refuses a near miss when the band is off and accepts it at 0.10", () => {
    const off = guardWith();
    off.talk(400);
    const refused = off.guard.consider(off.cand({ score: 0.45, ...transcript }));
    expect(refused).toEqual({ accept: false, reason: "below-threshold" });

    const on = guardWith({ nearBand: 0.1 });
    on.talk(400);
    const taken = on.guard.consider(on.cand({ score: 0.45, ...transcript }));
    expect(taken).toEqual({ accept: true, reason: "accepted" });
    expect(on.guard.snapshot(on.now).counters.secondChances).toBe(1);
    expect(on.guard.current).toBe("listening");
  });

  it("needs a leading transcript wake: a mid-sentence match or an engine frame is refused", () => {
    const g = guardWith({ nearBand: 0.1 });
    g.talk(400);
    expect(
      g.guard.consider(g.cand({ score: 0.45, source: "transcript", leading: false })).accept,
    ).toBe(false);
    expect(g.guard.consider(g.cand({ score: 0.45, source: "transcript" })).accept).toBe(false);
    expect(g.guard.consider(g.cand({ score: 0.45, kind: "frame", source: "engine" })).accept).toBe(
      false,
    );
    expect(g.guard.snapshot(g.now).counters.secondChances).toBe(0);
  });

  it("keeps an absolute floor of 0.35 under the band", () => {
    const g = guardWith({ nearBand: 0.2 });
    g.talk(400);
    const low = { threshold: 0.4, ...transcript } as const;
    expect(g.guard.consider(g.cand({ score: 0.34, ...low })).accept).toBe(false);
    expect(g.guard.consider(g.cand({ score: 0.36, ...low })).accept).toBe(true);
  });

  it("accepts a leading transcript wake that follows a recorded near-miss frame in the same utterance", () => {
    const g = guardWith({ nearBand: 0.1 });
    g.talk(400);
    const miss = g.guard.consider(g.cand({ score: 0.45, kind: "frame", source: "engine" }));
    expect(miss).toEqual({ accept: false, reason: "below-threshold" });
    g.talk(300);
    // The transcript itself scored 0 on the wake model; the frame 300 ms earlier was the near miss.
    const taken = g.guard.consider(g.cand({ score: 0, ...transcript }));
    expect(taken).toEqual({ accept: true, reason: "accepted" });
  });

  it("does not record a near miss when the band is off, and lets it expire after the window", () => {
    const off = guardWith();
    off.talk(400);
    off.guard.consider(off.cand({ score: 0.45, kind: "frame", source: "engine" }));
    expect(off.guard.consider(off.cand({ score: 0, ...transcript })).accept).toBe(false);

    const on = guardWith({ nearBand: 0.1 });
    on.talk(400);
    on.guard.consider(on.cand({ score: 0.45, kind: "frame", source: "engine" }));
    on.talk(1600);
    expect(on.guard.consider(on.cand({ score: 0, ...transcript })).accept).toBe(false);
  });

  it("does not carry a near miss into a new utterance", () => {
    const g = guardWith({ nearBand: 0.1, secondChanceMs: 3000 });
    g.talk(400);
    g.guard.consider(g.cand({ score: 0.45, kind: "frame", source: "engine" }));
    g.quiet(2200);
    g.talk(400);
    expect(g.guard.consider(g.cand({ score: 0, ...transcript })).accept).toBe(false);
  });

  it("refuses while the scene is music or TV, and takes it again once the hold ran out", () => {
    const g = guardWith({ nearBand: 0.1 });
    g.talk(400);
    g.guard.observeScene({ kind: "tv", score: 0.7 }, g.now);
    expect(g.guard.sceneActive(g.now)).toBe(true);
    expect(g.guard.consider(g.cand({ score: 0.45, ...transcript })).accept).toBe(false);
    g.advance(SCENE_HOLD_MS + 10);
    g.talk(400);
    expect(g.guard.sceneActive(g.now)).toBe(false);
    expect(g.guard.consider(g.cand({ score: 0.45, ...transcript })).accept).toBe(true);
  });

  it("refuses a different speaker, and a speaker match never rescues a weak score", () => {
    const g = guardWith({ nearBand: 0.1 });
    g.talk(400);
    expect(g.guard.consider(g.cand({ score: 0.45, speaker: "different", ...transcript }))).toEqual({
      accept: false,
      reason: "speaker-different",
    });
    expect(g.guard.consider(g.cand({ score: 0.2, speaker: "match", ...transcript })).accept).toBe(
      false,
    );
    expect(
      g.guard.consider(g.cand({ score: 0.45, speaker: "unknown", ...transcript })).accept,
    ).toBe(true);
    expect(g.guard.snapshot(g.now).counters.blocked["speaker-different"]).toBe(1);
  });

  it("allows one second chance per 10 s", () => {
    const g = guardWith({ nearBand: 0.1 });
    g.talk(400);
    expect(g.guard.consider(g.cand({ score: 0.45, ...transcript })).accept).toBe(true);
    g.talk(4000);
    expect(g.guard.consider(g.cand({ score: 0.45, ...transcript }))).toEqual({
      accept: false,
      reason: "second-chance-limit",
    });
    g.talk(6200);
    expect(g.guard.consider(g.cand({ score: 0.45, ...transcript })).accept).toBe(true);
    expect(g.guard.snapshot(g.now).counters.blocked["second-chance-limit"]).toBe(1);
  });

  it("never skips an existing gate: locked, cooldown, no speech, her own voice", () => {
    const quietRoom = guardWith({ nearBand: 0.1 });
    expect(quietRoom.guard.consider(quietRoom.cand({ score: 0.45, ...transcript })).reason).toBe(
      "no-speech",
    );

    const cooled = guardWith({ nearBand: 0.1 });
    cooled.talk(400);
    cooled.guard.reportFalseWake(cooled.now);
    expect(cooled.guard.consider(cooled.cand({ score: 0.45, ...transcript })).reason).toBe(
      "cooldown",
    );

    const locked = guardWith({ nearBand: 0.1 });
    locked.talk(400);
    locked.guard.forceAsleep("mute", locked.now);
    expect(locked.guard.consider(locked.cand({ score: 0.45, ...transcript })).reason).toBe(
      "locked",
    );

    const own = guardWith({ nearBand: 0.1 });
    own.talk(400);
    own.guard.speakStart(own.now);
    expect(
      own.guard.consider(own.cand({ score: 0.45, selfEchoText: true, ...transcript })).reason,
    ).toBe("self-voice");
  });

  it("does not use a second chance while a steady room noise has raised the threshold", () => {
    const g = guardWith({ nearBand: 0.1 });
    g.talk(WAKE_GUARD_DEFAULTS.longSpeechMs + 2000);
    expect(g.guard.snapshot(g.now).thresholdBoost).toBeGreaterThan(0);
    expect(g.guard.consider(g.cand({ score: 0.45, ...transcript })).accept).toBe(false);
  });
});

describe("transcript-only wake while a TV or music scene is on", () => {
  const tv = (g: ReturnType<typeof guardWith>) =>
    g.guard.observeScene({ kind: "tv", score: 0.7 }, g.now);

  it("is uncorroborated with a short lead-in and no probe score", () => {
    const g = guardWith();
    g.talk(400);
    tv(g);
    expect(g.guard.consider(g.cand({ ...transcript, leadInMs: 100, probeScore: null }))).toEqual({
      accept: false,
      reason: "uncorroborated",
    });
    expect(g.guard.snapshot(g.now).counters.blocked.uncorroborated).toBe(1);
  });

  it("is corroborated by a leading match with enough lead-in", () => {
    const g = guardWith();
    g.talk(400);
    tv(g);
    expect(g.guard.consider(g.cand({ ...transcript, leadInMs: 300 })).accept).toBe(true);
  });

  it("is not corroborated by a mid-sentence match, however long the lead-in", () => {
    const g = guardWith();
    g.talk(400);
    tv(g);
    const verdict = g.guard.consider(
      g.cand({ source: "personal", leading: false, leadInMs: 5000 }),
    );
    expect(verdict).toEqual({ accept: false, reason: "uncorroborated" });
  });

  it("is corroborated by a scorer reading within 0.10 of the threshold", () => {
    const g = guardWith();
    g.talk(400);
    tv(g);
    expect(
      g.guard.consider(g.cand({ source: "transcript", leading: false, probeScore: 0.3 })).reason,
    ).toBe("uncorroborated");
    expect(
      g.guard.consider(g.cand({ source: "transcript", leading: false, probeScore: 0.41 })).accept,
    ).toBe(true);
  });

  it("widens the corroboration band to nearBand when that is larger than 0.10", () => {
    const g = guardWith({ nearBand: 0.2 });
    g.talk(400);
    tv(g);
    expect(
      g.guard.consider(g.cand({ source: "transcript", leading: false, probeScore: 0.32 })).accept,
    ).toBe(true);
  });

  it("leaves a quiet room and an engine wake exactly as they were", () => {
    const quiet = guardWith();
    quiet.talk(400);
    expect(
      quiet.guard.consider(quiet.cand({ source: "transcript", leading: false, leadInMs: 0 }))
        .accept,
    ).toBe(true);

    const bare = guardWith();
    bare.talk(400);
    tv(bare);
    expect(bare.guard.consider(bare.cand()).accept).toBe(true);

    const engine = guardWith();
    engine.talk(400);
    tv(engine);
    expect(engine.guard.consider(engine.cand({ score: 0.95, source: "engine" })).accept).toBe(true);
  });

  it("only ever adds a requirement: every verdict that was a refusal stays one", () => {
    const g = guardWith();
    tv(g);
    expect(g.guard.consider(g.cand({ ...transcript, leadInMs: 900 })).reason).toBe("no-speech");
  });
});
