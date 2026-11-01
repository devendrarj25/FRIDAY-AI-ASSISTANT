import { describe, expect, it } from "vitest";
import { askBrain, type BrainLike } from "../../src/lib/friday/self/ask-brain";
import type { Run } from "../../src/lib/friday/brain-engine";

function fakeBrain(
  script: (
    state: { runs: Run[]; activeRunId: string | null },
    emit: () => void,
    prompt: string,
  ) => void,
): BrainLike {
  const state = { runs: [] as Run[], activeRunId: null as string | null };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    send: (prompt) => {
      script(state, emit, prompt);
      return { accepted: true };
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => ({ activeRunId: state.activeRunId, runs: state.runs }),
  };
}

const run = (over: Partial<Run>): Run =>
  ({ id: "r1", prompt: "q", state: "running", answer: "", ...over }) as Run;

describe("asking the whole Brain", () => {
  it("returns the finished run's answer, not a half answer", async () => {
    const brain = fakeBrain((state, emit, prompt) => {
      state.runs = [run({ prompt })];
      state.activeRunId = "r1";
      setTimeout(() => {
        state.runs = [run({ prompt, answer: "Delhi", state: "done" })];
        state.activeRunId = null;
        emit();
      }, 20);
    });
    await expect(askBrain("capital of India?", { brain })).resolves.toEqual({
      answer: "Delhi",
      verified: true,
    });
  });

  it("rejects a turn that failed with no answer, and one that never finishes", async () => {
    const failing = fakeBrain((state, emit, prompt) => {
      state.runs = [run({ prompt, state: "failed", answer: "" })];
      emit();
    });
    await expect(askBrain("q", { brain: failing })).rejects.toThrow(/failed without an answer/);
    const stuck = fakeBrain((state, _e, prompt) => {
      state.runs = [run({ prompt })];
      state.activeRunId = "r1";
    });
    await expect(askBrain("q2", { brain: stuck, timeoutMs: 50 })).rejects.toThrow(/did not finish/);
  });

  it("says why when the Brain does not take the request", async () => {
    const refusing: BrainLike = {
      send: () => ({
        accepted: false,
        reason: "busy",
        message: "I'm still working on the last request.",
      }),
      subscribe: () => () => undefined,
      getSnapshot: () => ({ activeRunId: null, runs: [] }),
    };
    await expect(askBrain("q", { brain: refusing })).rejects.toThrow(/still working/);
  });

  it("ignores runs that were already there before it asked", async () => {
    const brain = fakeBrain((state, emit, prompt) => {
      state.runs = [...state.runs, run({ id: "r2", prompt, answer: "fresh", state: "done" })];
      emit();
    });
    brain
      .getSnapshot()
      .runs.push(run({ id: "old", prompt: "same", answer: "stale", state: "done" }));
    await expect(askBrain("same", { brain })).resolves.toMatchObject({ answer: "fresh" });
  });
});
