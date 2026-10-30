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

  it("asks the only engine once more when a counted or parsed rule was broken", () => {
    const plan = planRepair({
      verified: false,
      alreadyRepaired: false,
      candidates: ["a"],
      answeredBy: "a",
      deterministic: true,
    });
    expect(plan).toEqual({ repair: true, alternatives: ["a"], sameEngine: true });
  });

  it("prefers a different engine to the same one, and still repairs only once", () => {
    const first = planRepair({
      verified: false,
      alreadyRepaired: false,
      candidates: ["a", "b"],
      answeredBy: "a",
      deterministic: true,
    });
    expect(first).toMatchObject({ repair: true, alternatives: ["b"], sameEngine: false });
    const again = planRepair({
      verified: false,
      alreadyRepaired: true,
      candidates: ["a"],
      answeredBy: "a",
      deterministic: true,
    });
    expect(again.repair).toBe(false);
  });

  it("has nothing to retry when no engine is known", () => {
    const plan = planRepair({
      verified: false,
      alreadyRepaired: false,
      candidates: [],
      answeredBy: null,
      deterministic: true,
    });
    expect(plan.repair).toBe(false);
  });
});

describe("how hard a steerable model is asked to think", () => {
  it("scales with the kind of ask", async () => {
    const { reasoningEffortFor } = await import("../../src/lib/friday/brain/cognitive-route");
    expect(reasoningEffortFor("fast-path")).toBe("low");
    expect(reasoningEffortFor("reuse-result")).toBe("low");
    expect(reasoningEffortFor("best-single")).toBe("medium");
    expect(reasoningEffortFor("best-single", "metacognitive")).toBe("high");
    expect(reasoningEffortFor("best-single", "fast")).toBe("low");
    expect(reasoningEffortFor("deep-reasoning")).toBe("high");
    expect(reasoningEffortFor("multi-verify", "fast")).toBe("high");
    expect(reasoningEffortFor("research")).toBe("medium");
  });

  it("is carried on the cognition of a real turn", async () => {
    const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
    const hello = await coreBrain.cognize("hello", { mode: "manual", allowTools: false });
    expect(hello.reasoningEffort).toBe("low");
    const hard = await coreBrain.cognize(
      "Compare the trade-offs of three database designs for an offline-first app and explain why one is safest",
      { mode: "manual", allowTools: false },
    );
    expect(["medium", "high"]).toContain(hard.reasoningEffort);
  });
});
