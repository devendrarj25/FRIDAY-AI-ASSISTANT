import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDecisionTraces,
  explainDecision,
  checkUncertainty,
  learningSummary,
  recordDecision,
} from "../../src/lib/friday/brain/decision-trace";
import { estimateConfidence } from "../../src/lib/friday/brain/confidence";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";

describe("FRIDAY decision trace, honest ignorance and learning status", () => {
  beforeEach(() => clearDecisionTraces());

  it("explains a real routing decision from the recorded turn", () => {
    recordDecision({
      at: Date.now(),
      mode: "manual",
      prompt: "refactor this typescript function",
      modelIds: ["qwen2.5-coder"],
      routing: "1 model(s) · coder:qwen2.5-coder · free models are preferred",
      policy: "free-preferred",
      confidence: estimateConfidence("refactor this typescript function"),
    });
    const reply = baselineRespond("why did you use that model");
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("trace");
    expect(reply.text).toMatch(/qwen2\.5-coder/);
    expect(reply.text).toMatch(/confidence/i);
    expect(reply.text).toMatch(/free/i);
  });

  it("says plainly that no decision exists rather than inventing one", () => {
    expect(explainDecision("how confident were you")).toMatch(/haven't routed/i);
  });

  it("admits it does not know and offers a real next step", () => {
    // No model is reachable in this run, so guessing is the only alternative.
    const check = checkUncertainty("who is the current mayor of Kota", {
      reachableModels: () => [],
    });
    expect(check.unknown).toBe(true);
    expect(check.steps.join(" ")).toMatch(/memory|tools|skills|model/);
    expect(check.message).toMatch(/don't know/i);
    expect(check.message).toMatch(/research|approve|Models/i);

    // With a model reachable the same question hands off instead of refusing.
    expect(checkUncertainty("who is the current mayor of Kota").unknown).toBe(false);
    expect(baselineRespond("who is the current mayor of Kota").kind).toBe("handoff");
  });

  it("reports learning from the real matrix and experience store", () => {
    const reply = baselineRespond("what have you learned recently");
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("learning");
    expect(reply.text).toBe(learningSummary());
    expect(reply.text.length).toBeGreaterThan(20);
  });
});
