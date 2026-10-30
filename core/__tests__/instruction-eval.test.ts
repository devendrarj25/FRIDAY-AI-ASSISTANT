/** The comparison is fair: the same checks judge both, and the first answer is shared. */
import { describe, expect, it } from "vitest";
import { checkAnswer } from "../../src/lib/friday/brain/answer-checks";
import {
  INSTRUCTION_TASKS,
  describeInstructionEval,
  runInstructionEval,
} from "../../src/lib/friday/self/instruction-eval";
import type { Rung } from "../../src/lib/friday/brain/verified-run";

const small: Rung = { id: "small", label: "small", modelIds: ["a"] };
const big: Rung = { id: "big", label: "big", modelIds: ["b"] };

describe("the tasks", () => {
  it("each carry at least one rule that can be checked, and ids are unique", () => {
    expect(new Set(INSTRUCTION_TASKS.map((t) => t.id)).size).toBe(INSTRUCTION_TASKS.length);
    for (const task of INSTRUCTION_TASKS) {
      expect(checkAnswer(task.prompt, "x").checked.length, task.id).toBeGreaterThan(2);
    }
    // 'identity' and 'code-syntax' are always checked; each task must add a rule of its own.
    for (const task of INSTRUCTION_TASKS) {
      const own = checkAnswer(task.prompt, "x").checked.filter(
        (id) => id !== "identity" && id !== "code-syntax",
      );
      expect(own.length, task.id).toBeGreaterThan(0);
    }
  });
});

describe("runInstructionEval", () => {
  it("shows the loop repairing what a sloppy model gets wrong, with no extra call for the first answer", async () => {
    let calls = 0;
    // A model that ignores the rules unless it is told what it broke.
    const ask = async (prompt: string, rung: Rung) => {
      calls += 1;
      if (rung.id === "small" && !prompt.includes("did not meet"))
        return "A Very Long Answer, With Commas And Many More Words";
      return "ok";
    };
    const tasks = INSTRUCTION_TASKS.filter(
      (t) => t.id === "words-8" || t.id === "lower" || t.id === "commas",
    );
    const report = await runInstructionEval({ ask, rungs: [small, big], tasks });
    expect(report.tasks).toBe(3);
    expect(report.bare).toBe(0);
    expect(report.brain).toBe(3);
    expect(report.repaired).toBe(3);
    expect(report.calls).toBe(calls);
    expect(calls).toBe(6); // 3 first answers, shared, plus 1 retry each
  });

  it("does not claim a win when the model already follows the rules", async () => {
    const tasks = INSTRUCTION_TASKS.filter((t) => t.id === "lower");
    const report = await runInstructionEval({ ask: async () => "hello", rungs: [small], tasks });
    expect(report).toMatchObject({ bare: 1, brain: 1, repaired: 0, calls: 1 });
  });

  it("reports what stayed broken, and an unreachable model", async () => {
    const tasks = INSTRUCTION_TASKS.filter((t) => t.id === "lower" || t.id === "commas");
    const stubborn = await runInstructionEval({
      ask: async () => "No, Thanks, Really",
      rungs: [small, big],
      tasks,
    });
    expect(stubborn.brain).toBe(0);
    expect(stubborn.stuck.map((s) => s.id)).toEqual(["lower", "commas"]);
    const offline = await runInstructionEval({
      ask: async () => {
        throw new Error("offline");
      },
      rungs: [small],
      tasks,
    });
    expect(offline).toMatchObject({ bare: 0, brain: 0, unanswered: 2 });
    const text = describeInstructionEval(offline);
    expect(text).toContain("unreachable");
    expect(text).toContain("do not measure whether an answer is true");
  });

  it("reports progress", async () => {
    const seen: number[] = [];
    await runInstructionEval({
      ask: async () => "ok",
      rungs: [small],
      tasks: INSTRUCTION_TASKS.slice(0, 3),
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});
