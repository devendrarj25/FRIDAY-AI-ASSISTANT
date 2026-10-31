import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareBankRuns,
  type BankComparison,
  type BankRun,
} from "../../src/lib/friday/self/benchmark-bank";

const mk = (categories: Record<string, boolean[]>): BankRun => ({ commit: "x", categories });
const ten = (n: number) => Array.from({ length: 10 }, (_, i) => i < n);

describe("comparing two runs of the bank", () => {
  it("pairs tasks and only calls a significant difference better or worse", () => {
    const rows = compareBankRuns(
      mk({ "intent-route": ten(2), arithmetic: ten(9), "source-class": ten(10) }),
      mk({ "intent-route": ten(10), arithmetic: ten(8), "source-class": ten(10) }),
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId["intent-route"]).toMatchObject({
      verdict: "better",
      passA: 2,
      passB: 10,
      domain: "cognitive",
    });
    expect(byId["arithmetic"]?.verdict).toBe("no measurable difference");
    expect(byId["source-class"]).toMatchObject({ delta: 0, verdict: "no measurable difference" });
  });

  it("marks a category present on one side or with different fixtures as not comparable", () => {
    const rows = compareBankRuns(mk({ a: ten(3), b: ten(3) }), mk({ a: [true, true], c: ten(1) }));
    expect(rows.map((row) => [row.id, row.verdict])).toEqual([
      ["a", "different fixtures"],
      ["b", "different fixtures"],
      ["c", "different fixtures"],
    ]);
    expect(rows.find((row) => row.id === "a")?.domain).toBe("unknown");
  });

  it("reads two saved runs when the A/B script hands them over", () => {
    const a = process.env["FRIDAY_BENCH_A"];
    const b = process.env["FRIDAY_BENCH_B"];
    if (!a || !b) return; // only meaningful when scripts/brain-ab.cjs supplies two runs
    const rows: BankComparison[] = compareBankRuns(
      JSON.parse(readFileSync(a, "utf8")) as BankRun,
      JSON.parse(readFileSync(b, "utf8")) as BankRun,
    );
    const out = process.env["FRIDAY_BENCH_REPORT"];
    if (out) writeFileSync(out, JSON.stringify(rows, null, 1), "utf8");
    expect(rows.length).toBeGreaterThan(0);
  });
});
