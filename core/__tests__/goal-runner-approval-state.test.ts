/**
 * The "goal" runner reads what the kernel task really ended as (task.run returns {done, state, taskId,
 * pendingApproval}). A planner stopped at an approval gate is not a finished subtask: the node waits, the owner is
 * asked through the Tasks approvals (and the spoken yes of the voice desk), and the answer goes to the same kernel
 * task. It never starts a second kernel task for the same step, and a cancelled graph cancels its kernel task.
 * No kernel runs: the bridge is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import kernelApi from "../../src/lib/friday/kernel-api";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { ledger } from "../../src/lib/friday/self/task-ledger";
import { resetTaskGraphStore, taskGraph } from "../../src/lib/friday/self/task-graph";
import {
  configureTaskRunners,
  mapKernelOutcome,
  registerTaskRunners,
} from "../../src/lib/friday/self/task-runners";

const g = globalThis as unknown as { window?: { friday?: Record<string, unknown> } };
g.window ??= globalThis as never;

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await tick();
  }
}

const WAITING = {
  done: false,
  state: "waiting-approval",
  taskId: "k-1",
  results: [],
  events: 4,
  pendingApproval: { stepId: "s2", tool: "fs.write", risk: "write", args: { path: "notes.txt" } },
};
const DONE = {
  done: true,
  state: "done",
  taskId: "k-1",
  results: [{ stepId: "s1" }, { stepId: "s2" }],
  events: 6,
};

let runCalls = 0;
let approveCalls: Array<[string, string, boolean]> = [];
let cancelCalls: string[] = [];

beforeEach(() => {
  resetTaskGraphStore();
  autonomy.reset();
  for (const graph of taskGraph.list()) taskGraph.cancel(graph.id);
  taskGraph.clearFinished();
  runCalls = 0;
  approveCalls = [];
  cancelCalls = [];
  g.window!.friday = {};
  vi.spyOn(kernelApi.tasks, "run").mockImplementation((async () => {
    runCalls += 1;
    return WAITING;
  }) as never);
  vi.spyOn(kernelApi.tasks, "approve").mockImplementation((async (
    taskId: string,
    stepId: string,
    allow: boolean,
  ) => {
    approveCalls.push([taskId, stepId, allow]);
    return allow
      ? { ok: true, resumed: true, ...DONE }
      : { ok: true, resumed: true, done: false, state: "cancelled", taskId };
  }) as never);
  vi.spyOn(kernelApi.tasks, "cancel").mockImplementation((async (taskId: string) => {
    cancelCalls.push(taskId);
    return { ok: true, taskId, state: "cancelled" };
  }) as never);
  vi.spyOn(kernelApi.tasks, "pending").mockResolvedValue({ tasks: [] } as never);
  configureTaskRunners({ approvalWaitMs: 60_000 });
  registerTaskRunners();
});

afterEach(() => {
  for (const row of [...ledger.getSnapshot().approvals]) ledger.answerApproval(row.taskId, false);
  for (const graph of taskGraph.list()) taskGraph.cancel(graph.id);
  autonomy.reset();
  vi.restoreAllMocks();
  delete g.window!.friday;
});

describe("mapKernelOutcome reads the task's real end state", () => {
  it("waiting-approval is not ok and waits; only done is checked", () => {
    expect(mapKernelOutcome("save notes", WAITING)).toMatchObject({
      ok: false,
      waiting: true,
      checked: false,
      kernelTaskId: "k-1",
      pendingApproval: { stepId: "s2", tool: "fs.write", risk: "write" },
    });
    expect(mapKernelOutcome("save notes", DONE)).toMatchObject({ ok: true, checked: true });
    for (const state of ["failed", "cancelled"]) {
      const mapped = mapKernelOutcome("save notes", { done: false, state, taskId: "k-1" });
      expect(mapped.ok, state).toBe(false);
      expect(mapped.waiting, state).toBeFalsy();
      expect(mapped.checked, state).toBe(false);
    }
    expect(mapKernelOutcome("save notes", null).ok).toBe(false);
  });
});

describe("a kernel task stopped at an approval gate", () => {
  it("does not mark the graph completed, asks the owner, and starts no second kernel task", async () => {
    const { id } = taskGraph.submit("Write the notes file for the meeting", {
      nodes: [{ title: "write notes", instruction: "write notes.txt" }],
    });
    await until(() => ledger.getSnapshot().approvals.length > 0);
    const graph = taskGraph.get(id)!;
    expect(graph.state).not.toBe("completed");
    expect(runCalls).toBe(1);
    expect(ledger.getSnapshot().approvals[0]?.question).toMatch(/fs\.write/);
  });

  it("the owner's yes reaches the same kernel task, and the graph completes from its result", async () => {
    const { id } = taskGraph.submit("Write the notes file for the meeting", {
      nodes: [{ title: "write notes", instruction: "write notes.txt" }],
    });
    await until(() => ledger.getSnapshot().approvals.length > 0);
    ledger.answerApproval(ledger.getSnapshot().approvals[0]!.taskId, true);
    await until(() => taskGraph.get(id)?.state === "completed");
    expect(approveCalls).toEqual([["k-1", "s2", true]]);
    expect(runCalls).toBe(1);
    expect(taskGraph.get(id)!.nodes[0]!.checkpoint?.checked).toBe(true);
  });

  it("the owner's no denies the step and cancels the graph; it is never retried", async () => {
    const { id } = taskGraph.submit("Write the notes file for the meeting", {
      nodes: [{ title: "write notes", instruction: "write notes.txt" }],
    });
    await until(() => ledger.getSnapshot().approvals.length > 0);
    ledger.answerApproval(ledger.getSnapshot().approvals[0]!.taskId, false);
    await until(() => taskGraph.get(id)?.state === "cancelled");
    expect(approveCalls).toEqual([["k-1", "s2", false]]);
    expect(taskGraph.get(id)!.state).toBe("cancelled");
    await tick();
    expect(runCalls).toBe(1);
  });

  it("no answer in time leaves the node waiting; cancelling the graph then cancels the kernel task", async () => {
    configureTaskRunners({ approvalWaitMs: 20 });
    const { id } = taskGraph.submit("Write the notes file for the meeting", {
      nodes: [{ title: "write notes", instruction: "write notes.txt" }],
    });
    await until(() => taskGraph.get(id)?.state === "paused");
    const node = taskGraph.get(id)!.nodes[0]!;
    expect(node.state).toBe("waiting");
    expect(node.checkpoint?.kernelTaskId).toBe("k-1");
    taskGraph.cancel(id);
    await until(() => cancelCalls.length > 0);
    expect(cancelCalls).toEqual(["k-1"]);
    expect(runCalls).toBe(1);
  });

  it("a failed kernel task fails the subtask instead of reporting it done", async () => {
    vi.spyOn(kernelApi.tasks, "run").mockImplementation((async () => {
      runCalls += 1;
      return { done: false, state: "failed", taskId: "k-9", error: "tool crashed" };
    }) as never);
    const { id } = taskGraph.submit("Write the notes file for the meeting", {
      nodes: [{ title: "write notes", instruction: "write notes.txt" }],
      maxAttempts: 1,
    });
    await until(() => ["failed", "completed"].includes(taskGraph.get(id)?.state ?? ""));
    expect(taskGraph.get(id)!.state).toBe("failed");
  });
});
