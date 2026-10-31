import { describe, expect, it } from "vitest";
import { blendEmbeddingScores, type VectorHit } from "../../src/lib/friday/brain/vector-index";

const hit = (title: string, score: number): VectorHit => ({
  kind: "note",
  title,
  snippet: title,
  score,
});

describe("embedding reorder", () => {
  it("lets a clearly closer meaning overtake a slightly better index score", () => {
    const out = blendEmbeddingScores([hit("a", 1), hit("b", 0.8)], [0.1, 0.9]);
    expect(out.map((row) => row.title)).toEqual(["b", "a"]);
  });

  it("keeps the order when the similarities agree", () => {
    const out = blendEmbeddingScores([hit("a", 1), hit("b", 0.5)], [0.9, 0.2]);
    expect(out.map((row) => row.title)).toEqual(["a", "b"]);
  });

  it("leaves the list alone when the counts do not match", () => {
    const rows = [hit("a", 1), hit("b", 0.5)];
    expect(blendEmbeddingScores(rows, [0.5])).toBe(rows);
  });

  it("is wired to the model assigned to Embedding", async () => {
    const { vectorIndex } = await import("../../src/lib/friday/brain/vector-index");
    await import("../../src/lib/friday/models-engine");
    expect(vectorIndex.embeddingModelProvider()).toBe("bge-m3");
  });
});

describe("judge model chosen for one comparison", () => {
  it("the comparison way uses the chosen model, not the routing assignment", async () => {
    const { realWays } = await import("../../src/lib/friday/self/retrieval-ab-run");
    const ways = realWays("tiny-judge");
    const judge = ways.find((way) => way.id === "judge")!;
    expect(judge.label).toContain("tiny-judge");
    expect(realWays().find((way) => way.id === "judge")!.label).toBe(
      "hashed vectors + rerank judge",
    );
    // With no kernel connected the hashed list is empty, so the way reports itself as not run rather than failing.
    expect(await judge.rank("anything")).toBeNull();
  });
});
