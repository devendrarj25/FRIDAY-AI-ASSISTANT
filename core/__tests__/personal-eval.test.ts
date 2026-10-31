import { beforeEach, describe, expect, it } from "vitest";
import {
  comparePersonalRuns,
  describePersonalRun,
  parsePersonalTasks,
  personalHistory,
  recordPersonalRun,
  resetPersonalHistoryForTests,
  runPersonalEval,
  scoreAnswer,
} from "../../src/lib/friday/self/personal-eval";

const answer =
  (text: string, verified = false) =>
  async () => ({ answer: text, verified });

describe("personal eval: reading tasks", () => {
  it("reads the line format with every part", () => {
    const { tasks, problems } = parsePersonalTasks(
      "kal ki meeting kab hai || must: kal, meeting || not: pata nahi || tag: calendar\n# comment\nsum 2+2 || re: \\b4\\b || verified",
    );
    expect(problems).toEqual([]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      must: ["kal", "meeting"],
      mustNot: ["pata nahi"],
      tags: ["calendar"],
    });
    expect(tasks[1]).toMatchObject({ pattern: "\\b4\\b", verified: true });
  });

  it("reads JSON and refuses a task that could never fail", () => {
    const { tasks, problems } = parsePersonalTasks(
      JSON.stringify([
        { id: "a", prompt: "hi", must: ["hello"] },
        { id: "b", prompt: "free pass" },
      ]),
    );
    expect(tasks.map((t) => t.id)).toEqual(["a"]);
    expect(problems[0]).toMatch(/could never fail/);
  });

  it("reports a bad pattern, an unknown part and unreadable JSON", () => {
    expect(parsePersonalTasks("x || re: (").problems.join(" ")).toMatch(
      /not a valid regular expression/,
    );
    expect(parsePersonalTasks("x || colour: red").problems.join(" ")).toMatch(/not a known part/);
    expect(parsePersonalTasks("[oops").problems).toEqual(["the JSON could not be read"]);
    expect(parsePersonalTasks("   ").problems).toEqual(["there is nothing to read"]);
  });
});

describe("personal eval: scoring and running", () => {
  const task = parsePersonalTasks("q || must: Delhi || not: sorry || verified").tasks[0]!;

  it("scores by rules only, case-insensitively", () => {
    expect(scoreAnswer(task, { answer: "It is in DELHI.", verified: true }).passed).toBe(true);
    expect(scoreAnswer(task, { answer: "sorry, Delhi", verified: true }).why).toEqual([
      'contains "sorry"',
    ]);
    expect(scoreAnswer(task, { answer: "Delhi", verified: false }).why).toEqual([
      "the answer was not verified",
    ]);
    expect(scoreAnswer(task, { answer: "", verified: true }).why[0]).toBe("no answer came back");
  });

  it("runs every task, counts a throw as a miss and reports an interval", async () => {
    const tasks = parsePersonalTasks("a || must: yes\nb || must: yes\nc || must: yes").tasks;
    let n = 0;
    const run = await runPersonalEval(tasks, async () => {
      n += 1;
      if (n === 3) throw new Error("model offline");
      return { answer: n === 2 ? "no" : "yes", verified: true };
    });
    expect(run.passed).toBe(1);
    expect(run.total).toBe(3);
    expect(run.outcomes[2]?.why[0]).toMatch(/model offline/);
    expect(run.interval.high).toBeGreaterThan(run.interval.low);
    expect(describePersonalRun(run)).toMatch(/1\/3 passed the first time/);
  });

  it("separates pass at one from pass at k", async () => {
    const tasks = parsePersonalTasks("a || must: yes").tasks;
    let n = 0;
    const run = await runPersonalEval(
      tasks,
      async () => ({ answer: ++n === 2 ? "yes" : "no", verified: true }),
      { repeats: 3 },
    );
    expect(run.passed).toBe(0);
    expect(run.passedAny).toBe(1);
  });

  it("compares two runs on the tasks they share", async () => {
    const tasks = parsePersonalTasks("a || must: ok\nb || must: ok").tasks;
    const older = await runPersonalEval(tasks, async () => ({ answer: "nope", verified: true }));
    const newer = await runPersonalEval(tasks, async () => ({ answer: "ok", verified: true }));
    const diff = comparePersonalRuns(older, newer);
    expect(diff.fixed).toEqual(["task-1", "task-2"]);
    expect(diff.broke).toEqual([]);
    expect(diff.delta).toBe(1);
  });
});

describe("personal eval: history", () => {
  beforeEach(() => resetPersonalHistoryForTests());

  it("keeps the latest runs", async () => {
    const tasks = parsePersonalTasks("a || must: ok").tasks;
    for (let i = 0; i < 14; i += 1)
      recordPersonalRun(await runPersonalEval(tasks, answer("ok"), { now: () => i }));
    expect(personalHistory()).toHaveLength(12);
  });
});
