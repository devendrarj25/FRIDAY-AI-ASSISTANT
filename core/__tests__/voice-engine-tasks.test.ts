import { describe, expect, it } from "vitest";
import {
  canMoveTask,
  TaskOrchestrator,
  type TaskRunner,
} from "../../src/lib/friday/voice-engine/task-orchestrator";
import type { TaskUpdate } from "../../src/lib/friday/voice-engine/task-announcer";

const tick = () => new Promise((r) => setTimeout(r, 5));
const gateway = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

describe("TaskOrchestrator", () => {
  it("returns at once and runs the work on a worker", async () => {
    const g = gateway();
    const o = new TaskOrchestrator({ run: async () => (await g.wait, "ok") });
    const made = o.create({ label: "Analyse report" });
    expect(made.ok && made.task.state).toBe("RUNNING");
    await tick();
    expect(o.list()[0]?.state).toBe("RUNNING");
    g.open();
    await tick();
    expect(o.list()[0]).toMatchObject({ state: "COMPLETED", result: "ok" });
  });

  it("runs one heavy task at a time and keeps the order", async () => {
    const order: string[] = [];
    const gates = [gateway(), gateway()];
    let i = 0;
    const run: TaskRunner = async (t) => {
      const g = gates[i++]!;
      order.push(`start ${t.label}`);
      await g.wait;
      order.push(`end ${t.label}`);
      return "";
    };
    const o = new TaskOrchestrator({ run });
    o.create({ label: "A" });
    o.create({ label: "B" });
    await tick();
    expect(order).toEqual(["start A"]);
    gates[0]!.open();
    await tick();
    gates[1]!.open();
    await tick();
    expect(order).toEqual(["start A", "end A", "start B", "end B"]);
  });

  it("cancels a running task through its signal and a queued task before it starts", async () => {
    let aborted = false;
    const o = new TaskOrchestrator({
      run: (_t, ctx) =>
        new Promise((_res, rej) =>
          ctx.signal.addEventListener("abort", () => ((aborted = true), rej(new Error("x")))),
        ),
    });
    const a = o.create({ label: "A" });
    const b = o.create({ label: "B" });
    await tick();
    if (!a.ok || !b.ok) throw new Error("create failed");
    expect(o.cancel(b.task.id)).toBe(true);
    expect(o.cancel(a.task.id)).toBe(true);
    await tick();
    expect(aborted).toBe(true);
    expect(o.list().map((t) => t.state)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(o.cancel(a.task.id)).toBe(false);
  });

  it("pauses at a checkpoint and resumes", async () => {
    const steps: number[] = [];
    const advance = gateway();
    const o = new TaskOrchestrator({
      run: async (_t, ctx) => {
        for (let n = 1; n <= 3; n += 1) {
          await ctx.checkpoint();
          steps.push(n);
          if (n === 1) await advance.wait;
        }
        return "done";
      },
    });
    const made = o.create({ label: "Steps" });
    if (!made.ok) throw new Error("create failed");
    await tick();
    expect(o.pause(made.task.id)).toBe(true);
    expect(o.get(made.task.id)?.state).toBe("PAUSED");
    advance.open();
    await tick();
    expect(steps).toEqual([1]);
    expect(o.resume(made.task.id)).toBe(true);
    await tick();
    expect(steps).toEqual([1, 2, 3]);
    expect(o.get(made.task.id)?.state).toBe("COMPLETED");
  });

  it("waits for approval before a risky task starts, and a no cancels it", async () => {
    let ran = 0;
    const o = new TaskOrchestrator({ run: async () => ((ran += 1), "ok") });
    const risky = o.create({ label: "Delete old files", risk: "needs-approval" });
    if (!risky.ok) throw new Error("create failed");
    await tick();
    expect(risky.task.state).toBe("WAITING_FOR_APPROVAL");
    expect(ran).toBe(0);
    expect(o.approve(risky.task.id, true)).toBe(true);
    await tick();
    expect(ran).toBe(1);
    const second = o.create({ label: "Send email", risk: "needs-approval" });
    if (!second.ok) throw new Error("create failed");
    expect(o.approve(second.task.id, false)).toBe(true);
    expect(o.get(second.task.id)?.state).toBe("CANCELLED");
    expect(o.approve("task-99", true)).toBe(false);
  });

  it("reports a failure, keeps working, and speaks updates in order", async () => {
    const updates: TaskUpdate[] = [];
    const o = new TaskOrchestrator({
      run: async (t, ctx) => {
        if (t.label === "bad") throw new Error("disk full");
        ctx.progress(50, "half");
        return "fine";
      },
      onUpdate: (_t, u) => updates.push(u),
    });
    o.create({ label: "bad" });
    o.create({ label: "good" });
    await tick();
    await tick();
    expect(updates.map((u) => `${u.taskId}:${u.kind}`)).toEqual([
      "task-1:started",
      "task-2:started",
      "task-1:failed",
      "task-2:progress",
      "task-2:completed",
    ]);
    expect(o.list().map((t) => t.state)).toEqual(["FAILED", "COMPLETED"]);
  });

  it("bounds how many tasks wait and how many finished ones are kept", async () => {
    const g = gateway();
    const o = new TaskOrchestrator({
      run: async () => (await g.wait, ""),
      maxWaiting: 2,
      keepFinished: 2,
    });
    o.create({ label: "1" });
    o.create({ label: "2" });
    o.create({ label: "3" });
    expect(o.create({ label: "4" }).ok).toBe(false);
    g.open();
    await tick();
    await tick();
    await tick();
    expect(o.list().length).toBeLessThanOrEqual(2);
  });

  it("lets a runner that never checkpoints finish while marked paused, and fail while paused", async () => {
    const g = gateway();
    const h = gateway();
    const o = new TaskOrchestrator({
      run: async (t) => {
        await (t.label === "ok" ? g.wait : h.wait);
        if (t.label === "bad") throw new Error("late failure");
        return "fine";
      },
    });
    const ok = o.create({ label: "ok" });
    if (!ok.ok) throw new Error("create failed");
    expect(o.pause(ok.task.id)).toBe(true);
    g.open();
    await tick();
    expect(o.get(ok.task.id)?.state).toBe("COMPLETED");
    const bad = o.create({ label: "bad" });
    if (!bad.ok) throw new Error("create failed");
    expect(o.pause(bad.task.id)).toBe(true);
    h.open();
    await tick();
    expect(o.get(bad.task.id)).toMatchObject({ state: "FAILED", error: "late failure" });
  });

  it("only allows the listed moves", () => {
    expect(canMoveTask("COMPLETED", "RUNNING")).toBe(false);
    expect(canMoveTask("PAUSED", "COMPLETED")).toBe(false);
    expect(canMoveTask("WAITING_FOR_APPROVAL", "RUNNING")).toBe(false);
    expect(canMoveTask("RUNNING", "PAUSED")).toBe(true);
  });

  it("finds the newest unfinished task", async () => {
    const g = gateway();
    const o = new TaskOrchestrator({ run: async () => (await g.wait, "") });
    o.create({ label: "first" });
    o.create({ label: "second" });
    expect(o.latestActive()?.label).toBe("second");
    g.open();
    await tick();
    await tick();
    expect(o.latestActive()).toBeNull();
  });
});
