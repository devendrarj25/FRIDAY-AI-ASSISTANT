/**
 * FRIDAY · benchmark fixtures, stored results and ablation runs
 *
 * A fixture is a small, deterministic task with its expected outcome written beside it. A result record names
 * the exact fixtures (by hash), the configuration and the limits of the run. `runAblation` answers "what is
 * this stage worth" by running the same fixtures with one optional stage off and comparing the pairs.
 */

import { withStagesOff, type MeasurableStage } from "../brain/stage-switches";
import { readLocalState, writeState } from "../persist";
import {
  BENCHMARK_VERSION,
  comparePaired,
  DOMAIN_WEIGHTS,
  fixtureHash,
  wilson,
  type DomainResult,
  type ResultRecord,
} from "./eval-stats";

export type Fixture<Input = unknown> = {
  id: string;
  domain: keyof typeof DOMAIN_WEIGHTS;
  category: string;
  input: Input;
  /** One line saying what a pass is, so a reader can audit the scorer. */
  expect: string;
};

/** Everything wrong with a fixture list; empty when it can be used. */
export function validateFixtures(list: readonly Fixture[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const fixture of list) {
    if (!fixture.id || !/^[\w.:-]{1,80}$/.test(fixture.id)) problems.push(`bad id ${fixture.id}`);
    if (seen.has(fixture.id)) problems.push(`duplicate id ${fixture.id}`);
    seen.add(fixture.id);
    if (!(fixture.domain in DOMAIN_WEIGHTS)) problems.push(`${fixture.id}: unknown domain`);
    if (!fixture.category.trim()) problems.push(`${fixture.id}: no category`);
    if (!fixture.expect.trim()) problems.push(`${fixture.id}: no expected outcome`);
  }
  return problems;
}

export function hashFixtures(list: readonly Fixture[]): string {
  return fixtureHash(list.map((fixture) => fixture.id));
}

/* ----------------------------------------------------------------- results */

export type StoredResult = {
  at: number;
  record: ResultRecord;
  domains: DomainResult[];
  /** Gate ids that failed. Any entry here blocks acceptance whatever the score is. */
  gateFailures: string[];
  notes: string[];
};

const KEY = "friday.eval-results.v1";
let cache: StoredResult[] | null = null;
const KEEP = 20;

export function makeRecord(
  input: Partial<ResultRecord> & Pick<ResultRecord, "fixtureHash" | "configuration">,
): ResultRecord {
  return {
    benchmark: "FRIDAY Brain Benchmark",
    version: BENCHMARK_VERSION,
    commit: "unknown",
    models: [],
    hardware: "unknown",
    seed: 0,
    k: 1,
    limitations: [],
    ...input,
  };
}

export function loadResults(): StoredResult[] {
  if (!cache) {
    const rows = readLocalState<StoredResult[]>(KEY);
    cache = Array.isArray(rows) ? rows : [];
  }
  return cache;
}

export function saveResult(result: StoredResult): void {
  cache = [...loadResults(), result].slice(-KEEP);
  writeState(KEY, cache);
}

export function clearResultsForTests(): void {
  cache = [];
  writeState(KEY, []);
}

/** A result is only accepted when no gate failed. The score does not matter if a gate did. */
export function accepted(result: StoredResult): boolean {
  return result.gateFailures.length === 0;
}

/* ---------------------------------------------------------------- ablation */

export type AblationRow = {
  /** One stage, or several joined with + when they were switched off together. */
  stage: string;
  tasks: number;
  baselinePass: number;
  withoutPass: number;
  delta: number;
  p: number;
  interval: { low: number; high: number };
  verdict: "helps" | "hurts" | "no measurable effect";
};

/**
 * Run `check` on every fixture with all stages on, then again with each named stage off, and compare the
 * paired results. "helps" and "hurts" need p < 0.05; anything else is "no measurable effect", which is an
 * honest and common answer on small fixture sets.
 */
export async function runAblation<Input>(
  fixtures: readonly Fixture<Input>[],
  stages: readonly (MeasurableStage | readonly MeasurableStage[])[],
  check: (fixture: Fixture<Input>) => Promise<boolean>,
): Promise<AblationRow[]> {
  const baseline: boolean[] = [];
  for (const fixture of fixtures) baseline.push(await check(fixture));
  const rows: AblationRow[] = [];
  for (const entry of stages) {
    const group = typeof entry === "string" ? [entry] : [...entry];
    const stage = group.join("+");
    const without: boolean[] = [];
    await withStagesOff(group, async () => {
      for (const fixture of fixtures) without.push(await check(fixture));
    });
    const pair = comparePaired(baseline, without);
    const baselinePass = baseline.filter(Boolean).length;
    const withoutPass = without.filter(Boolean).length;
    rows.push({
      stage,
      tasks: fixtures.length,
      baselinePass,
      withoutPass,
      delta: pair.delta,
      p: pair.p,
      interval: wilson(withoutPass, fixtures.length),
      verdict: pair.p < 0.05 ? (pair.delta < 0 ? "helps" : "hurts") : "no measurable effect",
    });
  }
  return rows;
}
