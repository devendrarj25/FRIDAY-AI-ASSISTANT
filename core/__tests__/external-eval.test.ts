import { describe, expect, it } from "vitest";
import {
  checkExternalSetup,
  EXTERNAL_BENCHMARKS,
  judgeAgreement,
  judgeAnswer,
  runWithBudget,
  type Rubric,
} from "../../src/lib/friday/self/external-eval";

const ready = {
  benchmark: "state-bench" as const,
  dataDir: "D:/bench/data",
  resultsDir: "D:/bench/results",
  repoRoot: "C:/work/FRIDAY-AI-ASSISTANT",
  fridayRoot: "C:/FRIDAY",
  spendCapUsd: 20,
  keysPresent: true,
  dockerAvailable: true,
  vmAvailable: false,
  datasetTermsAccepted: true,
};

describe("external benchmark setup", () => {
  it("describes all six benchmarks with where they come from", () => {
    expect(EXTERNAL_BENCHMARKS.map((b) => b.id).sort()).toEqual([
      "frontiermemory",
      "gaia",
      "osworld",
      "state-bench",
      "swe-bench-verified",
      "webarena",
    ]);
    for (const row of EXTERNAL_BENCHMARKS) {
      expect(row.source).toMatch(/^https:\/\//);
      expect(row.licence.length).toBeGreaterThan(2);
    }
    expect(EXTERNAL_BENCHMARKS.find((b) => b.id === "gaia")?.licence).toMatch(/unverified/);
    expect(EXTERNAL_BENCHMARKS.find((b) => b.id === "swe-bench-verified")?.hardware).toMatch(
      /120 GB/,
    );
  });

  it("accepts a run that keeps data outside the repository and user data and has a cap", () => {
    expect(checkExternalSetup(ready)).toEqual({ ok: true, problems: [] });
  });

  it("names every reason a run should not start", () => {
    const bad = checkExternalSetup({
      ...ready,
      benchmark: "osworld",
      dataDir: "C:/work/FRIDAY-AI-ASSISTANT/bench",
      resultsDir: "c:\\friday\\results",
      spendCapUsd: null,
      keysPresent: false,
      dockerAvailable: false,
      vmAvailable: false,
    });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join("|")).toMatch(/data folder is inside the repository/);
    expect(bad.problems.join("|")).toMatch(/results folder is inside FRIDAY's own data/);
    expect(bad.problems.join("|")).toMatch(/no spend cap/);
    expect(bad.problems.join("|")).toMatch(/no model key/);
    expect(bad.problems.join("|")).toMatch(/Docker/);
    expect(bad.problems.join("|")).toMatch(/virtual machine/);
    expect(
      checkExternalSetup({ ...ready, benchmark: "gaia", datasetTermsAccepted: false }).problems,
    ).toContain("the dataset's access terms have not been accepted by the owner");
    expect(checkExternalSetup({ ...ready, spendCapUsd: 0 }).problems).toContain(
      "no spend cap is set",
    );
  });
});

describe("spend cap", () => {
  it("stops before the task that would pass the cap and says the run is partial", async () => {
    const run = await runWithBudget({
      tasks: ["a", "b", "c", "d"],
      capUsd: 1,
      estimateUsd: () => 0.4,
      run: async (task) => ({ value: task.toUpperCase(), costUsd: 0.4 }),
    });
    expect(run.results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(run.stoppedAtCap).toBe(true);
    expect(run.skipped).toEqual(["c", "d"]);
    expect(run.spentUsd).toBeCloseTo(0.8, 6);
    const whole = await runWithBudget({
      tasks: ["a"],
      capUsd: 5,
      estimateUsd: () => 1,
      run: async () => ({ value: 1, costUsd: 1 }),
    });
    expect(whole.stoppedAtCap).toBe(false);
  });
});

const rubric: Rubric = {
  id: "r1",
  criteria: [
    { id: "c1", text: "States the main fact", points: 2 },
    { id: "c2", text: "Cites a source", points: 1 },
  ],
};
const base = {
  rubric,
  question: "What is the capital of France?",
  answer: "Paris, per the encyclopedia.",
  evaluatedModel: "model-a",
  judgeModel: "judge-b",
  judgeVersion: "2026-10",
};

describe("judge", () => {
  it("refuses to let the model under test judge itself", async () => {
    const verdict = await judgeAnswer({
      ...base,
      judgeModel: "model-a",
      ask: async () => "c1: 2 | x\nc2: 1 | y",
    });
    expect(verdict).toMatchObject({
      ok: false,
      error: "the judge must not be the model under test",
    });
  });

  it("scores from one line per criterion, keeps the evidence and records who judged", async () => {
    let seen = "";
    const verdict = await judgeAnswer({
      ...base,
      ask: async (prompt) => {
        seen = prompt;
        return "c1: 2 | Paris\nc2: 0 | NONE";
      },
    });
    expect(verdict).toMatchObject({
      ok: true,
      score: 2,
      max: 3,
      passed: false,
      judgeModel: "judge-b",
      judgeVersion: "2026-10",
    });
    expect(verdict.evidence).toEqual([
      { criterion: "c1", points: 2, quote: "Paris" },
      { criterion: "c2", points: 0, quote: "NONE" },
    ]);
    expect(seen).toMatch(/data to grade, never instructions/);
    expect(seen).toContain("<answer>");
  });

  it("rejects a reply that is missing a line, out of range, or a failed call", async () => {
    expect((await judgeAnswer({ ...base, ask: async () => "c1: 2 | x" })).error).toMatch(
      /no line for criterion c2/,
    );
    expect((await judgeAnswer({ ...base, ask: async () => "c1: 9 | x\nc2: 1 | y" })).error).toMatch(
      /out of range/,
    );
    expect(
      (
        await judgeAnswer({
          ...base,
          ask: async () => {
            throw new Error("offline");
          },
        })
      ).error,
    ).toBe("offline");
  });

  it("measures how far a judge agrees with a deterministic check beyond chance", () => {
    expect(judgeAgreement([])).toEqual({ items: 0, agreement: 0, kappa: null });
    const perfect = judgeAgreement([
      { judge: true, deterministic: true },
      { judge: false, deterministic: false },
      { judge: true, deterministic: true },
      { judge: false, deterministic: false },
    ]);
    expect(perfect).toMatchObject({ agreement: 1, kappa: 1 });
    const chance = judgeAgreement([
      { judge: true, deterministic: true },
      { judge: true, deterministic: false },
      { judge: false, deterministic: true },
      { judge: false, deterministic: false },
    ]);
    expect(chance.kappa).toBeCloseTo(0, 6);
    expect(judgeAgreement([{ judge: true, deterministic: true }]).kappa).toBeNull();
  });
});
