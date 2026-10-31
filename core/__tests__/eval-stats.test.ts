import { describe, expect, it } from "vitest";
import {
  brainScore,
  comparePaired,
  DOMAIN_WEIGHTS,
  fixtureHash,
  mcnemarExact,
  MIN_DOMAIN_RUNS,
  runMetrics,
  wilson,
} from "../../src/lib/friday/self/eval-stats";

describe("what a benchmark result may claim", () => {
  it("gives the Wilson interval a reader can check by hand", () => {
    const ci = wilson(8, 10);
    expect(ci.low).toBeCloseTo(0.4902, 3);
    expect(ci.high).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    const all = wilson(50, 50);
    expect(all.high).toBe(1);
    expect(all.low).toBeGreaterThan(0.9);
    expect(wilson(50, 100).high - wilson(50, 100).low).toBeLessThan(
      wilson(5, 10).high - wilson(5, 10).low,
    );
  });

  it("separates one lucky pass from reliable passing", () => {
    const metrics = runMetrics([
      [true, true, true],
      [true, false, false],
      [false, false, false],
    ]);
    expect(metrics.runs).toBe(3);
    expect(metrics.passAt1).toBeCloseTo(4 / 9, 6);
    expect(metrics.passAtK).toBeCloseTo(2 / 3, 6);
    expect(metrics.passPowK).toBeCloseTo(1 / 3, 6);
    expect(runMetrics([])).toMatchObject({ tasks: 0, passPowK: 0 });
    expect(runMetrics([[true, true], [true]]).runs).toBe(1);
  });

  it("tests a paired difference exactly", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(5, 5)).toBe(1);
    // 0 against 8: two-sided exact p = 2 * (1/2)^8
    expect(mcnemarExact(0, 8)).toBeCloseTo(2 / 256, 8);
    const a = [true, true, false, false, false, false, false, false, false, false];
    const b = [true, true, true, true, true, true, true, true, true, true];
    const result = comparePaired(a, b);
    expect(result).toMatchObject({ tasks: 10, onlyA: 0, onlyB: 8 });
    expect(result.delta).toBeCloseTo(0.8, 6);
    expect(result.p).toBeLessThan(0.01);
  });

  it("names the fixtures a result used, whatever their order", () => {
    expect(fixtureHash(["b", "a"])).toBe(fixtureHash(["a", "b"]));
    expect(fixtureHash(["a", "b"])).not.toBe(fixtureHash(["a", "c"]));
    expect(fixtureHash(["a"])).toMatch(/^[0-9a-f]{8}$/);
  });

  it("keeps the twelve domain weights at 100", () => {
    expect(Object.keys(DOMAIN_WEIGHTS)).toHaveLength(12);
    expect(Object.values(DOMAIN_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("scores only domains with enough runs and does not redistribute the rest", () => {
    const none = brainScore([{ domain: "memory", passed: 9, runs: 10 }]);
    expect(none.score).toBeNull();
    expect(none.insufficient).toEqual(["memory"]);
    expect(none.unscoredWeight).toBe(100);

    const some = brainScore([
      { domain: "memory", passed: MIN_DOMAIN_RUNS, runs: MIN_DOMAIN_RUNS },
      { domain: "agents", passed: 25, runs: 50 },
      { domain: "coding", passed: 1, runs: 3 },
      { domain: "not-a-domain", passed: 1, runs: 100 },
    ]);
    expect(some.scored).toEqual(["memory", "agents"]);
    expect(some.insufficient).toEqual(["coding"]);
    expect(some.unscoredWeight).toBe(100 - 10 - 12);
    // (10 * 1 + 12 * 0.5) / 22 = 72.7%
    expect(some.score).toBeCloseTo((100 * (10 + 6)) / 22, 6);
    expect(some.low).toBeLessThan(some.score as number);
    expect(some.high).toBeGreaterThan(some.score as number);
  });
});

import { promotionVerdict } from "../../src/lib/friday/self/eval-stats";

describe("may a learned change replace what it came from", () => {
  const ten = (passes: number) => Array.from({ length: 10 }, (_, i) => i < passes);
  it("promotes only a measured gain with no regression and no gate failure", () => {
    const base = {
      regressionBefore: ten(8),
      regressionAfter: ten(8),
      gateFailures: [] as string[],
    };
    expect(promotionVerdict({ ...base, heldBefore: ten(4), heldAfter: ten(7) })).toMatchObject({
      promote: true,
    });
    expect(promotionVerdict({ ...base, heldBefore: ten(7), heldAfter: ten(7) }).reason).toMatch(
      /no measured gain/,
    );
    expect(promotionVerdict({ ...base, heldBefore: ten(7), heldAfter: ten(5) }).reason).toMatch(
      /got worse/,
    );
    expect(promotionVerdict({ ...base, heldBefore: ten(2), heldAfter: ten(3) }).promote).toBe(true);
  });

  it("rejects on a gate failure, a regression or too little evidence", () => {
    const good = {
      heldBefore: ten(3),
      heldAfter: ten(8),
      regressionBefore: ten(8),
      regressionAfter: ten(8),
    };
    expect(promotionVerdict({ ...good, gateFailures: ["protected-file:x"] }).reason).toMatch(
      /security gate/,
    );
    const wide = Array.from({ length: 40 }, () => true);
    const worse = wide.map((_, i) => i >= 12);
    expect(
      promotionVerdict({
        ...good,
        regressionBefore: wide,
        regressionAfter: worse,
        gateFailures: [],
      }).reason,
    ).toMatch(/regression set/);
    expect(
      promotionVerdict({ ...good, heldBefore: [true], heldAfter: [true], gateFailures: [] }).reason,
    ).toMatch(/too few/);
  });
});
