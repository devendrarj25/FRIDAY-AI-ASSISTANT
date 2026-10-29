import { describe, expect, it, beforeEach } from "vitest";
import { affect } from "../../src/lib/friday/brain/affect";
import { classifyPriority, orderByPriority } from "../../src/lib/friday/brain/priority";

describe("FRIDAY affect engine", () => {
  beforeEach(() => {
    // Decay the state back to neutral between assertions.
    for (let i = 0; i < 12; i += 1) affect.observePrompt("ok");
  });

  it("reads urgency and frustration from what the owner actually wrote", () => {
    const state = affect.observePrompt("this is STILL not working, fix it immediately!!");
    expect(state.user.urgency).toBeGreaterThan(0.3);
    expect(state.user.frustration).toBeGreaterThan(0.3);
    expect(["concerned", "focused", "frustrated", "empathetic"]).toContain(state.mood);
  });

  it("never claims human feelings in the compiled fragment", () => {
    affect.observePrompt("why is the build failing?");
    const prompt = affect.prompt();
    expect(prompt).toMatch(/simulated/i);
    expect(prompt).toMatch(/never claim to have human feelings/i);
  });

  it("moves on real outcomes, not claimed ones", () => {
    const failed = affect.observeOutcome({ ok: false });
    expect(failed.failures).toBe(1);
    const ok = affect.observeOutcome({ ok: true });
    expect(ok.failures).toBe(0);
    expect(ok.streak).toBe(1);
  });
});

describe("FRIDAY priority engine", () => {
  it("treats a crash as critical and small talk as optional", () => {
    expect(classifyPriority({ text: "the installer crashed on launch" }).priority).toBe("critical");
    expect(classifyPriority({ text: "hi" }).priority).toBe("optional");
  });

  it("keeps deferrable background work out of the way", () => {
    const verdict = classifyPriority({ text: "index old logs sometime", background: true });
    expect(verdict.deferrable).toBe(true);
    expect(verdict.mayInterrupt).toBe(false);
  });

  it("orders a queue by priority then age", () => {
    const ordered = orderByPriority([
      { priority: "optional" as const, createdAt: 1 },
      { priority: "critical" as const, createdAt: 5 },
      { priority: "important" as const, createdAt: 3 },
    ]);
    expect(ordered.map((entry) => entry.priority)).toEqual(["critical", "important", "optional"]);
  });
});
