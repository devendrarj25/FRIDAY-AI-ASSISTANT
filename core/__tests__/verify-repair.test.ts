import { describe, expect, it } from "vitest";
import { planRepair } from "../../src/lib/friday/brain-engine";

describe("verification → repair", () => {
  it("does not repair an answer that passed verification", () => {
    const plan = planRepair({
      verified: true,
      alreadyRepaired: false,
      candidates: ["a", "b"],
      answeredBy: "a",
    });
    expect(plan.repair).toBe(false);
  });

  it("repairs a rejected answer on a genuinely different engine", () => {
    const plan = planRepair({
      verified: false,
      alreadyRepaired: false,
      candidates: ["a", "b", "c"],
      answeredBy: "a",
    });
    expect(plan.repair).toBe(true);
    expect(plan.alternatives).toEqual(["b", "c"]);
  });

  it("never retries the same engine that already produced the bad answer", () => {
    const plan = planRepair({
      verified: false,
      alreadyRepaired: false,
      candidates: ["a"],
      answeredBy: "a",
    });
    expect(plan.repair).toBe(false);
    expect(plan.alternatives).toEqual([]);
  });

  it("repairs at most once per run, so a turn can never loop", () => {
    const plan = planRepair({
      verified: false,
      alreadyRepaired: true,
      candidates: ["a", "b"],
      answeredBy: "a",
    });
    expect(plan.repair).toBe(false);
  });
});
