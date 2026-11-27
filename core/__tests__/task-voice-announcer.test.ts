/**
 * "I will tell you when it is done" is kept by voice too. A background graph that finished, failed or is waiting on
 * the owner raises the visual notice and one short spoken line built from its checked subtask results, through the
 * same narrator rules as a desk task (priority, held lines, quiet hours, mute). The graph is marked announced only
 * after the line was delivered or queued, and a waiting notice does not use up the completion notice.
 */
import { afterEach, describe, expect, it } from "vitest";

import { announceGraphs, graphOutcomeLine } from "../../src/lib/friday/notification-wiring";
import type { TaskGraph } from "../../src/lib/friday/self/task-graph";
import {
  announceBackgroundTask,
  attachVoiceTaskNarrator,
  type TaskUpdate,
} from "../../src/lib/friday/voice-engine/voice-tasks";

function graph(state: TaskGraph["state"], patch: Partial<TaskGraph> = {}): TaskGraph {
  return {
    id: "graph-1",
    request: "Collect the March invoices and reconcile them",
    priority: "owner",
    state,
    createdAt: 1,
    updatedAt: 2,
    logs: [],
    nodes: [
      {
        id: "graph-1-n1",
        title: "collect invoices",
        instruction: "collect",
        kind: "goal",
        dependsOn: [],
        state: "verified",
        attempts: 1,
        maxAttempts: 2,
        checkpoint: {
          at: 2,
          done: "collect invoices",
          remaining: "",
          files: [],
          models: [],
          tools: ["kernel.task.run"],
          result: "kernel completed: collect invoices (3 step(s))",
          nextAction: "finish",
          checked: true,
        },
      },
      {
        id: "graph-1-n2",
        title: "reconcile",
        instruction: "reconcile",
        kind: "goal",
        dependsOn: ["graph-1-n1"],
        state: state === "failed" ? "failed" : state === "paused" ? "waiting" : "verified",
        attempts: 1,
        maxAttempts: 2,
        ...(state === "failed" ? { error: "kernel task failed: bank export missing" } : {}),
        checkpoint: {
          at: 3,
          done: "reconcile",
          remaining: "",
          files: [],
          models: [],
          tools: ["kernel.task.run"],
          result: state === "paused" ? "waiting on your approval for fs.write" : "reconciled",
          nextAction: "finish",
          checked: state === "completed",
          ...(state === "paused"
            ? { pendingApproval: { stepId: "s2", tool: "fs.write", risk: "write" } }
            : {}),
        },
      },
    ],
    ...patch,
  };
}

function harness(speakOk: boolean) {
  const spoken: Array<{ update: TaskUpdate; label: string }> = [];
  const notices: string[] = [];
  const marked: string[] = [];
  return {
    spoken,
    notices,
    marked,
    deps: {
      notify: (notice: { id: string }) => void notices.push(notice.id),
      speak: (update: TaskUpdate, label: string) => {
        spoken.push({ update, label });
        return speakOk;
      },
      markAnnounced: (id: string) => void marked.push(id),
    },
  };
}

afterEach(() => {
  attachVoiceTaskNarrator(null);
});

describe("background graph outcomes are spoken once, from checked results", () => {
  it("a finished graph says what it did in one short line, then is marked announced", () => {
    const h = harness(true);
    announceGraphs([graph("completed")], h.deps);
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]!.update.kind).toBe("completed");
    expect(h.spoken[0]!.update.text).toMatch(/2 of 2/);
    expect(h.spoken[0]!.update.text.length).toBeLessThanOrEqual(160);
    expect(h.marked).toEqual(["graph-1"]);
    expect(h.notices.length).toBe(1);
  });

  it("is not marked announced when no voice took the line, and the visual notice is not repeated", () => {
    const h = harness(false);
    announceGraphs([graph("completed", { id: "graph-4" })], h.deps);
    announceGraphs([graph("completed", { id: "graph-4" })], h.deps);
    expect(h.marked).toEqual([]);
    expect(h.notices.length).toBe(1);
  });

  it("a failed graph names the failed step", () => {
    const h = harness(true);
    announceGraphs([graph("failed", { id: "graph-2" })], h.deps);
    expect(h.spoken[0]!.update.kind).toBe("failed");
    expect(h.spoken[0]!.update.text).toMatch(/reconcile/);
    expect(h.marked).toEqual(["graph-2"]);
  });

  it("a waiting graph asks once and does not use up the completion notice", () => {
    const h = harness(true);
    announceGraphs([graph("paused", { id: "graph-3" })], h.deps);
    announceGraphs([graph("paused", { id: "graph-3" })], h.deps);
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]!.update.kind).toBe("needs-approval");
    expect(h.spoken[0]!.update.text).toMatch(/fs\.write/);
    expect(h.marked).toEqual([]);
    announceGraphs([graph("completed", { id: "graph-3" })], h.deps);
    expect(h.spoken.map((row) => row.update.kind)).toEqual(["needs-approval", "completed"]);
    expect(h.marked).toEqual(["graph-3"]);
  });

  it("an already announced graph is left alone", () => {
    const h = harness(true);
    announceGraphs([graph("completed", { announced: true })], h.deps);
    expect(h.spoken).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("graphOutcomeLine never claims a finish it did not check", () => {
    const unchecked = graph("completed");
    for (const node of unchecked.nodes) if (node.checkpoint) node.checkpoint.checked = false;
    expect(graphOutcomeLine(unchecked)).toMatch(/0 of 2/);
  });
});

describe("the voice desk speaks a background outcome through the conductor's narrator", () => {
  it("hands the update to the narrator and reports it as delivered", () => {
    const seen: TaskUpdate[] = [];
    attachVoiceTaskNarrator((update) => void seen.push(update));
    const ok = announceBackgroundTask(
      { taskId: "graph:graph-1", kind: "completed", text: "Done: invoices." },
      "invoices",
    );
    expect(ok).toBe(true);
    expect(seen.map((update) => update.text)).toEqual(["Done: invoices."]);
  });
});
