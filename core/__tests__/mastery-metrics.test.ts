import { describe, expect, it } from "vitest";
import { lastUsedLabel, statsFor } from "../../src/lib/friday/self/mastery";
import type { TaskRecord } from "../../src/lib/friday/self/task-ledger";

const task = (over: Partial<TaskRecord>): TaskRecord => ({
  id: Math.random().toString(36),
  key: "skills/core/code-gen",
  kind: "skills/core/code-gen",
  title: "run",
  status: "done",
  progress: 100,
  startedAt: Date.now() - 1000,
  endedAt: Date.now(),
  logs: [],
  ...over,
});

describe("derived mastery / activity metrics", () => {
  it("reports an honest zero for a capability that never ran", () => {
    const stats = statsFor([], "skills/core/code-gen", "Code Gen");
    expect(stats.executions).toBe(0);
    expect(stats.mastery).toBe(0);
    expect(stats.level).toBe("Untrained");
    expect(lastUsedLabel(stats.lastUsedAt)).toBe("never");
  });

  it("weights success rate 0.7 and saturated volume 0.3", () => {
    const tasks = Array.from({ length: 20 }, () => task({}));
    const stats = statsFor(tasks, "skills/core/code-gen");
    expect(stats.executions).toBe(20);
    expect(stats.successRate).toBe(1);
    // 0.7 * 1 + 0.3 * 1 (volume saturates at 20 runs)
    expect(stats.mastery).toBe(100);
    expect(stats.level).toBe("Expert");
  });

  it("drops mastery when runs fail", () => {
    const tasks = [
      ...Array.from({ length: 10 }, () => task({})),
      ...Array.from({ length: 10 }, () => task({ status: "failed" })),
    ];
    const stats = statsFor(tasks, "skills/core/code-gen");
    expect(stats.failures).toBe(10);
    expect(stats.successRate).toBeCloseTo(0.5, 5);
    expect(stats.mastery).toBe(65);
    expect(stats.level).toBe("Advanced");
  });

  it("derives activity from currently running tasks only", () => {
    expect(statsFor([task({ status: "running" })], "skills/core/code-gen").activity).toBe("Medium");
    expect(
      statsFor([task({ status: "running" }), task({ status: "running" })], "skills/core/code-gen")
        .activity,
    ).toBe("High");
    expect(statsFor([task({})], "skills/core/code-gen").activity).toBe("Low");
  });

  it("ignores tasks belonging to other capabilities", () => {
    const stats = statsFor(
      [task({ kind: "tools/system/ping", key: "tools/system/ping" })],
      "skills/core/code-gen",
    );
    expect(stats.executions).toBe(0);
  });
});
