import { describe, expect, it } from "vitest";
import { asOfWindow, memory, trueDuring } from "../../src/lib/friday/self/memory-engine";

const at = (y: number, m: number, d = 15) => new Date(y, m, d).getTime();

describe("memory as of a past time", () => {
  const now = at(2026, 9, 31);

  it("reads a question about the past as a window", () => {
    const june = asOfWindow("What did I decide in June about the pricing plan?", now);
    expect(june?.from).toBe(at(2026, 5, 1));
    expect(june && june.to < at(2026, 6, 1)).toBe(true);
    expect(asOfWindow("pichhle mahine kya tay hua tha", now)?.label).toBe("last month");
    expect(asOfWindow("what was the plan in 2024 as of then", now)?.label).toBe("2024");
  });

  it("leaves a question about now alone", () => {
    expect(asOfWindow("what is my plan this week", now)).toBeNull();
    expect(asOfWindow("remind me in june to renew", now)).toBeNull();
  });

  it("knows a replaced record was true before its end", () => {
    const old = { createdAt: at(2026, 0), supersededAt: at(2026, 7), validUntil: at(2026, 7) };
    expect(trueDuring(old, { from: at(2026, 5, 1), to: at(2026, 5, 30) })).toBe(true);
    expect(trueDuring(old, { from: at(2026, 8, 1), to: at(2026, 8, 30) })).toBe(false);
  });

  it("keeps why a record ended and still finds it for the past", () => {
    const old = memory.remember({
      tier: "semantic",
      title: "Pricing quartzmoon plan",
      text: "The quartzmoon plan costs 500 per month",
      tags: [],
      source: "user",
      confidence: 1,
    });
    const fresh = memory.remember({
      tier: "semantic",
      title: "Pricing quartzmoon plan v2",
      text: "The quartzmoon plan costs 700 per month",
      tags: [],
      source: "user",
      confidence: 1,
    });
    expect(memory.supersede(old.id, fresh.id, "price changed")).toBe(true);
    const stored = memory.getSnapshot().items.find((row) => row.id === old.id);
    expect(stored?.invalidReason).toBe("price changed");
    expect(stored?.validUntil).toBeTypeOf("number");
    const before = { from: old.createdAt - 1000, to: old.createdAt + 1 };
    const hits = memory.retrieveAsOf("quartzmoon plan price", before, 5);
    expect(hits.some((hit) => hit.item.id === old.id)).toBe(true);
    expect(memory.retrieve("quartzmoon plan price", 5).some((hit) => hit.item.id === old.id)).toBe(
      false,
    );
  });
});
