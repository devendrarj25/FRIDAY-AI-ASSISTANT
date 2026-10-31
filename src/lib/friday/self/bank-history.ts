/**
 * FRIDAY · the last Brain check, kept so the next one can say what changed
 *
 * The bank scores itself in the app. Without a record of the last run, "no problems" and "something slipped" look
 * the same. This keeps the previous run (one boolean per task), compares it with the new one task by task using
 * the same paired test as the offline A/B, and builds the one weighted figure with its interval and its unscored
 * share. Only booleans are stored.
 */

import { readLocalState, writeState } from "../persist";
import {
  compareBankRuns,
  type BankComparison,
  type BankRun,
  type CategoryResult,
} from "./benchmark-bank";
import { brainScore, type BrainScore, type DomainResult } from "./eval-stats";

const KEY = "friday.bank-last.v1";
let last: BankRun | null | undefined;

export const toRun = (results: readonly CategoryResult[], commit = "app"): BankRun => ({
  commit,
  categories: Object.fromEntries(results.map((row) => [row.id, row.outcomes])),
});

export function previousBankRun(): BankRun | null {
  if (last === undefined) {
    const stored = readLocalState<BankRun>(KEY);
    last = stored && typeof stored === "object" && stored.categories ? stored : null;
  }
  return last;
}

export function recordBankRun(results: readonly CategoryResult[]): void {
  last = toRun(results);
  writeState(KEY, last);
}

export function domainResults(results: readonly CategoryResult[]): DomainResult[] {
  const by = new Map<string, DomainResult>();
  for (const row of results) {
    const entry = by.get(row.domain) ?? { domain: row.domain, passed: 0, runs: 0 };
    entry.passed += row.passed;
    entry.runs += row.total;
    by.set(row.domain, entry);
  }
  return [...by.values()];
}

export type BankReport = {
  score: BrainScore;
  changes: BankComparison[];
  hadPrevious: boolean;
};

/** The weighted score and what moved since the last run. Call it before `recordBankRun` for the same results. */
export function reportBank(results: readonly CategoryResult[]): BankReport {
  const before = previousBankRun();
  const changes = before
    ? compareBankRuns(before, toRun(results)).filter(
        (row) => row.verdict !== "no measurable difference" && row.verdict !== "different fixtures",
      )
    : [];
  return { score: brainScore(domainResults(results)), changes, hadPrevious: Boolean(before) };
}

export function describeBankReport(report: BankReport): string[] {
  const pct = (n: number) => `${Math.round(n)}%`;
  const lines: string[] = [];
  const s = report.score;
  if (s.score === null) {
    lines.push("No domain has enough task-runs for a weighted score yet.");
  } else {
    lines.push(
      `Weighted over the domains that have enough runs: ${pct(s.score)} [${pct(s.low ?? 0)}–${pct(s.high ?? 0)} at 95%]. ${Math.round(s.unscoredWeight * 100)}% of the weight is unscored${
        s.insufficient.length ? ` (too few runs: ${s.insufficient.join(", ")})` : ""
      }.`,
    );
  }
  if (!report.hadPrevious)
    lines.push("This is the first check kept; the next one will say what moved.");
  else if (!report.changes.length)
    lines.push("Nothing moved since the last check at this sample size.");
  else {
    for (const row of report.changes.slice(0, 6)) {
      lines.push(
        `${row.id}: ${row.verdict} (${row.passA}/${row.tasks} → ${row.passB}/${row.tasks}, p=${row.p.toFixed(2)})`,
      );
    }
  }
  return lines;
}

export function resetBankHistoryForTests(): void {
  last = null;
  writeState(KEY, null);
}
