import { describe, expect, it } from "vitest";
import { TaskQueue } from "../orchestration";
import { ServiceRegistry } from "../services";
import { ComponentRegistry } from "../components";
import { WorkflowEngine } from "../workflow";
import { classifyIntent } from "../brain/intent";
import { assess } from "../brain/reasoning";
import { buildPlan, planWaves } from "../brain/planner";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("task queue", () => {
  it("de-duplicates work submitted under the same key", async () => {
    const queue = new TaskQueue();
    let runs = 0;
    const work = () =>
      queue.submit({ key: "same" }, async () => {
        runs += 1;
        await sleep(20);
        return runs;
      });
    const [a, b] = [work(), work()];
    await Promise.all([a.promise, b.promise]);
    expect(runs).toBe(1);
  });

  it("cancels a running task", async () => {
    const queue = new TaskQueue();
    const handle = queue.submit({ key: "cancel-me" }, async ({ signal }) => {
      await sleep(200);
      if (signal.aborted) throw new Error("aborted");
      return "finished";
    });
    handle.cancel("test");
    await expect(handle.promise).rejects.toBeTruthy();
    expect(handle.state).toBe("cancelled");
  });

  it("respects the timeout", async () => {
    const queue = new TaskQueue();
    const handle = queue.submit({ key: "slow", timeoutMs: 20 }, () => sleep(500));
    await expect(handle.promise).rejects.toBeTruthy();
  });
});

describe("service registry", () => {
  it("starts once and releases after idle", async () => {
    const registry = new ServiceRegistry();
    let started = 0;
    let stopped = 0;
    registry.define<{ v: number }>({
      id: "probe",
      idleMs: 30,
      start: () => {
        started += 1;
        return { v: 1 };
      },
      stop: () => {
        stopped += 1;
      },
    });
    await Promise.all([registry.acquire("probe"), registry.acquire("probe")]);
    registry.release("probe");
    registry.release("probe");
    expect(started).toBe(1);
    await sleep(80);
    expect(stopped).toBe(1);
    expect(registry.list()[0]?.started).toBe(false);
  });
});

describe("component registry", () => {
  it("refuses duplicates, disabled components and missing dependencies", async () => {
    const registry = new ComponentRegistry();
    registry.register({ id: "tools/echo", kind: "tool", name: "Echo", version: "1.0.0" }, () => ({
      run: (input) => Promise.resolve(input),
    }));
    registry.register(
      { id: "tools/echo", kind: "tool", name: "Echo dupe", version: "9.9.9" },
      () => ({ run: () => Promise.resolve("dupe") }),
    );
    expect(registry.list("tool")).toHaveLength(1);
    expect(await registry.run("tools/echo", "hi")).toBe("hi");

    registry.setEnabled("tools/echo", false);
    await expect(registry.run("tools/echo", "hi")).rejects.toThrow(/disabled/);

    registry.register(
      {
        id: "skills/needs",
        kind: "skill",
        name: "Needs",
        version: "1.0.0",
        dependencies: ["nope"],
      },
      () => ({ run: () => Promise.resolve("x") }),
    );
    await expect(registry.run("skills/needs")).rejects.toThrow(/missing component/);
  });
});

describe("brain pipeline", () => {
  it("classifies a machine action as actionable and plans an approval step", () => {
    const intent = classifyIntent("delete the file C:\\temp\\old.log");
    expect(intent.kind).toBe("file");
    expect(intent.actionable).toBe(true);
    expect(intent.entities.paths.length).toBeGreaterThan(0);

    const plan = buildPlan(intent);
    expect(plan.needsApproval).toBe(true);
    expect(plan.steps.some((s) => s.kind === "verify")).toBe(true);
    expect(planWaves(plan).length).toBeGreaterThan(1);
  });

  it("keeps small talk cheap", () => {
    const intent = classifyIntent("hey friday");
    expect(intent.kind).toBe("chat");
    expect(assess(intent).complexity).toBe("low");
    expect(buildPlan(intent).needsApproval).toBe(false);
  });
});

describe("workflow engine", () => {
  it("runs waves in order and stops on a failing step", async () => {
    const engine = new WorkflowEngine();
    const intent = classifyIntent("how does this work?");
    const waves = planWaves(buildPlan(intent));
    const seen: string[] = [];

    const run = await engine.start({
      workflowId: "test-ok",
      waves,
      execute: async (step) => {
        seen.push(step.target);
        return `ok:${step.target}`;
      },
    }).promise;

    expect(run.state).toBe("done");
    expect(seen[0]).toBe("recall");
    expect(run.results.every((r) => r.ok)).toBe(true);

    const failing = await engine.start({
      workflowId: "test-fail",
      waves,
      execute: async () => {
        throw new Error("boom");
      },
    }).promise;
    expect(failing.state).toBe("failed");
    expect(failing.results).toHaveLength(1);
  });
});
