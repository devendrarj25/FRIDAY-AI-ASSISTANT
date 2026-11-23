/**
 * Run ownership and scoped stop in the Brain.
 *
 * `send(prompt, { owner })` tags a run with the task it belongs to. `stop()` keeps today's meaning (it ends
 * whatever runs) unless a scope is given: `"foreground"` leaves a task-owned run alone, `{ taskId }` ends only
 * that task's run. `askBrain` finds its own run by the id `send` returns, never by the prompt text. The quick
 * lane tells the conductor its answer through `onQuickAnswer`.
 *
 * The desktop bridge is a fake: `window.friday` records `sendChat` and `abortChat`; the Core Brain pass is held
 * so no model, network, memory write or real clock is reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopReaches } from "../../src/lib/friday/self/brain-draft";
import { askBrain, type BrainLike } from "../../src/lib/friday/self/ask-brain";
import type { Run } from "../../src/lib/friday/brain-engine";

const globals = globalThis as unknown as { window?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}

const aborted: string[] = [];
const sentChats: Array<Record<string, unknown>> = [];
(globalThis as unknown as { friday?: unknown }).friday = {
  sendChat: (request: Record<string, unknown>) => {
    sentChats.push(request);
    return String(request["requestId"]);
  },
  abortChat: (requestId: string) => {
    aborted.push(requestId);
  },
  onChatDelta: () => () => undefined,
  onChatTool: () => () => undefined,
  onChatDone: () => () => undefined,
  onChatError: () => () => undefined,
};

const { brain } = await import("../../src/lib/friday/brain-engine");
const { coreBrain } = await import("../../src/lib/friday/brain/core-brain");
const modelRegistryModule = await import("../../src/lib/friday/model-registry");
const askModule = await import("../../src/lib/friday/ask");

type Inner = { state: { runs: Run[]; activeRunId: string | null; messages: unknown[] } };
const inner = brain as unknown as Inner;

/** A prompt the model path takes (no baseline answer, no command). */
const QUESTION = "explain how a transformer attention head works in detail please";

function reset() {
  inner.state.runs = [];
  inner.state.activeRunId = null;
  aborted.length = 0;
  sentChats.length = 0;
}

beforeEach(() => {
  reset();
  // The Core Brain pass is held: the run stays "running" with no model and no memory write.
  vi.spyOn(coreBrain, "cognize").mockReturnValue(new Promise(() => undefined) as never);
});

afterEach(() => {
  brain.stop("all");
  vi.restoreAllMocks();
});

const activeRun = () => inner.state.runs.find((run) => run.id === inner.state.activeRunId);

describe("stopReaches (the scope rule)", () => {
  const owned = { kind: "task", taskId: "t1" } as const;
  it("all reaches everything, foreground only an unowned run, a task id only its own run", () => {
    expect(stopReaches("all", undefined)).toBe(true);
    expect(stopReaches("all", owned)).toBe(true);
    expect(stopReaches("foreground", undefined)).toBe(true);
    expect(stopReaches("foreground", owned)).toBe(false);
    expect(stopReaches({ taskId: "t1" }, owned)).toBe(true);
    expect(stopReaches({ taskId: "t2" }, owned)).toBe(false);
    expect(stopReaches({ taskId: "t1" }, undefined)).toBe(false);
  });
});

describe("run ownership and scoped stop", () => {
  it("send with an owner stores it on the run and returns the run id", () => {
    const result = brain.send(QUESTION, { owner: { kind: "task", taskId: "t1" } });
    expect(result.accepted).toBe(true);
    const run = activeRun();
    expect(run?.owner).toEqual({ kind: "task", taskId: "t1" });
    expect(result.runId).toBe(run?.id);
  });

  it("a send without an owner leaves the run unowned (defaults unchanged)", () => {
    const result = brain.send(QUESTION);
    expect(result.accepted).toBe(true);
    expect(activeRun()?.owner).toBeUndefined();
    expect(result.runId).toBe(activeRun()?.id);
  });

  it("foreground stop leaves a task-owned run running and aborts nothing", () => {
    brain.send(QUESTION, { owner: { kind: "task", taskId: "t1" } });
    const run = activeRun()!;
    brain.stop("foreground");
    expect(run.state).toBe("running");
    expect(inner.state.activeRunId).toBe(run.id);
    expect(aborted).toEqual([]);
    // restorable: the run is still found by its task
    expect(brain.ownedRun("t1")?.id).toBe(run.id);
    expect(brain.ownedRun("t2")).toBeUndefined();
  });

  it("a stop for another task leaves the run; a stop for its own task ends only it", () => {
    brain.send(QUESTION, { owner: { kind: "task", taskId: "t1" } });
    const run = activeRun()!;
    brain.stop({ taskId: "t2" });
    expect(run.state).toBe("running");
    brain.stop({ taskId: "t1" });
    expect(run.state).toBe("failed");
    expect(aborted).toEqual([`chat-${run.id}`]);
    expect(inner.state.activeRunId).toBeNull();
  });

  it("the default stop ends a task-owned run exactly as before (UI Stop, kill switch)", () => {
    brain.send(QUESTION, { owner: { kind: "task", taskId: "t1" } });
    const run = activeRun()!;
    brain.stop();
    expect(run.state).toBe("failed");
    expect(aborted).toEqual([`chat-${run.id}`]);
  });

  it("clearChat ends a task-owned run too", () => {
    brain.send(QUESTION, { owner: { kind: "task", taskId: "t1" } });
    const run = activeRun()!;
    brain.clearChat();
    expect(run.state).toBe("failed");
    expect(inner.state.activeRunId).toBeNull();
  });

  it("a foreground stop still ends an unowned run", () => {
    brain.send(QUESTION);
    const run = activeRun()!;
    brain.stop("foreground");
    expect(run.state).toBe("failed");
  });

  it("stop with nothing running is harmless", () => {
    brain.stop();
    brain.stop("foreground");
    brain.stop({ taskId: "t1" });
    expect(aborted).toEqual([]);
    expect(inner.state.activeRunId).toBeNull();
  });
});

describe("askBrain finds its run by id, not by the prompt", () => {
  const row = (over: Partial<Run>): Run =>
    ({ id: "r?", prompt: "same words", state: "done", answer: "", ...over }) as Run;

  function fakeBrain(runId: string | undefined): BrainLike {
    const state = { runs: [] as Run[], activeRunId: null as string | null };
    return {
      send: () => {
        // Another turn with the very same words finished first and sits at the top of the list.
        state.runs = [
          row({ id: "other", answer: "WRONG ANSWER" }),
          row({ id: "mine", answer: "RIGHT ANSWER" }),
        ];
        return { accepted: true, ...(runId ? { runId } : {}) };
      },
      subscribe: () => () => undefined,
      getSnapshot: () => ({ activeRunId: state.activeRunId, runs: state.runs }),
    } as never;
  }

  it("two equal prompts: the run the send returned is the one answered", async () => {
    await expect(askBrain("same words", { brain: fakeBrain("mine") })).resolves.toEqual({
      answer: "RIGHT ANSWER",
      verified: true,
    });
  });

  it("a brain that returns no run id still resolves by the prompt, as before", async () => {
    await expect(askBrain("same words", { brain: fakeBrain(undefined) })).resolves.toEqual({
      answer: "WRONG ANSWER",
      verified: true,
    });
  });

  it("with the real Brain the id askBrain waits on is the run id of the send", async () => {
    const seen: string[] = [];
    const real = {
      send: (prompt: string) => {
        const result = brain.send(prompt);
        if (result.runId) seen.push(result.runId);
        return result;
      },
      subscribe: brain.subscribe,
      getSnapshot: brain.getSnapshot,
    } as unknown as BrainLike;
    const pending = askBrain(QUESTION, { brain: real, timeoutMs: 40 });
    await expect(pending).rejects.toThrow(/did not finish/);
    expect(seen).toEqual([activeRun()?.id]);
  });
});

describe("onQuickAnswer", () => {
  it("tells the conductor the quick answer, with the question, and stops listening when asked", async () => {
    vi.spyOn(modelRegistryModule.modelRegistry, "getSnapshot").mockReturnValue({
      ...modelRegistryModule.modelRegistry.getSnapshot(),
      models: [],
    });
    vi.spyOn(askModule, "canAsk").mockReturnValue(true);
    vi.spyOn(askModule, "askFriday").mockResolvedValue("It is a plain answer.");
    brain.send(QUESTION, { owner: { kind: "task", taskId: "t1" } });
    const heard: Array<{ text: string; question: string; ok: boolean; surface: string }> = [];
    const off = brain.onQuickAnswer((answer) => heard.push(answer));
    const result = brain.send("what is a prime number?");
    expect(result.reason).toBe("quick-lane");
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toMatchObject({
      text: "It is a plain answer.",
      question: "what is a prime number?",
      ok: true,
    });
    off();
    brain.send("what is a square number?");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).toHaveLength(1);
  });
});
