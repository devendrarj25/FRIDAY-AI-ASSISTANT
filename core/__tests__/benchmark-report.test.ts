import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runBank, type BankRun } from "../../src/lib/friday/self/benchmark-bank";

/**
 * Runs the bank. With FRIDAY_BENCH_OUT set (by scripts/brain-ab.cjs) it also writes the per-task outcomes
 * to that file, outside the repository, so two checkouts can be compared.
 */
describe("benchmark report", () => {
  it("runs the bank and, when asked, writes the outcomes", async () => {
    const results = await runBank();
    expect(results.length).toBeGreaterThan(30);
    const run: BankRun = {
      commit: process.env["FRIDAY_BENCH_COMMIT"] ?? "working-tree",
      categories: Object.fromEntries(results.map((row) => [row.id, row.outcomes])),
    };
    const out = process.env["FRIDAY_BENCH_OUT"];
    if (out) writeFileSync(out, JSON.stringify(run, null, 1), "utf8");
    expect(Object.keys(run.categories)).toHaveLength(results.length);
  });
});
