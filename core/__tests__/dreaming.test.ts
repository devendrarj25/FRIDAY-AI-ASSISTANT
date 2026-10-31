import { describe, expect, it } from "vitest";
import { DREAM_MIN_RUNS, dreamsFrom } from "../../src/lib/friday/self/dreaming";
import type { Experience } from "../../src/lib/friday/self/task-ledger";

const NOW = Date.UTC(2026, 9, 31);
const row = (n: number, over: Partial<Experience> = {}): Experience =>
  ({
    id: `e${n}`,
    taskId: `t${n}`,
    at: NOW - n * 3600_000,
    kind: "chat",
    title: "Summarise a PDF",
    approach: "extract→summarise",
    domains: [],
    models: [{ id: "local-a", kind: "local" }],
    tools: ["fs.extract"],
    attempted: "",
    success: true,
    verified: true,
    ms: 10,
    ...over,
  }) as Experience;

describe("dreaming pass", () => {
  it("proposes an approach that recurred and was verified", () => {
    const dreams = dreamsFrom([row(1), row(2), row(3)], NOW);
    expect(dreams).toHaveLength(1);
    expect(dreams[0]?.count).toBe(3);
    expect(dreams[0]?.tools).toEqual(["fs.extract"]);
  });

  it("needs enough runs, and only checked successes", () => {
    expect(DREAM_MIN_RUNS).toBe(3);
    expect(dreamsFrom([row(1), row(2)], NOW)).toHaveLength(0);
    expect(dreamsFrom([row(1), row(2), row(3, { verified: false })], NOW)).toHaveLength(0);
    expect(dreamsFrom([row(1), row(2), row(3, { success: false })], NOW)).toHaveLength(0);
  });

  it("ignores runs outside the window", () => {
    const old = (n: number) => row(n, { at: NOW - 30 * 24 * 3600_000 });
    expect(dreamsFrom([old(1), old(2), old(3)], NOW)).toHaveLength(0);
  });
});
