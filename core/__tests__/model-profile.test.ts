/** A model is ranked on what it has done, and "not measured" ranks as before. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_COMPARE_TASKS,
  clearProfilesForTests,
  compareOf,
  profileOf,
  rankScore,
  recordCompare,
} from "../../src/lib/friday/brain/model-profile";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";

describe("profileOf", () => {
  beforeEach(() => clearProfilesForTests());

  it("is not measured with no runs, and scores zero", () => {
    const profile = profileOf("m", {});
    expect(profile).toMatchObject({
      measured: false,
      passRate: null,
      avgMs: null,
      rulesKept: null,
    });
    expect(rankScore(profile)).toBe(0);
  });

  it("ignores a single run, so one lucky answer cannot rank a model", () => {
    const profile = profileOf("m", { "code|m": { runs: 1, ok: 1, ms: 100 } });
    expect(profile.passRate).toBeNull();
    expect(profile.measured).toBe(false);
  });

  it("sums a model across task kinds and weights the time by runs", () => {
    const profile = profileOf("m", {
      "code|m": { runs: 3, ok: 3, ms: 1000 },
      "chat|m": { runs: 1, ok: 0, ms: 2000 },
      "code|other": { runs: 9, ok: 9, ms: 5 },
    });
    expect(profile.runs).toBe(4);
    expect(profile.passRate).toBe(0.75);
    expect(profile.avgMs).toBe(1250);
  });

  it("adds a Compare result only when enough tasks were asked", () => {
    recordCompare("m", { tasks: 5, bare: 5, loop: 5, calls: 5 });
    expect(profileOf("m", {}).rulesKept).toBeNull();
    recordCompare("m", { tasks: MIN_COMPARE_TASKS * 2, bare: 10, loop: 16, calls: 40 });
    const profile = profileOf("m", {});
    expect(profile).toMatchObject({ rulesKept: 0.5, rulesKeptWithLoop: 0.8, measured: true });
    expect(compareOf("m")?.calls).toBe(40);
  });

  it("scores a faster, better model above a slower, worse one", () => {
    const good = profileOf("a", { "x|a": { runs: 10, ok: 9, ms: 800 } });
    const poor = profileOf("b", { "x|b": { runs: 10, ok: 5, ms: 800 } });
    const slow = profileOf("c", { "x|c": { runs: 10, ok: 9, ms: 90_000 } });
    expect(rankScore(good)).toBeGreaterThan(rankScore(poor));
    expect(rankScore(good)).toBeGreaterThan(rankScore(slow));
  });
});

describe("the brain's model preference", () => {
  beforeEach(() => clearProfilesForTests());

  it("keeps the given order for models with no record", () => {
    expect(coreBrain.preferred("zz-unmeasured-kind", ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("lets a Compare result break a tie between two unmeasured-on-live models", () => {
    recordCompare("kept", { tasks: 20, bare: 19, loop: 20, calls: 20 });
    recordCompare("missed", { tasks: 20, bare: 3, loop: 12, calls: 40 });
    expect(coreBrain.preferred("zz-compare-kind", ["missed", "kept"])).toEqual(["kept", "missed"]);
  });
});
