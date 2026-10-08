import { afterEach, describe, expect, it } from "vitest";
import {
  TaskGraphEngine,
  planNodes,
  type GraphNode,
  type TaskGraph,
} from "../../src/lib/friday/self/task-graph";
import { taskGraph } from "../../src/lib/friday/self/task-graph";
import { considerLongTask, handleQueueCommand } from "../../src/lib/friday/self/task-runners";
import { looksLikeHorizonGoal } from "../../src/lib/friday/self/horizon-goals";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { resumeOffer, shouldReplay } from "../../src/lib/friday/self/run-receipt";
import { settleInterrupted, type TaskRecord } from "../../src/lib/friday/self/task-ledger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const settle = async (engine: TaskGraphEngine, ms = 400) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(5);
    const running = engine.list().some((g) => g.state === "running" || g.state === "queued");
    if (!running) return;
  }
};

describe("task graph — durable multi-step work", () => {
  it("breaks a real request into ordered subtasks and checkpoints each one", async () => {
    const engine = new TaskGraphEngine();
    const seen: string[] = [];
    engine.registerRunner("goal", async ({ node }) => {
      seen.push(node.title);
      return {
        result: `handled ${node.title}`,
        files: ["ledger.csv"],
        tools: ["kernel.task.run"],
        checked: true,
      };
    });

    const { id } = engine.submit(
      "Collect the March invoices\n2. reconcile them against the bank export\n3. write the summary",
    );
    await settle(engine);

    const graph = engine.get(id)!;
    expect(graph.nodes.length).toBe(3);
    expect(graph.state).toBe("completed");
    expect(seen.length).toBe(3);
    expect(graph.nodes.every((node) => node.state === "verified")).toBe(true);
    expect(graph.nodes[0]?.checkpoint?.result).toContain("handled");
    expect(graph.nodes[0]?.checkpoint?.nextAction).toBeTruthy();
    expect(planNodes("do a, then do b").length).toBe(2);
  });

  it("resumes from the last checkpoint after a restart instead of redoing work", async () => {
    const first = new TaskGraphEngine();
    let ran = 0;
    first.registerRunner("goal", async ({ node, signal }) => {
      ran += 1;
      if (node.title.startsWith("step two")) {
        // Simulate the app dying mid-node.
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
        return { result: "" };
      }
      return { result: `done ${node.title}`, checked: true };
    });
    const { id } = first.submit("step one of the job\nthen step two of the job\nthen step three");
    await sleep(50);
    first.pause(id);
    await sleep(30);

    const stored = clone(first.list()) as TaskGraph[];
    expect(stored[0]?.nodes[0]?.state).toBe("verified");

    // "Restart": a brand new engine hydrating the persisted graphs.
    const second = new TaskGraphEngine();
    const after: string[] = [];
    second.registerRunner("goal", async ({ node }) => {
      after.push(node.title);
      return { result: `done ${node.title}`, checked: true };
    });
    second.hydrateFrom(stored);
    second.resume(id);
    await settle(second);

    const graph = second.get(id)!;
    expect(graph.state).toBe("completed");
    // The first step is not re-run: only the unfinished tail executes.
    expect(after.some((title) => title.startsWith("step one"))).toBe(false);
    expect(after.length).toBe(2);
    expect(ran).toBeGreaterThan(0);
  });

  it("queues a second request instead of dropping or interrupting the first", async () => {
    const engine = new TaskGraphEngine();
    let release: () => void = () => {};
    engine.registerRunner("goal", async ({ node }) => {
      if (node.title.startsWith("long")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { result: `done ${node.title}` };
    });

    const long = engine.submit("long accounting job");
    await sleep(20);
    const second = engine.submit("small filing job");
    expect(second.queued).toBe(true);
    expect(second.position).toBeGreaterThan(1);
    expect(engine.get(second.id)!.state).toBe("queued");
    expect(engine.get(long.id)!.state).toBe("running");

    release();
    await settle(engine);
    expect(engine.get(long.id)!.state).toBe("completed");
    expect(engine.get(second.id)!.state).toBe("completed");
  });

  it("pauses idle self-work the instant the owner is active, keeping the checkpoint", async () => {
    const engine = new TaskGraphEngine();
    engine.registerRunner("self-improve", async ({ signal, checkpoint }) => {
      checkpoint({ done: "scanned backlog", nextAction: "apply the next fix" });
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
        setTimeout(resolve, 500);
      });
      return { result: "" };
    });

    const idle = engine.submit("Self-improvement pass", {
      priority: "idle",
      kind: "self-improve",
      nodes: [{ title: "Review my own backlog", instruction: "backlog" }],
    });
    await engine.pump();
    await sleep(30);
    expect(engine.get(idle.id)!.state).toBe("running");

    engine.noteOwnerActivity();
    await sleep(30);

    const graph = engine.get(idle.id)!;
    expect(graph.state).toBe("paused");
    expect(graph.nodes[0]?.state).toBe("paused");
    expect(graph.nodes[0]?.checkpoint?.nextAction).toBe("apply the next fix");
  });

  it("reports completion exactly once so the owner is told when they return", async () => {
    const engine = new TaskGraphEngine();
    engine.registerRunner("goal", async ({ node }) => ({ result: `done ${node.title}` }));
    const announced: string[] = [];
    engine.subscribe(() => {
      for (const graph of engine.list()) {
        if (graph.state === "completed" && !graph.announced) {
          engine.markAnnounced(graph.id);
          announced.push(graph.id);
        }
      }
    });

    const { id } = engine.submit("prepare the quarterly VAT pack");
    await settle(engine);
    expect(engine.get(id)!.state).toBe("completed");
    expect(announced).toEqual([id]);
  });

  it("retries a failed graph from the last checkpoint without inventing steps", async () => {
    const engine = new TaskGraphEngine();
    let blows = 0;
    engine.registerRunner("goal", async ({ node }) => {
      if (node.title.startsWith("step two") && blows < 2) {
        blows += 1;
        return { ok: false, result: "bank export missing" };
      }
      return { result: `done ${node.title}`, checked: true };
    });
    const { id } = engine.submit("step one of the job\nthen step two of the job");
    await settle(engine, 800);
    const failed = engine.get(id)!;
    expect(failed.state).toBe("failed");
    expect(failed.nodes[0]?.state).toBe("verified");
    expect(engine.retry(id)).toBe(true);
    await settle(engine, 800);
    const again = engine.get(id)!;
    expect(again.state).toBe("completed");
    expect(again.nodes.every((node) => node.state === "verified")).toBe(true);
  });

  it("resumes the last paused subtask instead of parking it again", async () => {
    const engine = new TaskGraphEngine();
    let first = true;
    engine.registerRunner("goal", async ({ signal }) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
        return { result: "" };
      }
      return { result: "done", checked: true };
    });
    const { id } = engine.submit("one shot filing job");
    await sleep(30);
    engine.pause(id);
    await sleep(30);
    expect(engine.get(id)!.state).toBe("paused");
    expect(engine.get(id)!.nodes[0]?.state).toBe("paused");
    engine.resume(id);
    await settle(engine, 800);
    expect(engine.get(id)!.state).toBe("completed");
    expect(engine.get(id)!.nodes[0]?.state).toBe("verified");
  });

  it("reorders queued owner graphs and requeues a finished request", async () => {
    const engine = new TaskGraphEngine();
    let release: () => void = () => {};
    engine.registerRunner("goal", async ({ node }) => {
      if (node.title.startsWith("hold")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { result: `done ${node.title}` };
    });
    engine.submit("hold the first job in place");
    await sleep(20);
    const second = engine.submit("second queued filing job");
    const third = engine.submit("third queued filing job");
    expect(engine.moveInQueue(third.id, -1)).toBe(true);
    const line = engine.getSnapshot().queue.map((entry) => entry.id);
    expect(line[0]).toBe(third.id);
    expect(line[1]).toBe(second.id);
    release();
    await settle(engine, 800);
    const finished = engine.list().find((graph) => graph.state === "completed");
    expect(finished).toBeTruthy();
    const again = engine.requeue(finished!.id);
    expect(again?.id).not.toBe(finished!.id);
    expect(engine.get(again!.id)?.request).toBe(finished!.request);
    engine.pauseAll();
    engine.cancel(again!.id);
    engine.clearFinished();
  });
});

describe("task intake — chat stays free", () => {
  it("answers other messages while a long task keeps running in the background", async () => {
    let release: () => void = () => {};
    taskGraph.registerRunner("goal", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { result: "done" };
    });

    const long = taskGraph.submit("reconcile the March ledger and then file the VAT return");
    await sleep(20);
    expect(taskGraph.busy()).toBe(true);
    expect(taskGraph.running()?.id).toBe(long.id);

    // Ordinary chat is never captured by the background layer.
    expect(considerLongTask("what is the total VAT rate we charge in India")).toBeNull();
    expect(considerLongTask("thanks, that helps")).toBeNull();
    expect(considerLongTask("make sure you remember that for later")).toBeNull();
    expect(considerLongTask("please use free only models from now")).toBeNull();

    // A second real job queues rather than interrupting.
    const queued = considerLongTask("update the supplier list with the new addresses");
    expect(queued?.queued).toBe(true);
    expect(queued?.message).toContain("Queued");
    expect(handleQueueCommand("task status")).toContain("Running");
    expect(handleQueueCommand("how much is complete?")).toMatch(/of \d+ subtask/);
    expect(handleQueueCommand("what failed")).toBeNull();

    // The owner can still choose to switch, explicitly.
    expect(handleQueueCommand("interrupt")).toContain("Interrupted");
    expect(taskGraph.get(long.id)!.state).toBe("paused");
    expect(handleQueueCommand("pause the task")).toContain("nothing running");
    expect(handleQueueCommand("continue that task")).toMatch(/Resuming/);
    expect(handleQueueCommand("cancel the task")).toContain("Cancelled");
    expect(taskGraph.get(long.id)!.state).toBe("cancelled");
    expect(handleQueueCommand("retry the task")).toContain("Retrying");
    if (queued) taskGraph.cancel(queued.id);
    release();
  });
});

describe("task graph budgets and receipts", () => {
  it("stops at the step budget and keeps an evidence id on the finished step", async () => {
    const engine = new TaskGraphEngine();
    engine.registerRunner("goal", async ({ node }) => ({
      result: `done ${node.title}`,
      checked: true,
    }));
    const { id } = engine.submit("step one of the job\nthen step two of the job", {
      budget: { timeMs: 60_000, maxSteps: 1, spend: 0, tokens: 0 },
    });
    await settle(engine, 400);
    const graph = engine.get(id)!;
    expect(graph.state).toBe("paused");
    expect(graph.nodes[0]?.state).toBe("verified");
    expect(graph.nodes[0]?.checkpoint?.evidenceId).toContain("evidence");
    expect(graph.nodes[0]?.checkpoint?.checked).toBe(true);
    expect(graph.runId).toContain("-run");
    expect(graph.nodes[1]?.state).toBe("waiting");
  });

  it("records the bounded retry delay when a step fails once", async () => {
    const engine = new TaskGraphEngine();
    let tries = 0;
    engine.registerRunner("goal", async () => {
      tries += 1;
      if (tries === 1) return { ok: false, result: "not yet" };
      return { result: "done" };
    });
    const { id } = engine.submit("retry this single job", { maxAttempts: 2 });
    await settle(engine, 400);
    const graph = engine.get(id)!;
    expect(graph.state).toBe("completed");
    expect(graph.nodes[0]?.retryDelayMs).toBe(2000);
    expect(tries).toBe(2);
  });
});

describe("long-horizon goals", () => {
  it("tracks a multi-session goal and replans remaining work when a blocker appears", async () => {
    expect(looksLikeHorizonGoal("finish the tender bid by Friday")).toBe(true);
    expect(looksLikeHorizonGoal("hello")).toBe(false);
    const engine = new TaskGraphEngine();
    engine.registerRunner("goal", async () => ({ result: "ok" }));
    const { id } = engine.submit(
      "finish the tender bid by Friday\n1. draft section 3\n2. collect BOQ\n3. file the pack",
      { horizon: { goal: "finish the tender bid by Friday", deadline: "by Friday" } },
    );
    const graph = engine.get(id)!;
    expect(graph.horizon?.goal).toMatch(/tender bid/);
    expect(graph.horizon?.deadline).toBe("by Friday");
    engine.pause(id);
    const replanned = engine.replanBlocked(id, "BOQ spreadsheet missing");
    expect(replanned?.horizon?.blockers).toContain("BOQ spreadsheet missing");
    expect(replanned?.nodes.some((node) => /BOQ spreadsheet missing/.test(node.instruction))).toBe(
      true,
    );
    engine.cancel(id);
  });
});

const point = (
  id: string,
  state: GraphNode["state"],
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id,
  title: id,
  instruction: id,
  kind: "goal",
  dependsOn: [],
  state,
  attempts: state === "pending" ? 0 : 1,
  maxAttempts: 2,
  idempotencyKey: `key-${id}`,
  checkpoint: {
    at: 1,
    done: id,
    remaining: "",
    files: [],
    models: [],
    tools: [],
    result: state === "verified" ? "done" : "",
    nextAction: "save",
    idempotencyKey: `key-${id}`,
    checked: state === "verified",
  },
  ...extra,
});

function crashed(nodes: GraphNode[], extra: Partial<TaskGraph> = {}): TaskGraph {
  return {
    id: "graph-crash",
    request: "write the notes",
    priority: "owner",
    state: "running",
    createdAt: 5_000,
    updatedAt: 5_000,
    nodes,
    logs: [],
    runId: "graph-crash-run",
    ...extra,
  };
}

describe("durable resume after a killed step", () => {
  afterEach(() => {
    autonomy.update({ approvalLevel: "balanced", halted: false });
  });

  it("asks unless the owner set Full, and a halted Full dial still waits", async () => {
    expect(resumeOffer("full")).toBe("resume");
    expect(resumeOffer("balanced")).toBe("ask");
    expect(resumeOffer("strict")).toBe("ask");
    expect(resumeOffer("trusted")).toBe("ask");
    expect(shouldReplay(undefined)).toBe(true);
    expect(shouldReplay({ checked: true })).toBe(false);
    expect(shouldReplay({ checked: false })).toBe(true);
    expect(shouldReplay({ checked: true, worldChanged: true })).toBe(true);

    const first = new TaskGraphEngine();
    let release: () => void = () => {};
    first.registerRunner("goal", async ({ checkpoint, node }) => {
      checkpoint({ done: node.title, nextAction: "save", checked: false });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { result: `done ${node.title}`, checked: true };
    });
    const { id } = first.submit("write the notes", {
      nodes: [{ title: "write the notes", instruction: "write" }],
    });
    await sleep(40);
    const live = first.get(id)!;
    expect(live.nodes[0]?.state).toBe("running");
    expect(live.nodes[0]?.checkpoint?.idempotencyKey).toBeTruthy();
    const stored = clone(first.list());
    release();
    await settle(first);

    const calls: string[] = [];
    const balanced = new TaskGraphEngine();
    balanced.registerRunner("goal", async ({ node }) => {
      calls.push(`${node.title}:${node.checkpoint?.reverify === true}`);
      return { result: "saved", checked: true };
    });
    balanced.hydrateFrom(clone(stored), "balanced");
    await sleep(30);
    expect(balanced.get(id)!.state).toBe("interrupted");
    expect(balanced.get(id)!.resumeOffer).toBe("ask");
    expect(calls).toEqual([]);

    for (const level of ["strict", "trusted"] as const) {
      const engine = new TaskGraphEngine();
      engine.registerRunner("goal", async () => ({ result: "saved", checked: true }));
      engine.hydrateFrom(clone(stored), level);
      expect(engine.get(id)!.state).toBe("interrupted");
    }

    const full = new TaskGraphEngine();
    full.registerRunner("goal", async () => {
      calls.push("full");
      return { result: "saved", checked: true };
    });
    full.hydrateFrom(clone(stored), "full");
    await settle(full);
    expect(calls).toEqual(["full"]);
    expect(full.get(id)!.state).toBe("completed");

    autonomy.update({ halted: true });
    const halted = new TaskGraphEngine();
    let haltedCalls = 0;
    halted.registerRunner("goal", async () => {
      haltedCalls += 1;
      return { result: "saved", checked: true };
    });
    halted.hydrateFrom(clone(stored), "full");
    await sleep(40);
    expect(haltedCalls).toBe(0);
    expect(halted.get(id)!.state).toBe("interrupted");
    expect(halted.get(id)!.resumeOffer).toBe("ask");
  });

  it("resumes once, skips a checked step, and replays when the world changed", async () => {
    const engine = new TaskGraphEngine();
    const ran: string[] = [];
    engine.registerRunner("goal", async ({ node }) => {
      ran.push(node.id);
      expect(node.checkpoint?.reverify).toBe(true);
      return { result: `done ${node.id}`, checked: true, worldChanged: false };
    });
    const open = crashed([
      point("write", "running", {
        checkpoint: {
          at: 1,
          done: "write",
          remaining: "save",
          files: [],
          models: [],
          tools: [],
          result: "",
          nextAction: "save",
          idempotencyKey: "key-write",
          checked: false,
        },
      }),
    ]);
    engine.hydrateFrom([open], "balanced");
    engine.resume(open.id);
    engine.resume(open.id);
    await settle(engine);
    expect(ran).toEqual(["write"]);
    expect(engine.get(open.id)!.state).toBe("completed");
    engine.resume(open.id);
    expect(ran).toEqual(["write"]);

    const changed = new TaskGraphEngine();
    const again: string[] = [];
    changed.registerRunner("goal", async ({ node }) => {
      again.push(node.id);
      return { result: "rechecked", checked: true };
    });
    changed.hydrateFrom(
      [
        crashed([
          point("write", "running", {
            checkpoint: {
              at: 1,
              done: "write",
              remaining: "",
              files: [],
              models: [],
              tools: [],
              result: "saved once",
              nextAction: "finish",
              checked: true,
              worldChanged: true,
              idempotencyKey: "key-write",
            },
          }),
        ]),
      ],
      "balanced",
    );
    expect(changed.get("graph-crash")!.state).toBe("interrupted");
    changed.resume("graph-crash");
    await settle(changed);
    expect(again).toEqual(["write"]);

    const held = new TaskGraphEngine();
    let skipped = 0;
    held.registerRunner("goal", async () => {
      skipped += 1;
      return { result: "should not run", checked: true };
    });
    held.hydrateFrom(
      [
        crashed([
          point("write", "running", {
            checkpoint: {
              at: 1,
              done: "write",
              remaining: "",
              files: [],
              models: [],
              tools: [],
              result: "saved once",
              nextAction: "finish",
              checked: true,
              idempotencyKey: "key-write",
            },
          }),
        ]),
      ],
      "balanced",
    );
    expect(skipped).toBe(0);
    expect(held.get("graph-crash")!.state).toBe("completed");
    expect(held.get("graph-crash")!.nodes[0]?.state).toBe("verified");
  });

  it("cancels an interrupted run and refuses another step after the budget", async () => {
    const engine = new TaskGraphEngine();
    let ran = 0;
    engine.registerRunner("goal", async () => {
      ran += 1;
      return { result: "done", checked: true };
    });
    const graph = crashed([point("write", "running")]);
    engine.hydrateFrom([graph], "balanced");
    engine.cancel(graph.id);
    expect(engine.get(graph.id)!.state).toBe("cancelled");
    engine.resume(graph.id);
    await sleep(20);
    expect(ran).toBe(0);
    expect(engine.get(graph.id)!.state).toBe("cancelled");

    const limited = new TaskGraphEngine();
    limited.registerRunner("goal", async () => {
      ran += 1;
      return { result: "done", checked: true };
    });
    const over = crashed(
      [point("one", "verified"), point("two", "running", { dependsOn: ["one"] })],
      { budget: { timeMs: 60_000_000, maxSteps: 1, spend: 0, tokens: 0 }, createdAt: Date.now() },
    );
    limited.hydrateFrom([over], "full");
    await sleep(40);
    expect(ran).toBe(0);
    expect(limited.get(over.id)!.state).toBe("paused");
    expect(limited.get(over.id)!.logs.some((line) => line.line.includes("step budget"))).toBe(true);
    limited.clearFinished();
    expect(limited.get(over.id)).toBeTruthy();
  });

  it("keeps the ledger checkpoint when a reload interrupts the row", () => {
    const checkpoint = {
      at: 10,
      done: "opened",
      nextAction: "save",
      idempotencyKey: "file|notes|save",
      checked: false,
    };
    const row = (id: string, status: TaskRecord["status"], endedAt?: number): TaskRecord => ({
      id,
      key: id,
      kind: "goal",
      title: id,
      status,
      progress: 0,
      startedAt: 1,
      logs: [],
      ...(endedAt != null ? { endedAt } : {}),
      ...(id === "running" ? { checkpoint } : {}),
    });
    const next = settleInterrupted([
      row("running", "running"),
      row("queued", "queued"),
      row("ask", "awaiting-approval"),
      row("done", "done", 9),
    ]);
    expect(next.map((task) => task.status)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
      "done",
    ]);
    expect(next[0]?.checkpoint).toEqual(checkpoint);
    expect(next[0]?.endedAt).toBeUndefined();
    expect(next[3]?.endedAt).toBe(9);
  });
});
