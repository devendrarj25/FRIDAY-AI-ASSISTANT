import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetEverywhere,
  governRecall,
  rebuildProjection,
  resetMemoryFabric,
} from "../../src/lib/friday/brain/memory-fabric";
import { memory, type MemoryItem } from "../../src/lib/friday/self/memory-engine";

const NOW = Date.UTC(2026, 5, 1);

describe("the memory engine is the authority; the fabric only projects it", () => {
  beforeEach(() => {
    memory.resetForTests();
    resetMemoryFabric();
  });

  it("rebuilding the projection is pure: same input, same output, engine untouched", () => {
    const a = memory.remember({ tier: "semantic", title: "Plan A", text: "Plan A ships in June." });
    const before = JSON.stringify(memory.getSnapshot().items);
    const items = memory.getSnapshot().items;
    const first = rebuildProjection(items, NOW);
    const second = rebuildProjection(items, NOW);
    expect(second).toEqual(first);
    expect(first.records.map((row) => row.id)).toContain(a.id);
    expect(JSON.stringify(memory.getSnapshot().items)).toBe(before);
    resetMemoryFabric();
    expect(JSON.stringify(memory.getSnapshot().items)).toBe(before);
  });

  it("leaves an ended or superseded fact out of the projection but still stored", () => {
    const ended = memory.remember({
      tier: "semantic",
      title: "Office city",
      text: "The office is in Pune.",
      validUntil: NOW - 1,
    });
    const live = memory.remember({
      tier: "semantic",
      title: "Team size",
      text: "The team has six people.",
    });
    const out = rebuildProjection(memory.getSnapshot().items, NOW);
    expect(out.omitted).toContain(ended.id);
    expect(out.records.map((row) => row.id)).toContain(live.id);
    expect(out.records.map((row) => row.id)).not.toContain(ended.id);
    expect(memory.getSnapshot().items.some((item) => item.id === ended.id)).toBe(true);
  });

  it("will not admit a projection hit for a record that was deleted", () => {
    const doomed = memory.remember({
      tier: "semantic",
      title: "Door code",
      text: "The door code is 4821.",
    });
    const stale: MemoryItem = { ...doomed };
    expect(forgetEverywhere(doomed.id).removed).toBe(true);
    const result = governRecall({
      prompt: "what is the door code",
      hits: [{ item: stale, score: 0.9 }],
      now: NOW,
    });
    expect(result.admitted.map((hit) => hit.item.id)).not.toContain(doomed.id);
    expect(result.withheld).toContainEqual({ id: doomed.id, reason: "deleted" });
  });

  it("answers a current question without an ended fact and a past question with it", () => {
    const ended = memory.remember({
      tier: "semantic",
      title: "Office city",
      text: "The office city is Pune.",
      validUntil: NOW - 1,
      source: "user",
      verified: true,
    });
    const hit = { item: ended, score: 0.8 };
    const current = governRecall({
      prompt: "what is the office city",
      hits: [hit],
      archive: [ended],
      now: NOW,
    });
    expect(current.admitted.map((row) => row.item.id)).not.toContain(ended.id);
    const past = governRecall({
      prompt: "what was the office city before",
      hits: [],
      archive: [ended],
      now: NOW,
    });
    expect(past.admitted.map((row) => row.item.id)).toContain(ended.id);
  });
});
