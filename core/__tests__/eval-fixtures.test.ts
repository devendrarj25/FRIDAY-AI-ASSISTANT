import { beforeEach, describe, expect, it } from "vitest";
import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import { coreBrain } from "../../src/lib/friday/brain/core-brain";
import {
  accepted,
  clearResultsForTests,
  hashFixtures,
  loadResults,
  makeRecord,
  runAblation,
  saveResult,
  validateFixtures,
  type Fixture,
} from "../../src/lib/friday/self/eval-fixtures";

const facts = Array.from({ length: 12 }, (_, i) => ({
  token: `Zorblax${i}Qwerty`,
  answer: `the ${i}th cabinet code is ${7000 + i}`,
}));

const fixtures: Fixture<{ question: string; needle: string }>[] = facts.map((fact, i) => ({
  id: `memory.recall.${i}`,
  domain: "memory",
  category: "recall",
  input: { question: `what is ${fact.token}`, needle: String(7000 + i) },
  expect: "the stored fact appears in what the model is given",
}));

describe("fixtures, results and ablation", () => {
  beforeEach(() => clearResultsForTests());

  it("rejects fixture lists a reader could not audit", () => {
    expect(validateFixtures(fixtures)).toEqual([]);
    const bad: Fixture[] = [
      { id: "a", domain: "memory", category: "x", input: 1, expect: "y" },
      { id: "a", domain: "nope" as never, category: " ", input: 1, expect: "" },
    ];
    const problems = validateFixtures(bad).join("|");
    expect(problems).toMatch(/duplicate id a/);
    expect(problems).toMatch(/unknown domain/);
    expect(problems).toMatch(/no category/);
    expect(problems).toMatch(/no expected outcome/);
    expect(hashFixtures(fixtures)).toBe(hashFixtures([...fixtures].reverse()));
  });

  it("stores results with their record and blocks acceptance when a gate failed", () => {
    const record = makeRecord({ fixtureHash: hashFixtures(fixtures), configuration: "B" });
    saveResult({ at: 1, record, domains: [], gateFailures: [], notes: [] });
    saveResult({ at: 2, record, domains: [], gateFailures: ["protected-file:x"], notes: [] });
    const rows = loadResults();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.record).toMatchObject({
      version: "1.0",
      configuration: "B",
      hardware: "unknown",
    });
    expect(accepted(rows[0]!)).toBe(true);
    expect(accepted(rows[1]!)).toBe(false);
  });

  it("measures what knowledge recall is worth by running the same turn with it off", async () => {
    for (const fact of facts) {
      brainKnowledge.remember({
        kind: "knowledge",
        title: fact.token,
        body: `${fact.token}: ${fact.answer}`,
        source: "test",
        provenance: "user",
        confidence: 0.9,
      });
    }
    const check = async (fixture: Fixture<{ question: string; needle: string }>) => {
      const cognition = await coreBrain.cognize(fixture.input.question, {
        mode: "manual",
        allowTools: false,
        useKnowledge: true,
      });
      return cognition.system.includes(fixture.input.needle);
    };
    const rows = await runAblation(
      fixtures,
      [
        "knowledge-recall",
        ["knowledge-recall", "memory-retrieve", "vector-index", "context-recall"],
        "meta-review",
      ],
      check,
    );
    // The same fact reaches the model by several paths (knowledge, memory, vector, context), so removing one alone costs nothing. That is a real
    // finding the ablation exposes, not a failure of the switch.
    const one = rows.find((row) => row.stage === "knowledge-recall")!;
    expect(one.baselinePass).toBeGreaterThanOrEqual(10);
    expect(one.verdict).toBe("no measurable effect");
    const both = rows.find(
      (row) => row.stage === "knowledge-recall+memory-retrieve+vector-index+context-recall",
    )!;
    expect(both.withoutPass).toBe(0);
    expect(both.verdict).toBe("helps");
    const meta = rows.find((row) => row.stage === "meta-review")!;
    expect(meta.delta).toBe(0);
    expect(meta.verdict).toBe("no measurable effect");
  });
});
