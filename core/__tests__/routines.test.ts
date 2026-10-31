import { describe, expect, it } from "vitest";
import { ROUTINE_MIN_DAYS, routinesFrom } from "../../src/lib/friday/self/routines";
import type { Experience } from "../../src/lib/friday/self/task-ledger";

const NOW = new Date(2026, 9, 31, 20, 0).getTime();
const at = (daysAgo: number, hour: number) => new Date(2026, 9, 31 - daysAgo, hour, 10).getTime();
const row = (n: number, when: number, title = "Morning news summary", success = true): Experience =>
  ({
    id: `e${n}`,
    taskId: `t${n}`,
    at: when,
    title,
    success,
    verified: true,
    kind: "chat",
    tools: [],
    models: [],
  }) as unknown as Experience;

describe("routines from habit", () => {
  it("notices a task asked around the same hour on different days", () => {
    const rows = [row(1, at(1, 9)), row(2, at(2, 9)), row(3, at(4, 10)), row(4, at(5, 3), "Other")];
    const found = routinesFrom(rows, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe("Morning news summary");
    expect(found[0]?.days).toBeGreaterThanOrEqual(ROUTINE_MIN_DAYS);
    expect(found[0]?.nextAt).toBeGreaterThan(NOW);
  });

  it("does not count the same day twice or scattered hours", () => {
    expect(routinesFrom([row(1, at(1, 9)), row(2, at(1, 9)), row(3, at(1, 10))], NOW)).toHaveLength(
      0,
    );
    expect(
      routinesFrom([row(1, at(1, 6)), row(2, at(2, 13)), row(3, at(3, 22))], NOW),
    ).toHaveLength(0);
  });

  it("ignores failures, old runs and tiny titles", () => {
    expect(
      routinesFrom([row(1, at(1, 9), "x"), row(2, at(2, 9), "x"), row(3, at(3, 9), "x")], NOW),
    ).toHaveLength(0);
    expect(
      routinesFrom([row(1, at(30, 9)), row(2, at(31, 9)), row(3, at(32, 9))], NOW),
    ).toHaveLength(0);
    expect(
      routinesFrom(
        [
          row(1, at(1, 9), "Morning news summary", false),
          row(2, at(2, 9), "Morning news summary", false),
          row(3, at(3, 9), "Morning news summary", false),
        ],
        NOW,
      ),
    ).toHaveLength(0);
  });
});
