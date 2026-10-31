import { describe, expect, it } from "vitest";
import {
  fileFailurePatterns,
  mineFailurePatterns,
} from "../../src/lib/friday/self/failure-patterns";
import { governance } from "../../src/lib/friday/self/governance";
import type { TaskRecord } from "../../src/lib/friday/self/task-ledger";

const task = (
  id: string,
  error: string | undefined,
  extra: Partial<TaskRecord> = {},
): TaskRecord => ({
  id,
  key: id,
  kind: "agent",
  title: id,
  status: "failed",
  progress: 0,
  startedAt: 1_000 + Number(id.replace(/\D/g, "") || 0),
  logs: [],
  ...(error ? { error } : {}),
  ...extra,
});

describe("recurring failure patterns", () => {
  it("groups the same fault across different paths and numbers", () => {
    const patterns = mineFailurePatterns([
      task("t1", "Error: ENOENT: no such file or directory, open 'C:\\Users\\a\\x1.txt'", {
        tools: ["fs.read"],
      }),
      task("t2", "Error: ENOENT: no such file or directory, open 'C:\\Users\\b\\x2.txt'", {
        tools: ["fs.read"],
      }),
      task("t3", "Error: ENOENT: no such file or directory, open 'D:\\work\\x9.txt'", {
        models: ["m1"],
      }),
      task("t4", "TypeError: x is not a function"),
    ]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({ count: 3, kind: "agent", suggestion: "skill" });
    expect(patterns[0]?.tools).toEqual(["fs.read"]);
    expect(patterns[0]?.models).toEqual(["m1"]);
    expect(patterns[0]?.taskIds).toEqual(["t1", "t2", "t3"]);
  });

  it("does not group failures that have no error text, or tasks that did not fail", () => {
    expect(
      mineFailurePatterns([
        task("t1", undefined),
        task("t2", undefined),
        task("t3", "boom happened", { status: "done" }),
        task("t4", "boom happened", { status: "done" }),
      ]),
    ).toEqual([]);
  });

  it("keeps kinds apart and orders by how often", () => {
    const patterns = mineFailurePatterns([
      task("t1", "HTTP 429 rate limit exceeded"),
      task("t2", "HTTP 429 rate limit exceeded"),
      task("t3", "HTTP 429 rate limit exceeded"),
      task("t4", "disk full while writing", { kind: "build" }),
      task("t5", "disk full while writing", { kind: "build" }),
      task("t6", "disk full while writing", { kind: "agent" }),
    ]);
    expect(patterns.map((p) => [p.kind, p.count])).toEqual([
      ["agent", 3],
      ["build", 2],
    ]);
    expect(patterns[0]?.suggestion).toBe("routing");
    expect(mineFailurePatterns([task("t1", "a thing broke")], 1)).toEqual([]);
  });

  it("files each pattern once as a discovery that is never applied", () => {
    const patterns = mineFailurePatterns([
      task("t1", "unique-fault-zzq could not start"),
      task("t2", "unique-fault-zzq could not start"),
    ]);
    const first = fileFailurePatterns(patterns);
    expect(first[0]).toMatchObject({ queued: true, applied: false, autoApproved: false });
    expect(governance.get(first[0]!.id)?.title).toMatch(/Recurring agent failure \(2 times\)/);
    const again = fileFailurePatterns(patterns);
    expect(again[0]).toMatchObject({ queued: false, applied: false, autoApproved: false });
  });
});
