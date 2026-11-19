/**
 * What an approved background agent run may and may not report, and what it is held to.
 *
 * Three confirmed defects of the agent path, each reproduced before the fix (2026-11-18):
 *  - an item the owner approved after a restart never ran (the scheduler skipped an id it had already filed);
 *  - an agent that answered `ok: true` with `failed` entries was recorded as `completed` ("no verification step");
 *  - the yes covered the targets the owner was shown, but the run re-scanned and could act on a file that appeared
 *    afterwards.
 * The real governance queue is used, with a fake agent host that records every call: no file is touched, no model,
 * network or provider is used.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import {
  CARRIED_APPROVAL_MS,
  governance,
  type GovItem,
} from "../../src/lib/friday/self/governance";
import {
  reviewEnabledAgents,
  type AgentPlanValue,
  type AgentSchedulerHost,
} from "../../src/lib/friday/self/agent-scheduler";
import {
  budgetBlock,
  idempotencyKey,
  mintIdentity,
  retryBackoffMs,
} from "../../src/lib/friday/self/run-receipt";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

const candidate = (name: string) => ({ name, path: `D:\\Downloads\\${name}` });
const planOf = (names: string[]): AgentPlanValue => ({
  ok: true,
  actionable: names.length > 0,
  folder: "D:\\Downloads",
  candidates: names.map(candidate),
});

type Rig = {
  host: AgentSchedulerHost;
  runs: string[];
  plans: number;
  set: (names: string[] | "throw") => void;
  onRun: (fn: () => { ok: boolean; value?: unknown; error?: string }) => void;
};

function rig(initial: string[]): Rig {
  let names: string[] | "throw" = initial;
  let run: () => { ok: boolean; value?: unknown; error?: string } = () => ({
    ok: true,
    value: { deleted: [], failed: [] },
  });
  const state: Rig = {
    runs: [],
    plans: 0,
    set: (next) => void (names = next),
    onRun: (fn) => void (run = fn),
    host: {
      listEnabledAgents: async () => [
        {
          id: "core/downloads-cleanup",
          name: "Downloads cleanup",
          category: "files",
          risk: "write",
          enabled: true,
          approvalPrompt: "Delete {count} old file(s) in {folder}?",
        },
      ],
      planAgent: async () => {
        state.plans += 1;
        if (names === "throw") throw new Error("the folder is gone");
        return { ok: true, value: planOf(names) };
      },
      runAgent: async (_id, input) => {
        state.runs.push(JSON.stringify(input));
        return run();
      },
      getItem: (id) => governance.get(id),
      discover: (input) => governance.discover(input),
      submit: (action) => governance.submit(action),
      inputFor: () => ({ folder: "D:\\Downloads", olderThanDays: 30 }),
    },
  };
  return state;
}

async function fileAndWait(r: Rig): Promise<string> {
  expect(await reviewEnabledAgents(r.host)).toBe(1);
  await waitFor(() => governance.pending().length === 1, "the item waiting for the owner");
  return governance.pending()[0]?.id as string;
}

const stageOf = (id: string) => governance.get(id)?.stage;
const itemOf = (id: string) => governance.get(id) as GovItem;

beforeEach(() => {
  governance.resetForTests();
  autonomy.reset();
});
afterEach(() => {
  governance.resetForTests();
  autonomy.reset();
});

describe("a partial result is not a success", () => {
  it("an agent that says ok but lists failures is recorded as failed, with what was and was not done", async () => {
    const r = rig(["a.bin", "b.bin"]);
    r.onRun(() => ({
      ok: true,
      value: { deleted: ["a.bin"], failed: [{ name: "b.bin", error: "file is in use" }] },
    }));
    const id = await fileAndWait(r);
    governance.approve(id);
    await waitFor(() => stageOf(id) === "failed", "failed");
    expect(itemOf(id).error).toBe("partly done: 1 done, 1 failed (b.bin: file is in use)");
    expect(stageOf(id)).not.toBe("completed");
  });

  it("an error the agent reports inside an ok answer is a failure too", async () => {
    const r = rig(["a.bin"]);
    r.onRun(() => ({ ok: true, value: { error: "Deletion requires an approved plan." } }));
    const id = await fileAndWait(r);
    governance.approve(id);
    await waitFor(() => stageOf(id) === "failed", "failed");
    expect(itemOf(id).error).toMatch(/Deletion requires an approved plan/);
  });

  it("a clean run with nothing failed still completes (the fix does not make success harder)", async () => {
    const r = rig(["a.bin"]);
    r.onRun(() => ({ ok: true, value: { deleted: [], failed: [] } }));
    const id = await fileAndWait(r);
    governance.approve(id);
    await waitFor(() => stageOf(id) === "completed", "completed");
    expect(r.runs).toHaveLength(1);
  });
});

describe("the proof is a second look, not the agent's word", () => {
  it("fails when something the agent says it removed is still listed afterwards", async () => {
    const r = rig(["a.bin", "b.bin"]);
    r.onRun(() => {
      // the agent claims both are gone; the folder still lists b.bin
      r.set(["b.bin"]);
      return { ok: true, value: { deleted: ["a.bin", "b.bin"], failed: [] } };
    });
    const id = await fileAndWait(r);
    governance.approve(id);
    await waitFor(() => stageOf(id) === "failed", "failed");
    expect(itemOf(id).error).toBe("1 item(s) the agent said it removed are still there");
  });

  it("completes, and says it looked again, when what was removed is really gone", async () => {
    const r = rig(["a.bin", "b.bin"]);
    r.onRun(() => {
      r.set([]);
      return { ok: true, value: { deleted: ["a.bin", "b.bin"], failed: [] } };
    });
    const id = await fileAndWait(r);
    governance.approve(id);
    await waitFor(() => stageOf(id) === "completed", "completed");
    expect(
      itemOf(id).logs.some((row) => /2 removal\(s\) confirmed by looking again/.test(row.line)),
    ).toBe(true);
  });

  it("cannot confirm when it cannot look again, and then does not call it verified", async () => {
    const r = rig(["a.bin"]);
    r.onRun(() => {
      r.set("throw");
      return { ok: true, value: { deleted: ["a.bin"], failed: [] } };
    });
    const id = await fileAndWait(r);
    governance.approve(id);
    await waitFor(() => stageOf(id) === "failed", "failed");
    expect(itemOf(id).error).toBe("could not look again to confirm the removal");
  });

  it("an agent that claims nothing removed is not asked for a confirmation it cannot give", async () => {
    const r = rig(["a.bin"]);
    r.onRun(() => ({ ok: true, value: { moved: 1 } }));
    const id = await fileAndWait(r);
    governance.approve(id);
    await waitFor(() => stageOf(id) === "completed", "completed");
  });
});

describe("the yes covers the targets that were shown", () => {
  it("a file that appeared after the owner looked stops the run, and nothing is changed", async () => {
    const r = rig(["a.bin", "b.bin"]);
    const id = await fileAndWait(r);
    r.set(["a.bin", "b.bin", "new.bin"]); // appeared while the owner was deciding
    governance.approve(id);
    await waitFor(() => stageOf(id) === "failed", "failed");
    expect(r.runs).toEqual([]);
    expect(itemOf(id).error).toMatch(
      /^1 new item\(s\) appeared since you looked \(for example D:\\Downloads\\new\.bin\)/,
    );
  });

  it("a folder that cannot be looked at again is not acted on", async () => {
    const r = rig(["a.bin"]);
    const id = await fileAndWait(r);
    r.set("throw");
    governance.approve(id);
    await waitFor(() => stageOf(id) === "failed", "failed");
    expect(r.runs).toEqual([]);
    expect(itemOf(id).error).toMatch(/could not look at the targets again/);
  });

  it("fewer files than were shown is fine: the run never reaches beyond the shown list", async () => {
    const r = rig(["a.bin", "b.bin"]);
    const id = await fileAndWait(r);
    r.set(["a.bin"]);
    governance.approve(id);
    await waitFor(() => stageOf(id) === "completed", "completed");
    expect(r.runs).toHaveLength(1);
  });
});

describe("a yes given after a restart is used once, and only for the same item", () => {
  // A restart leaves the filed item in the queue with no live answer waiting for it.
  function restart(): void {
    (governance as unknown as { waiting: Map<string, unknown> }).waiting.clear();
  }

  it("runs the item when it is filed again, without asking a second time", async () => {
    const first = rig(["a.bin"]);
    const id = await fileAndWait(first);
    restart();
    governance.approve(id);
    expect(stageOf(id)).toBe("proposed");
    expect(typeof itemOf(id).ownerApprovedAt).toBe("number");

    const next = rig(["a.bin"]);
    next.onRun(() => {
      next.set([]);
      return { ok: true, value: { deleted: ["a.bin"], failed: [] } };
    });
    await reviewEnabledAgents(next.host);
    await waitFor(() => stageOf(id) === "completed", "completed after the restart");
    expect(next.runs).toHaveLength(1);
    // spent: it does not run again, and it carries no approval any more
    expect(itemOf(id).ownerApprovedAt).toBeUndefined();
    await reviewEnabledAgents(next.host);
    await tick();
    expect(next.runs).toHaveLength(1);
  });

  it("a yes that is too old is not used: the owner is asked again", async () => {
    const first = rig(["a.bin"]);
    const id = await fileAndWait(first);
    restart();
    governance.approve(id);
    (governance as unknown as { patch: (id: string, next: Partial<GovItem>) => void }).patch(id, {
      ownerApprovedAt: Date.now() - CARRIED_APPROVAL_MS - 60_000,
    });

    const next = rig(["a.bin"]);
    await reviewEnabledAgents(next.host);
    await waitFor(() => stageOf(id) === "waiting-approval", "waiting again");
    expect(next.runs).toEqual([]);
  });

  it("is not used while Stop everything is on", async () => {
    const first = rig(["a.bin"]);
    const id = await fileAndWait(first);
    restart();
    governance.approve(id);
    autonomy.stopEverything();

    const next = rig(["a.bin"]);
    await reviewEnabledAgents(next.host);
    await waitFor(() => stageOf(id) === "failed", "failed");
    expect(next.runs).toEqual([]);
    expect(itemOf(id).error).toBe("Stopped.");
  });

  it("a rejection after a restart is final: the item is not filed or run again", async () => {
    const first = rig(["a.bin"]);
    const id = await fileAndWait(first);
    restart();
    governance.reject(id);
    expect(stageOf(id)).toBe("rejected");

    const next = rig(["a.bin"]);
    await reviewEnabledAgents(next.host);
    await tick();
    expect(next.runs).toEqual([]);
    expect(stageOf(id)).toBe("rejected");
  });

  it("an item never approved is not run just because it is filed again", async () => {
    const first = rig(["a.bin"]);
    const id = await fileAndWait(first);
    restart();
    const next = rig(["a.bin"]);
    await reviewEnabledAgents(next.host);
    await tick();
    expect(next.runs).toEqual([]);
    expect(itemOf(id).ownerApprovedAt).toBeUndefined();
  });
});

describe("contracts the live path uses that no test named before", () => {
  it("retries are bounded: three attempts, then stop", () => {
    expect([0, 1, 2, 3, 9].map((n) => retryBackoffMs(n))).toEqual([0, 2000, 8000, null, null]);
  });

  it("a budget stops the run at each of its four limits, and not before", () => {
    const budget = { maxSteps: 3, timeMs: 1000, spend: 0, tokens: 100 };
    expect(budgetBlock(budget, { steps: 2, ms: 1000, spend: 0, tokens: 100 })).toBeNull();
    expect(budgetBlock(budget, { steps: 3, ms: 0, spend: 0, tokens: 0 })).toBe(
      "step budget reached",
    );
    expect(budgetBlock(budget, { steps: 0, ms: 1001, spend: 0, tokens: 0 })).toBe(
      "time budget reached",
    );
    expect(budgetBlock(budget, { steps: 0, ms: 0, spend: 0.01, tokens: 0 })).toBe(
      "spend budget reached",
    );
    expect(budgetBlock(budget, { steps: 0, ms: 0, spend: 0, tokens: 101 })).toBe(
      "token budget reached",
    );
  });

  it("every action gets its own identity, tied to its task and step", () => {
    const one = mintIdentity("task-7", 2);
    const two = mintIdentity("task-7", 2);
    expect(one.taskId).toBe("task-7");
    expect(one.stepId).toBe("task-7-step-2");
    expect(one.actionId).not.toBe(two.actionId);
    expect(one.evidenceId).not.toBe(two.evidenceId);
  });

  it("the same action on the same target with the same arguments has the same duplicate-guard key", () => {
    expect(idempotencyKey("delete", "D:\\a.bin", "x")).toBe(
      idempotencyKey("delete", "D:\\a.bin", "x"),
    );
    expect(idempotencyKey("delete", "D:\\a.bin", "x")).not.toBe(
      idempotencyKey("delete", "D:\\b.bin", "x"),
    );
  });
});
