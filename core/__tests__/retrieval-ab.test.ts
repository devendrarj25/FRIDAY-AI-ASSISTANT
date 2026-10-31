import { describe, expect, it } from "vitest";
import {
  casesFrom,
  describeWays,
  evaluateWays,
  queryFor,
  type RetrievalWay,
} from "../../src/lib/friday/self/retrieval-ab";

describe("retrieval A/B on own memories", () => {
  it("builds a query without the title's words", () => {
    const query = queryFor(
      "Pricing quartzmoon plan",
      "The quartzmoon plan costs seven hundred rupees monthly for teams",
    );
    expect(query).not.toMatch(/quartzmoon|pricing/);
    expect(query).toMatch(/monthly|hundred|rupees|teams|costs|seven/);
    expect(queryFor("Short", "only two words")).toBeNull();
  });

  it("makes at most the asked number of cases", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      title: `Note ${i}`,
      text: `alpha beta gamma delta epsilon zeta${i} eta theta`,
    }));
    expect(casesFrom(items, 4)).toHaveLength(4);
  });

  const cases = [
    { query: "a", expectId: "1" },
    { query: "b", expectId: "2" },
    { query: "c", expectId: "3" },
    { query: "d", expectId: "4" },
  ];
  const way = (id: string, rank: RetrievalWay["rank"]): RetrievalWay => ({ id, label: id, rank });

  it("scores first place, top three and rank, and compares ways on the same cases", async () => {
    const perfect = way("perfect", async (q) => [{ a: "1", b: "2", c: "3", d: "4" }[q]!, "x"]);
    const second = way("second", async (q) => ["x", { a: "1", b: "2", c: "3", d: "4" }[q]!]);
    const results = await evaluateWays(cases, [perfect, second]);
    expect(results[0]).toMatchObject({ hit1: 4, hit3: 4, available: true });
    expect(results[1]).toMatchObject({ hit1: 0, hit3: 4 });
    expect(results[1]?.mrr).toBeCloseTo(0.5);
    expect(describeWays(results)).toMatch(/second against perfect/);
  });

  it("lists a way whose model is down as unavailable, not as a failure", async () => {
    const down = way("down", async () => null);
    const results = await evaluateWays(cases, [down]);
    expect(results[0]?.available).toBe(false);
    expect(describeWays(results)).toMatch(/not run/);
    const throws = way("throws", async () => {
      throw new Error("x");
    });
    expect((await evaluateWays(cases, [throws]))[0]?.available).toBe(false);
  });

  it("says no measurable difference when the ways agree", async () => {
    const same = async (q: string) => [{ a: "1", b: "2", c: "3", d: "4" }[q]!];
    const results = await evaluateWays(cases, [way("one", same), way("two", same)]);
    expect(describeWays(results)).toMatch(/no measurable difference/);
  });
});
