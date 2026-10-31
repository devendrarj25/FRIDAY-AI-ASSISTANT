/** The extra suites are fixed, offline and honest: they report their misses and they are repeatable. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSuiteHistoryForTests,
  describeSuites,
  passAllOfK,
  recordSuite,
  runAllSuites,
  runLongHorizonSuite,
  runRetrievalSuite,
  runRoutingSuite,
  suiteHistory,
  suiteRate,
} from "../../src/lib/friday/self/eval-suites";

describe("the suites", () => {
  beforeEach(() => clearSuiteHistoryForTests());

  it("retrieval finds the right fact first, and the newest for a question about now", () => {
    const report = runRetrievalSuite();
    expect(report.tasks).toBe(12);
    expect(suiteRate(report)).toBeGreaterThanOrEqual(0.75);
    expect(report.extra["recallAt3"]).toBeGreaterThanOrEqual(0.9);
    // The two time-sensitive pairs must be right, not just the average.
    const text = report.misses.join(" ");
    expect(text).not.toContain("city-now");
    expect(text).not.toContain("city-before");
    expect(text).not.toContain("phone-now");
    expect(text).not.toContain("phone-earlier");
  });

  it("routing matches the route and effort to the kind of ask", () => {
    const report = runRoutingSuite();
    expect(report.tasks).toBe(8);
    expect(suiteRate(report)).toBeGreaterThanOrEqual(0.75);
  });

  it("long-horizon finishes, repeats only what failed, and shares earlier results", async () => {
    const report = await runLongHorizonSuite();
    expect(report).toMatchObject({ tasks: 3, passed: 3, misses: [] });
  });

  it("is the same every time it runs", async () => {
    const first = [runRetrievalSuite(), runRoutingSuite()];
    const second = [runRetrievalSuite(), runRoutingSuite()];
    expect(second).toEqual(first);
  });
});

describe("pass-k reliability", () => {
  it("counts only the tasks that passed on every run", async () => {
    const report = await passAllOfK(["steady", "flaky", "broken"], 3, async (task, attempt) =>
      task === "steady" ? true : task === "flaky" ? attempt !== 1 : false,
    );
    expect(report).toMatchObject({ tasks: 3, passed: 1 });
    expect(report.extra["passAtLeastOnce"]).toBeCloseTo(2 / 3);
    expect(report.misses).toEqual(["flaky: passed 2 of 3", "broken: passed 0 of 3"]);
  });

  it("limits k to ten and at least one", async () => {
    expect((await passAllOfK(["a"], 99, async () => true)).extra["k"]).toBe(10);
    expect((await passAllOfK(["a"], 0, async () => true)).extra["k"]).toBe(1);
  });
});

describe("history", () => {
  beforeEach(() => clearSuiteHistoryForTests());

  it("keeps a result per run and at most twelve per suite", () => {
    const base = { suite: "routing" as const, tasks: 8, misses: [], extra: {} };
    for (let n = 0; n < 15; n += 1) recordSuite({ ...base, passed: n % 9 }, 1000 + n);
    recordSuite({ ...base, suite: "retrieval", tasks: 12, passed: 11 }, 5000);
    expect(suiteHistory("routing")).toHaveLength(12);
    expect(suiteHistory("routing")[0]?.at).toBe(1003);
    expect(suiteHistory("retrieval")).toHaveLength(1);
  });

  it("is written by runAllSuites and described in plain lines", async () => {
    const reports = await runAllSuites();
    expect(suiteHistory()).toHaveLength(4);
    const text = describeSuites(reports);
    expect(text).toMatch(/gates: \d+\/\d+ \(notChecked 1\)/);
    expect(text).toMatch(/retrieval: \d+\/\d+ \[\d+–\d+% at 95%\]/);
    expect(text).toContain("retrieval:");
    expect(text).toContain("long-horizon: 3/3");
  });
});
