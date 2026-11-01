import { describe, expect, it } from "vitest";
import { pastEvidence } from "../../src/lib/friday/brain/memory-asof";
import { memory } from "../../src/lib/friday/self/memory-engine";

describe("a question about the past reaches the chat read path", () => {
  it("returns the older record with the reason it ended, and nothing for a question about now", () => {
    const old = memory.remember({
      tier: "semantic",
      title: "Launch venue zephyrquill",
      text: "The zephyrquill launch venue is the Pune hall",
      tags: [],
      source: "user",
      confidence: 1,
    });
    const fresh = memory.remember({
      tier: "semantic",
      title: "Launch venue zephyrquill v2",
      text: "The zephyrquill launch venue is the Delhi hall",
      tags: [],
      source: "user",
      confidence: 1,
    });
    expect(memory.supersede(old.id, fresh.id, "venue changed")).toBe(true);
    const created = new Date(old.createdAt);
    const month = created.toLocaleString("en-US", { month: "long" }).toLowerCase();
    const past = pastEvidence(
      `what was the zephyrquill launch venue in ${month} that I decided`,
      old.createdAt + 1000,
    );
    expect(past?.lines.join(" ")).toMatch(/Pune hall/);
    expect(past?.lines.join(" ")).toMatch(/no longer current: venue changed/);
    expect(pastEvidence("what is the zephyrquill launch venue now", Date.now())).toBeNull();
  });
});
