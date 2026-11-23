import { describe, expect, it } from "vitest";
import {
  scoreEngine,
  type ScoredSample,
} from "../../src/lib/friday/voice-engine/transcript-scorer";

const sample = (id: string, reference: string, hypothesis: string): ScoredSample => ({
  id,
  lang: "en",
  reference,
  hypothesis,
});

describe("corpus character error with a range", () => {
  const rows = [
    sample("a", "turn on the light", "turn on the lite"),
    sample("b", "what is the weather", "what is the weather"),
    sample("c", "set an alarm", "set a alarm"),
    sample("d", "call mom", "call tom"),
  ];

  it("is total character edits over total reference characters, spaces ignored", () => {
    const overall = scoreEngine(rows).overall;
    // reference letters without spaces: 14 + 16 + 10 + 7 = 47; edits: light->lite 3, none, an->a 1, mom->tom 1
    expect(overall.referenceChars).toBe(47);
    expect(overall.charEdits).toBe(5);
    expect(overall.corpusCer).toBeCloseTo(5 / 47, 10);
  });

  it("gives a seeded range around it, and none for a single sentence", () => {
    const a = scoreEngine(rows).overall;
    const b = scoreEngine(rows).overall;
    expect(a.corpusCerRange).toEqual(b.corpusCerRange);
    expect(a.corpusCerRange!.low).toBeLessThanOrEqual(a.corpusCer + 1e-9);
    expect(a.corpusCerRange!.high).toBeGreaterThanOrEqual(a.corpusCer - 1e-9);
    expect(scoreEngine(rows.slice(0, 1)).overall.corpusCerRange).toBeNull();
  });

  it("counts Hindi in characters of the normalised text (nukta folded)", () => {
    const hi: ScoredSample = {
      id: "h",
      lang: "hi",
      reference: "फ़ोन लगाओ",
      hypothesis: "फोन लगाओ",
    };
    expect(scoreEngine([hi]).overall.charEdits).toBe(0);
  });
});
