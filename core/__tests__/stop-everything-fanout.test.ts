/**
 * Stop everything is one fan-out. Before this, autonomy.stopEverything() only set `halted` and told MCP: a running
 * background graph went on to its next subtask, a kernel task kept stepping, and a terminal run kept running, while
 * the voice said "Stopped." Now the switch pauses every running graph (aborting the active subtask), refuses to pick
 * or step a graph while it is on, cancels every open kernel task and every terminal run, and reports what it stopped.
 * No kernel, terminal or network is used: the bridges are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import kernelApi from "../../src/lib/friday/kernel-api";
import { autonomy, describeStop } from "../../src/lib/friday/self/autonomy";
import { resetTaskGraphStore, taskGraph } from "../../src/lib/friday/self/task-graph";
import { registerTaskRunners } from "../../src/lib/friday/self/task-runners";
import {
  EMPTY_CONDUCT,
  reduceVoice,
  stopEverythingFromVoice,
} from "../../src/lib/friday/assistant-conduct";

type Bridge = Record<string, unknown>;
const g = globalThis as unknown as { window?: { friday?: Bridge; localStorage?: Storage } };
g.window ??= globalThis as never;

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await tick();
  }
}

let release: ((value: unknown) => void) | null = null;
let runs: string[] = [];
let cancelledKernel: string[] = [];
let cancelledRuns: string[] = [];

beforeEach(() => {
  resetTaskGraphStore();
  autonomy.reset();
  for (const graph of taskGraph.list()) taskGraph.cancel(graph.id);
  taskGraph.clearFinished();
  runs = [];
  cancelledKernel = [];
  cancelledRuns = [];
  g.window!.friday = {
    terminalRuns: async () => [
      { runId: "run-1", command: "npm test", cwd: ".", shell: "cmd", ms: 5 },
    ],
    terminalCancel: async (runId: string) => {
      cancelledRuns.push(runId);
      return { ok: true };
    },
  };
  vi.spyOn(kernelApi.tasks, "run").mockImplementation(((goal: string) => {
    runs.push(goal);
    return new Promise((resolve) => {
      release = resolve;
    });
  }) as never);
  vi.spyOn(kernelApi.tasks, "pending").mockResolvedValue({
    tasks: [
      { taskId: "k-running", state: "running" },
      { taskId: "k-done", state: "done" },
    ],
  } as never);
  vi.spyOn(kernelApi.tasks, "cancel").mockImplementation(((taskId: string) => {
    cancelledKernel.push(taskId);
    return Promise.resolve({ ok: true, taskId, state: "cancelled" });
  }) as never);
  registerTaskRunners();
});

afterEach(() => {
  autonomy.resume();
  autonomy.reset();
  vi.restoreAllMocks();
  delete g.window!.friday;
});

describe("Stop everything halts background work", () => {
  it("a running graph does not advance to its next subtask, and nothing new is picked", async () => {
    const { id } = taskGraph.submit(
      "Collect the March invoices\n2. reconcile them against the bank export\n3. write the summary",
    );
    await until(() => runs.length === 1);
    expect(runs.length).toBe(1);

    const report = autonomy.stopEverything();
    expect(report.settings.halted).toBe(true);
    expect(report.stopped.graphs).toBe(1);

    // The kernel answers for the first subtask after the switch was thrown.
    release?.({ done: true, state: "done", taskId: "k-running", results: [], events: 3 });
    await tick();
    await tick();
    await taskGraph.pump();

    expect(runs.length).toBe(1);
    const graph = taskGraph.get(id)!;
    expect(graph.state).toBe("paused");
    expect(
      graph.nodes.some((node) => node.state === "verified" || node.state === "completed"),
    ).toBe(false);

    // A graph submitted while the switch is on waits.
    taskGraph.submit("Prepare the April report\n2. then send it to the accountant");
    await tick();
    await taskGraph.pump();
    expect(runs.length).toBe(1);

    const summary = await report.settled;
    expect(cancelledKernel).toEqual(["k-running"]);
    expect(cancelledRuns).toEqual(["run-1"]);
    expect(summary).toMatchObject({ graphs: 1, kernelTasks: 1, terminalRuns: 1 });
    expect(describeStop(summary)).toMatch(/stopped/i);
    expect(describeStop(summary)).toMatch(/1 background task/);
  });

  it("resuming the switch lets queued work start again", async () => {
    autonomy.stopEverything();
    taskGraph.submit("Prepare the April report\n2. then send it to the accountant");
    await tick();
    expect(runs.length).toBe(0);
    autonomy.resume();
    await until(() => runs.length === 1);
    expect(runs.length).toBe(1);
    release?.({ done: false, state: "cancelled", taskId: "k2", results: [], events: 1 });
  });

  it("says plainly when nothing else was running", () => {
    expect(describeStop({ graphs: 0, kernelTasks: 0, terminalRuns: 0 })).toMatch(/nothing/i);
  });
});

describe("the spoken stop and undo say only what is true", () => {
  it("the live voice stop throws the same switch and reports what it stopped", async () => {
    const { id } = taskGraph.submit(
      "Collect the March invoices\n2. reconcile them\n3. write it up",
    );
    await until(() => runs.length === 1);
    const line = stopEverythingFromVoice();
    expect(autonomy.getSnapshot().halted).toBe(true);
    expect(taskGraph.get(id)!.state).toBe("paused");
    expect(line.now).toMatch(/1 background task/);
    expect(await line.settled).toMatch(/kernel task/);
    release?.({ done: true, state: "done", taskId: "k-running", results: [], events: 1 });
  });

  it("'undo that' with nothing reversible on the list does not claim an undo", () => {
    const reply = reduceVoice(EMPTY_CONDUCT, "undo that", 1);
    expect(reply.spoken).not.toMatch(/^undone|nothing to cancel/i);
    expect(reply.spoken).toMatch(/cannot undo/i);
    expect(reply.action).not.toBe("undone");
  });
});
