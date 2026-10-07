import { describe, expect, it } from "vitest";
import {
  packTurnContext,
  profileFacts,
  redactForExport,
} from "../../src/lib/friday/brain/memory-policy";

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

  it("sends a profile fact with unknown age and blanks a secret on export", () => {
    const facts = profileFacts({
      preferredName: "Asha",
      notes: "password is hunter2hunter2",
    });
    const packed = packTurnContext({
      transcript: [],
      facts,
      ask: "what is my name",
      now: 500,
    });
    expect(packed.forModel.facts.map((fact) => fact.id)).toEqual(["profile:name"]);
    expect(packed.forModel.facts[0]?.source).toBe("profile");
    expect(packed.forModel.facts[0]?.ageMs).toBeNull();
    expect(packed.withheld).toContain("profile:notes");
    const exported = redactForExport(
      [
        {
          title: "login",
          text: "password is hunter2hunter2",
          source: "user",
          createdAt: 100,
        },
      ],
      250,
    );
    expect(exported[0]?.text).toBe("");
    expect(exported[0]?.title).toBe("withheld");
    expect(exported[0]?.source).toBe("user");
    expect(exported[0]?.ageMs).toBe(150);
    expect(JSON.stringify(exported)).not.toContain("hunter2");
  });
});
