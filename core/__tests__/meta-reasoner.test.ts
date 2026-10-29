/**
 * Meta-reasoner: real next action from existing confidence / world / collaboration signals.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { reviewAssumptions, evaluateAnswer } from "../../src/lib/friday/brain/meta-reasoner";
import { understandTurn } from "../../src/lib/friday/brain/intent-engine";
import { decideAction } from "../../src/lib/friday/brain/decision-engine";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import { resetConversationSession } from "../../src/lib/friday/brain/conversation-state";
import { resetOpenLoops } from "../../src/lib/friday/brain/open-loops";

describe("meta-reasoner", () => {
  beforeEach(() => {
    resetConversationSession();
    resetOpenLoops();
  });

  it("proceeds on a simple chat turn", () => {
    const review = reviewAssumptions({ text: "write a haiku about rain" });
    expect(review.action).toBe("proceed");
  });

  it("researches live-fact prompts instead of guessing", () => {
    const review = reviewAssumptions({ text: "what is the latest ollama version" });
    expect(review.action).toBe("research");
  });

  it("asks on a bare 'it' through the existing ask path", () => {
    const understood = understandTurn({ text: "it" });
    const review = reviewAssumptions({ text: "it", intent: understood.resolvedIntent });
    expect(review.action).toBe("ask");
    const decision = decideAction({ text: "it", intent: understood.resolvedIntent });
    expect(decision.route).toBe("ask");
    expect(decision.askUser).toBe(true);
  });

  it("chooses a safer multi-model path when the owner asks for a second opinion", () => {
    const review = reviewAssumptions({ text: "give me a second opinion on this refactor" });
    expect(review.action).toBe("safer");
  });

  it("records the meta action on a real cognize pass that needs the deep fabric", async () => {
    const cognition = await coreBrain.cognize("what is the latest ollama version", {
      mode: "manual",
      allowTools: false,
    });
    expect(cognition.notes.join(" ")).toMatch(/fabric: deep/);
    expect(cognition.meta?.action).toBe("research");
    expect(cognition.notes.join(" ")).toMatch(/meta: research/);
  });

  it("skips self-evaluation on trivial chat and checks consequential answers", () => {
    expect(
      evaluateAnswer({ prompt: "hello there", answer: "Hello — what should we do?" }).ran,
    ).toBe(false);
    const miss = evaluateAnswer({
      prompt: "delete the temp folder on C",
      answer: "The weather in Jaipur is lovely today.",
    });
    expect(miss.ran).toBe(true);
    expect(miss.ok).toBe(false);
    expect(miss.issues.some((issue) => /does not address/.test(issue))).toBe(true);
    const hit = evaluateAnswer({
      prompt: "delete the temp folder on C",
      answer: "I will delete the temp folder on C after you confirm.",
      goal: "delete the temp folder on C",
    });
    expect(hit.ran).toBe(true);
    expect(hit.ok).toBe(true);
  });
});
