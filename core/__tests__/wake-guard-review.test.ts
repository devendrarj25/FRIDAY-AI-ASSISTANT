/**
 * Review fixes for the hands-free wake gate: a reply that never reported its end must not lock the owner out,
 * and the speech heard before a wake is the sum of the runs of one utterance, not the longest single run.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeWakeGuardConfig,
  WAKE_GUARD_DEFAULTS,
  WakeGuard,
} from "../../src/lib/friday/wake-guard";

const feed = (guard: WakeGuard, from: number, ms: number, speech: boolean) => {
  for (let t = from; t < from + ms; t += 10) {
    guard.observe({ nowMs: t, level: speech ? 0.3 : 0, speech, speaking: false });
  }
  return from + ms;
};

const wake = (nowMs: number, extra: Record<string, unknown> = {}) => ({
  nowMs,
  score: 1,
  threshold: 0.5,
  kind: "utterance" as const,
  ...extra,
});

describe("a reply that never reported its end cannot lock the owner out", () => {
  it("speakStart with no speakEnd: 30 s later a wake utterance passes, even with no owner energy reading", () => {
    const guard = new WakeGuard();
    guard.speakStart(1000);
    const t = feed(guard, 31_000, 400, true);
    const verdict = guard.consider(wake(t));
    expect(verdict).toEqual({ accept: true, reason: "accepted" });
    expect(guard.snapshot(t).state).toBe("listening");
  });

  it("while the reply is really inside its window her own voice still blocks", () => {
    const guard = new WakeGuard();
    guard.speakStart(1000);
    const t = feed(guard, 2000, 400, true);
    expect(guard.consider(wake(t)).reason).toBe("self-voice");
  });

  it("the window is a bounded setting (5 s to 120 s) with a default under 30 s", () => {
    expect(WAKE_GUARD_DEFAULTS.speakMaxMs).toBeLessThan(30_000);
    expect(normalizeWakeGuardConfig({ speakMaxMs: 1 }).speakMaxMs).toBe(5000);
    expect(normalizeWakeGuardConfig({ speakMaxMs: 9e9 }).speakMaxMs).toBe(120_000);
  });

  it("a second speakStart (the next clause) renews the window", () => {
    const guard = new WakeGuard();
    guard.speakStart(0);
    guard.speakStart(15_000);
    expect(guard.speakingNow(30_000)).toBe(true);
    expect(
      guard.speakingNow(
        15_000 + WAKE_GUARD_DEFAULTS.speakMaxMs + WAKE_GUARD_DEFAULTS.speakTailMs + 50,
      ),
    ).toBe(false);
  });
});

describe("speech before a wake is the sum of the runs of one utterance", () => {
  it("three short runs of 120 ms with pauses are about 360 ms of speech, enough for a 240 ms minimum", () => {
    const guard = new WakeGuard();
    let t = feed(guard, 1000, 120, true);
    t = feed(guard, t, 300, false);
    t = feed(guard, t, 120, true);
    t = feed(guard, t, 300, false);
    t = feed(guard, t, 120, true);
    t = feed(guard, t, 300, false);
    expect(guard.speechHeardMs(t)).toBeGreaterThanOrEqual(300);
    expect(guard.consider(wake(t, { ownerEnergy: 0.3 })).accept).toBe(true);
  });

  it("'Friday ... ok': a run of 500 ms then one of 200 ms still counts as 700 ms", () => {
    const guard = new WakeGuard();
    let t = feed(guard, 1000, 500, true);
    t = feed(guard, t, 400, false);
    t = feed(guard, t, 200, true);
    expect(guard.speechHeardMs(t)).toBeGreaterThanOrEqual(650);
  });

  it("a new utterance after a long pause starts the count again", () => {
    const guard = new WakeGuard();
    let t = feed(guard, 1000, 500, true);
    t = feed(guard, t, 3000, false);
    t = feed(guard, t, 100, true);
    expect(guard.speechHeardMs(t)).toBeLessThan(200);
  });

  it("speech older than the recency window no longer backs a wake", () => {
    const guard = new WakeGuard();
    let t = feed(guard, 1000, 500, true);
    t = feed(guard, t, 6000, false);
    expect(guard.speechHeardMs(t)).toBe(0);
    expect(guard.consider(wake(t, { ownerEnergy: 0.3 })).reason).toBe("no-speech");
  });
});
