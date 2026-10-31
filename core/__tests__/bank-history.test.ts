import { beforeEach, describe, expect, it } from "vitest";
import {
  describeBankReport,
  recordBankRun,
  reportBank,
  resetBankHistoryForTests,
} from "../../src/lib/friday/self/bank-history";
import { runBank, type CategoryResult } from "../../src/lib/friday/self/benchmark-bank";

describe("the Brain check remembers its last run", () => {
  beforeEach(() => resetBankHistoryForTests());

  it("says it is the first check, then that nothing moved", async () => {
    const results = await runBank();
    const first = reportBank(results);
    expect(first.hadPrevious).toBe(false);
    expect(describeBankReport(first).join(" ")).toMatch(/first check kept/);
    recordBankRun(results);
    const second = reportBank(await runBank());
    expect(second.hadPrevious).toBe(true);
    expect(second.changes).toEqual([]);
    expect(describeBankReport(second).join(" ")).toMatch(/Nothing moved/);
  });

  it("names a category that got worse, with the paired test", async () => {
    const results = await runBank();
    recordBankRun(results);
    const target = results.find((row) => row.total >= 6 && row.passed === row.total);
    expect(target).toBeTruthy();
    const worse: CategoryResult[] = results.map((row) =>
      row.id === target!.id ? { ...row, passed: 0, outcomes: row.outcomes.map(() => false) } : row,
    );
    const report = reportBank(worse);
    expect(report.changes.some((row) => row.id === target!.id && row.verdict === "worse")).toBe(
      true,
    );
  });

  it("gives the weighted figure with its interval and what stays unscored", async () => {
    const lines = describeBankReport(reportBank(await runBank())).join(" ");
    expect(lines).toMatch(/Weighted over the domains|No domain has enough/);
    expect(lines).toMatch(/unscored|enough task-runs/);
  });
});

describe("what got worse is kept for the approval of a change to FRIDAY herself", () => {
  it("lists the worse categories of the latest check, and only changes to FRIDAY herself are held to it", async () => {
    const { latestRegressions, SELF_CHANGE_KINDS } =
      await import("../../src/lib/friday/self/bank-history");
    const results = await runBank();
    recordBankRun(results);
    expect(latestRegressions()).toEqual([]);
    const target = results.find((row) => row.total >= 6 && row.passed === row.total)!;
    const worse = results.map((row) =>
      row.id === target.id ? { ...row, passed: 0, outcomes: row.outcomes.map(() => false) } : row,
    );
    recordBankRun(worse);
    expect(latestRegressions()).toEqual([target.id]);
    expect(SELF_CHANGE_KINDS.has("self-upgrade")).toBe(true);
    expect(SELF_CHANGE_KINDS.has("research")).toBe(false);
  });
});
