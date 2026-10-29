import { describe, expect, it } from "vitest";

import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  tasksLookRequested,
  shouldAttachTasksExtra,
} from "../../src/lib/friday/brain/tasks-observe";
import {
  publishTasksSession,
  formatTasksExtra,
  filterGraphs,
  resetTasksSession,
} from "../../src/lib/friday/tasks-awareness";
import type { TaskGraph } from "../../src/lib/friday/self/task-graph";

const graph = (
  patch: Partial<TaskGraph> & Pick<TaskGraph, "id" | "request" | "state">,
): TaskGraph => ({
  priority: "owner",
  createdAt: 1,
  updatedAt: 1,
  nodes: [],
  logs: [],
  ...patch,
});

describe("read-only tasks observation", () => {
  it("matches look-at-tasks asks", () => {
    expect(tasksLookRequested("look at the tasks")).toBe(true);
    expect(tasksLookRequested("what is on the tasks page")).toBe(true);
    expect(shouldAttachTasksExtra("task status")).toBe(true);
    expect(shouldAttachTasksExtra("Ab next kya?")).toBe(true);
    expect(shouldAttachTasksExtra("kya pending")).toBe(true);
    expect(shouldAttachTasksExtra("run npm test in the sandbox")).toBe(false);
    expect(tasksLookRequested("what is running")).toBe(false);
    expect(tasksLookRequested("find errors in the logs")).toBe(false);
    expect(tasksLookRequested("what's running on the tasks")).toBe(true);
  });

  it("answers a tasks look from the live session without inventing work", () => {
    resetTasksSession();
    publishTasksSession({
      desktop: true,
      runningId: "graph-1",
      graphs: [
        graph({
          id: "graph-1",
          request: "reconcile March invoices then file VAT",
          state: "running",
          nodes: [
            {
              id: "n1",
              title: "reconcile March invoices",
              instruction: "reconcile",
              kind: "goal",
              dependsOn: [],
              state: "failed",
              attempts: 2,
              maxAttempts: 2,
              error: "bank export missing",
            },
          ],
        }),
      ],
    });
    const reply = baselineRespond("look at the tasks");
    expect(reply.handled).toBe(true);
    expect(reply.resolve).toBeTypeOf("function");
    return expect(reply.resolve?.()).resolves.toMatch(/bank export missing/);
  });
});

describe("task session helpers", () => {
  it("filters live graphs and formats the shared extra", () => {
    resetTasksSession();
    const graphs = [
      graph({ id: "a", request: "open job", state: "running" }),
      graph({ id: "b", request: "old job", state: "completed" }),
    ];
    expect(filterGraphs(graphs, { filter: "live" }).map((row) => row.id)).toEqual(["a"]);
    publishTasksSession({ graphs, runningId: "a" });
    expect(formatTasksExtra()).toMatch(/TASKS SESSION/);
    expect(formatTasksExtra()).toMatch(/open job/);
  });
});
