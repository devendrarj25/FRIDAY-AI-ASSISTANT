/**
 * Cognitive route table: existing signals, one decision, no new router.
 */
import { describe, expect, it } from "vitest";

import { classifyCognitiveRoute } from "../../src/lib/friday/brain/cognitive-route";
import { rememberSubTask } from "../../src/lib/friday/self/task-ledger";

describe("cognitive route table", () => {
  it("maps SIMPLE / HIGH-STAKES / UNKNOWN / COMPLEX / NORMAL from existing signals", () => {
    expect(classifyCognitiveRoute({ prompt: "hello how are you today", kind: "chat" }).action).toBe(
      "fast-path",
    );
    // "write" matches action-risk CONSEQUENTIAL, but chat stays off the
    // high-stakes fan-out so a haiku does not take the deep fabric.
    expect(
      classifyCognitiveRoute({ prompt: "write a haiku about rain", kind: "chat" }).action,
    ).toBe("fast-path");
    expect(
      classifyCognitiveRoute({ prompt: "delete the temp folder", kind: "system" }).action,
    ).toBe("multi-verify");
    expect(
      classifyCognitiveRoute({ prompt: "what is the latest ollama version", kind: "research" })
        .action,
    ).toBe("research");
    expect(
      classifyCognitiveRoute({ prompt: "refactor this typescript function", kind: "code" }).action,
    ).toBe("deep-reasoning");
    expect(
      classifyCognitiveRoute({ prompt: "translate this sentence", kind: "translate" }).action,
    ).toBe("best-single");
  });

  it("maps REPEATED to reuse-result only after the duplicate-work guard hits", () => {
    const prompt = "explain the unique cognitive-route reuse probe 9ef";
    expect(classifyCognitiveRoute({ prompt, kind: "chat" }).action).not.toBe("reuse-result");
    rememberSubTask({
      role: "reasoner",
      prompt,
      result: "cached explanation of the reuse probe",
      modelId: "local-test",
      success: true,
    });
    expect(classifyCognitiveRoute({ prompt, kind: "chat" }).action).toBe("reuse-result");
  });
});
