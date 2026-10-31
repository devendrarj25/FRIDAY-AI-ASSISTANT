import { beforeEach, describe, expect, it } from "vitest";
import {
  aliasesOf,
  clearEntityAliasesForTests,
  expandQuery,
  rankByRetrieval,
  registerEntityAliases,
  setReranker,
  type RankSignals,
} from "../../src/lib/friday/brain/retrieval";
import { memory, validityState } from "../../src/lib/friday/self/memory-engine";

const row = (id: string, title: string, text: string): RankSignals => ({
  id,
  title,
  text,
  updatedAt: 1,
  source: "user",
  confidence: 0.8,
});

describe("how long a fact is true", () => {
  it("separates current, ended and not-yet", () => {
    const now = 1_000;
    expect(validityState({}, now)).toBe("current");
    expect(validityState({ validFrom: 500, validUntil: 2_000 }, now)).toBe("current");
    expect(validityState({ validUntil: 1_000 }, now)).toBe("ended");
    expect(validityState({ validFrom: 1_001 }, now)).toBe("not-yet");
  });

  it("keeps an ended fact out of a current answer", () => {
    const now = Date.now();
    memory.remember({
      tier: "semantic",
      title: "Quibblex office",
      text: "The Quibblex office is in Pune.",
      validUntil: now - 1000,
    });
    memory.remember({
      tier: "semantic",
      title: "Quibblex office now",
      text: "The Quibblex office is in Jaipur.",
      validFrom: now - 500,
    });
    const hits = memory.retrieve("where is the Quibblex office", 8).map((hit) => hit.item.text);
    expect(hits.some((text) => text.includes("Jaipur"))).toBe(true);
    expect(hits.some((text) => text.includes("Pune"))).toBe(false);
  });
});

describe("entity links and the optional reranker", () => {
  beforeEach(() => {
    clearEntityAliasesForTests();
    setReranker(null);
  });

  it("learns aka links from stored text and searches under both names", () => {
    expect(
      registerEntityAliases("Devendra Singh (also known as Dev) owns FRIDAY."),
    ).toBeGreaterThan(0);
    expect(aliasesOf("dev")).toContain("devendra singh");
    expect(expandQuery("who is Dev").some((v) => /devendra singh/i.test(v))).toBe(true);
    expect(aliasesOf("nobody")).toEqual([]);
    expect(registerEntityAliases("plain sentence without links")).toBe(0);
  });

  it("finds a fact written under the other name", () => {
    registerEntityAliases("Devendra Singh aka Dev");
    const items = [
      row("a", "Ownership", "Devendra Singh owns the FRIDAY repository."),
      row("b", "Weather", "It rains in Jaipur in July."),
    ];
    const hits = rankByRetrieval(items, "who is Dev", (item) => item, { k: 2, minScore: 0.05 });
    expect(hits[0]?.item.id).toBe("a");
  });

  it("changes nothing without a reranker, and a broken one is ignored", () => {
    const items = [
      row("a", "Alpha note", "alpha beta gamma"),
      row("b", "Alpha other", "alpha beta delta"),
    ];
    const base = rankByRetrieval(items, "alpha beta", (item) => item, { k: 2, minScore: 0.05 }).map(
      (hit) => hit.item.id,
    );
    setReranker(() => {
      throw new Error("model missing");
    });
    expect(
      rankByRetrieval(items, "alpha beta", (item) => item, { k: 2, minScore: 0.05 }).map(
        (hit) => hit.item.id,
      ),
    ).toEqual(base);
    setReranker(() => [Number.NaN, 1]);
    expect(
      rankByRetrieval(items, "alpha beta", (item) => item, { k: 2, minScore: 0.05 }).map(
        (hit) => hit.item.id,
      ),
    ).toEqual(base);
  });

  it("lets a working reranker reorder the top hits", () => {
    const items = [
      row("a", "Alpha note", "alpha beta gamma"),
      row("b", "Alpha other", "alpha beta delta"),
    ];
    setReranker((_query, texts) => texts.map((text) => (text.includes("delta") ? 1 : 0)));
    const ids = rankByRetrieval(items, "alpha beta", (item) => item, { k: 2, minScore: 0.05 }).map(
      (hit) => hit.item.id,
    );
    expect(ids[0]).toBe("b");
  });
});
