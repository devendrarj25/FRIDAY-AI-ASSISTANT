/**
 * FRIDAY · what each model has actually done for her
 *
 * A measured profile per model, built only from real runs: how often its answers passed her own checks
 * on live turns (the Core Brain's per-task-kind stats), how fast it answered, and how many of the rules
 * of a fixed set of asks it kept when the owner pressed Compare. A model with no runs is "not measured"
 * and gets no score, never a guess. The profile only orders models that the billing and privacy
 * firewalls have already allowed; it can never widen what a model may see or cost.
 */

import { readLocalState, writeState } from "../persist";

const KEY = "friday.model-profile.v1";
/** Runs below this carry no weight, so one lucky answer cannot rank a model. */
export const MIN_RUNS = 2;
/** Compare tasks below this carry no weight. */
export const MIN_COMPARE_TASKS = 10;

export type KindStat = { runs: number; ok: number; ms: number };

export type CompareRecord = {
  tasks: number;
  /** Tasks whose unaided answer kept every rule. */
  bare: number;
  /** Tasks whose answer through the check-and-fix loop kept every rule. */
  loop: number;
  calls: number;
  at: number;
};

export type ModelProfile = {
  modelId: string;
  runs: number;
  /** Share of live answers that passed her checks, or null with fewer than MIN_RUNS runs. */
  passRate: number | null;
  /** Average answer time in ms over those runs, or null. */
  avgMs: number | null;
  /** Share of fixed asks whose rules were kept unaided, or null when never compared. */
  rulesKept: number | null;
  /** Share kept through the loop, or null. */
  rulesKeptWithLoop: number | null;
  comparedAt: number | null;
  measured: boolean;
};

type Store = { compare: Record<string, CompareRecord> };

// Kept in memory and written through, so a page that has no storage (or a test) still sees what was recorded.
let cache: Store | null = null;

function load(): Store {
  if (!cache) {
    const saved = readLocalState<Store>(KEY);
    cache = { compare: saved?.compare ?? {} };
  }
  return cache;
}

export function recordCompare(
  modelId: string,
  record: Omit<CompareRecord, "at">,
  at = Date.now(),
): void {
  const store = load();
  store.compare[modelId] = { ...record, at };
  writeState(KEY, { compare: store.compare });
}

export function compareOf(modelId: string): CompareRecord | null {
  return load().compare[modelId] ?? null;
}

export function clearProfilesForTests(): void {
  cache = { compare: {} };
  writeState(KEY, { compare: {} });
}

/** Sum a model's live stats across every kind of task. `stats` is the Core Brain's `kind|modelId` map. */
export function profileOf(modelId: string, stats: Record<string, KindStat>): ModelProfile {
  let runs = 0;
  let ok = 0;
  let ms = 0;
  for (const [key, stat] of Object.entries(stats)) {
    if (!key.endsWith(`|${modelId}`)) continue;
    runs += stat.runs;
    ok += stat.ok;
    ms += stat.ms * stat.runs;
  }
  const compare = compareOf(modelId);
  const compared = compare && compare.tasks >= MIN_COMPARE_TASKS ? compare : null;
  const hasRuns = runs >= MIN_RUNS;
  return {
    modelId,
    runs,
    passRate: hasRuns ? ok / runs : null,
    avgMs: hasRuns && ms > 0 ? Math.round(ms / runs) : null,
    rulesKept: compared ? compared.bare / compared.tasks : null,
    rulesKeptWithLoop: compared ? compared.loop / compared.tasks : null,
    comparedAt: compared ? compared.at : null,
    measured: hasRuns || Boolean(compared),
  };
}

/**
 * Order score for one model. Measured pass rate leads; a Compare result adds a little for keeping the
 * rules of an ask; a slow model loses a little. An unmeasured model scores 0, the same as before this
 * profile existed, so nothing is promoted or demoted on a guess.
 */
export function rankScore(profile: ModelProfile): number {
  if (!profile.measured) return 0;
  const live = profile.passRate ?? 0;
  const rules = profile.rulesKept === null ? 0 : 0.1 * profile.rulesKept;
  const slow = profile.avgMs === null ? 0 : Math.min(0.05, profile.avgMs / 120_000);
  return live + rules - slow;
}
