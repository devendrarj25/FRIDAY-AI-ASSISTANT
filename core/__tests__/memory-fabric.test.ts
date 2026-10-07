/**
 * Memory fabric: one engine, distinguishable kinds, real consolidation.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  classifyMemoryKind,
  memory,
  memoriesSimilar,
} from "../../src/lib/friday/self/memory-engine";
import { consolidateEvent } from "../../src/lib/friday/self/memory-consolidate";
import { considerMemory, isWorthRemembering } from "../../src/lib/friday/brain/memory-policy";

describe("memory fabric", () => {
  beforeEach(() => {
    memory.resetForTests();
  });

  it("classifies preference, failure and working kinds without a second store", () => {
    expect(classifyMemoryKind("I prefer local models whenever possible")).toBe("preference");
    expect(classifyMemoryKind("the install failed with exit 1")).toBe("failure");
    expect(classifyMemoryKind("ok")).toBe("working");
  });

  it("refuses chatter and secrets via the existing memory policy", () => {
    expect(isWorthRemembering({ text: "hi" })).toBe(false);
    expect(considerMemory({ text: "thanks" }).keep).toBe(false);
    expect(isWorthRemembering({ text: "my password: hunter2 and keep this fact" })).toBe(false);
  });

  it("consolidates the same preference phrased three ways into one record", () => {
    const phrases = [
      "I prefer local models whenever possible",
      "Always use local models, not cloud",
      "Please prefer local over paid cloud models",
    ];
    const results = phrases.map((text, index) =>
      consolidateEvent({
        text,
        source: `conversation-${index + 1}`,
        context: "chat",
      }),
    );
    expect(results.every((row) => row.kept)).toBe(true);
    expect(results.every((row) => row.kind === "preference")).toBe(true);
    const prefs = memory.getSnapshot().items.filter((item) => item.kind === "preference");
    expect(prefs).toHaveLength(1);
    expect(prefs[0]?.uses).toBeGreaterThanOrEqual(2);
    expect(prefs[0]?.source).toBeTruthy();
    expect(prefs[0]?.confidence).toBeGreaterThan(0.5);
    expect(prefs[0]?.scope).toBe("owner");
    expect(prefs[0]?.freshnessAt).toBeTruthy();
  });

  it("does not treat unrelated preferences as the same record", () => {
    expect(
      memoriesSimilar(
        { title: "local models", text: "prefer local models", kind: "preference" },
        { title: "dark mode", text: "always use dark mode", kind: "preference" },
      ),
    ).toBe(false);
    consolidateEvent({
      text: "I prefer local models whenever possible",
      source: "a",
    });
    consolidateEvent({
      text: "I always want dark mode in the editor",
      source: "b",
    });
    const prefs = memory.getSnapshot().items.filter((item) => item.kind === "preference");
    expect(prefs.length).toBeGreaterThanOrEqual(2);
  });

  it("skips chatter instead of silently storing everything", () => {
    const skipped = consolidateEvent({ text: "ok", source: "chat" });
    expect(skipped.kept).toBe(false);
    expect(skipped.stage).toBe("skip");
    expect(memory.getSnapshot().items.filter((item) => item.text === "ok")).toHaveLength(0);
  });

  it("decays stale unused working memory into archive", () => {
    const item = memory.remember({
      tier: "temporary",
      title: "scratch note",
      text: "a short-lived scratch note for decay",
      confidence: 0.12,
      kind: "short-term",
    });
    memory.update(item.id, {
      freshnessAt: Date.now() - 20 * 86_400_000,
      confidence: 0.12,
    });
    expect(memory.decayStale()).toBeGreaterThanOrEqual(1);
    expect(memory.getSnapshot().items.find((row) => row.id === item.id)?.tier).toBe("archived");
  });
});
