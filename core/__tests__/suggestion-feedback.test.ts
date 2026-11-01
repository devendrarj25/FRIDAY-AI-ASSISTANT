import { beforeEach, describe, expect, it } from "vitest";
import {
  MUTE_AFTER,
  MUTE_FOR_MS,
  familyOf,
  mayOffer,
  noteDecision,
  resetSuggestionFeedbackForTests,
} from "../../src/lib/friday/self/suggestion-feedback";
import { governance } from "../../src/lib/friday/self/governance";

describe("what the owner does with her suggestions", () => {
  beforeEach(() => resetSuggestionFeedbackForTests());

  it("recognises the kinds of suggestion she makes on her own, and nothing else", () => {
    expect(familyOf("routine-morning-news")).toBe("routine");
    expect(familyOf("dream-extract-summarise")).toBe("dream");
    expect(familyOf("anything", "Practise: parsing")).toBe("practice");
    expect(familyOf("gov-1", "Install Ollama")).toBeNull();
  });

  it("goes quiet for two weeks after three declines in a row, and one yes clears the count", () => {
    const t0 = 1_000;
    for (let i = 0; i < MUTE_AFTER - 1; i += 1) noteDecision("routine", false, t0);
    expect(mayOffer("routine", t0)).toBe(true);
    noteDecision("routine", true, t0);
    noteDecision("routine", false, t0);
    noteDecision("routine", false, t0);
    expect(mayOffer("routine", t0)).toBe(true);
    noteDecision("routine", false, t0);
    expect(mayOffer("routine", t0 + 1)).toBe(false);
    expect(mayOffer("dream", t0 + 1)).toBe(true);
    expect(mayOffer("routine", t0 + MUTE_FOR_MS + 1)).toBe(true);
  });

  it("is fed by the owner's real decision in the approval gate", async () => {
    governance.resetForTests();
    for (let i = 0; i < MUTE_AFTER; i += 1) {
      const pending = governance.submit({
        id: `routine-test-${i}`,
        kind: "research",
        title: "Routine: x",
        rationale: "r",
        risk: "review",
        apply: async () => ({ ok: true, detail: "done" }),
      });
      await new Promise((r) => setTimeout(r, 0));
      governance.reject(`routine-test-${i}`);
      await pending;
    }
    expect(mayOffer("routine")).toBe(false);
  });
});
