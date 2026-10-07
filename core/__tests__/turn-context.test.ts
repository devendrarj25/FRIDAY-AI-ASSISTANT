import { describe, expect, it } from "vitest";
import { packTurnContext } from "../../src/lib/friday/brain/memory-policy";

describe("turn context", () => {
  it("keeps the full transcript and sends only the matching fact", () => {
    const transcript = Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const,
      text: `line ${index}`,
    }));
    const packed = packTurnContext({
      transcript,
      facts: [
        { id: "a", text: "supplier list lives in the ward folder", source: "user", at: 10 },
        { id: "b", text: "password is hunter2hunter2", source: "user", at: 20 },
        { id: "c", text: "the sky is blue today", source: "user", at: 30, privacy: "local" },
      ],
      ask: "where is the supplier list",
      now: 100,
      maxTurns: 4,
    });
    expect(packed.localTranscript).toHaveLength(12);
    expect(packed.forModel.turns).toHaveLength(4);
    expect(packed.forModel.turns[0]?.text).toBe("line 8");
    expect(packed.forModel.facts.map((fact) => fact.id)).toEqual(["a"]);
    expect(packed.forModel.facts[0]?.source).toBe("user");
    expect(packed.forModel.facts[0]?.ageMs).toBe(90);
    expect(packed.withheld).toEqual(expect.arrayContaining(["b", "c"]));
  });
});
