import { describe, expect, it } from "vitest";
import {
  FOLLOW_CHAIN_MS,
  FOLLOW_CHAIN_TURNS,
  MAX_ATTENTION_SEC,
  followUpChainAllows,
  nextChainState,
} from "../../src/lib/friday/attention-window";

const base = { turnsSinceWake: 1, lastRealWakeAt: 1_000, nowMs: 2_000, sceneActive: false };

describe("follow-up chain cap", () => {
  it("constants and the untouched setting max", () => {
    expect(FOLLOW_CHAIN_TURNS).toBe(3);
    expect(FOLLOW_CHAIN_MS).toBe(60_000);
    expect(MAX_ATTENTION_SEC).toBe(300);
  });
  it("opens early in the chain with the 8 s default", () => {
    expect(followUpChainAllows(base)).toEqual({ open: true, untilMs: 10_000, reason: "ok" });
  });
  it("turn 4 closes; exactly 3 turns closes, 2 stays open", () => {
    expect(followUpChainAllows({ ...base, turnsSinceWake: 2 }).open).toBe(true);
    expect(followUpChainAllows({ ...base, turnsSinceWake: 3 }).reason).toBe("turn-cap");
    expect(followUpChainAllows({ ...base, turnsSinceWake: 4 }).open).toBe(false);
  });
  it("61 s after the wake closes even at turn 2; exactly 60 s closes; 59.9 s open", () => {
    const at = (nowMs: number) => followUpChainAllows({ ...base, turnsSinceWake: 2, nowMs });
    expect(at(1_000 + 61_000)).toMatchObject({ open: false, reason: "time-cap" });
    expect(at(1_000 + 60_000).open).toBe(false);
    expect(at(1_000 + 59_900).open).toBe(true);
  });
  it("untilMs is capped by the 60 s ceiling and honours followMs", () => {
    expect(followUpChainAllows({ ...base, nowMs: 55_000, followMs: 20_000 }).untilMs).toBe(61_000);
    expect(followUpChainAllows({ ...base, followMs: 3_000 }).untilMs).toBe(5_000);
  });
  it("an active scene refuses", () => {
    expect(followUpChainAllows({ ...base, sceneActive: true })).toMatchObject({
      open: false,
      reason: "scene-active",
    });
  });
  it("a real wake resets the counter and the clock", () => {
    let s = { turnsSinceWake: 0, lastRealWakeAt: 1_000 };
    for (let n = 0; n < 3; n++) s = nextChainState(s, { type: "accepted-turn" });
    expect(s.turnsSinceWake).toBe(3);
    expect(followUpChainAllows({ ...base, ...s }).open).toBe(false);
    s = nextChainState(s, { type: "real-wake", atMs: 30_000 });
    expect(s).toEqual({ turnsSinceWake: 0, lastRealWakeAt: 30_000 });
    expect(followUpChainAllows({ ...base, ...s, nowMs: 31_000 }).open).toBe(true);
    expect(nextChainState(s, { type: "reset" })).toEqual({ turnsSinceWake: 0, lastRealWakeAt: 0 });
  });
  it("garbage input never throws", () => {
    const bad: unknown[] = [
      undefined,
      null,
      {},
      5,
      "x",
      { nowMs: NaN },
      { ...base, turnsSinceWake: NaN },
    ];
    for (const b of bad) {
      expect(() => followUpChainAllows(b as never)).not.toThrow();
      expect(followUpChainAllows(b as never).open).toBe(false);
      expect(() => nextChainState(b as never, b as never)).not.toThrow();
    }
    expect(followUpChainAllows({ ...base, followMs: -5 }).untilMs).toBe(10_000);
  });
});
