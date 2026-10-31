/**
 * FRIDAY · what a benchmark result is allowed to claim
 *
 * Statistics and the result record for the Brain suites. A rate without its sample count and interval is
 * not reported, a domain with too few runs is "insufficient" rather than scored, and a security gate is a
 * count that must be zero, never part of an average. Nothing here calls a model.
 */

/** Wilson score interval for a pass rate (95%). With no runs there is no interval. */
export function wilson(passed: number, total: number, z = 1.96): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 1 };
  const p = passed / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export type RunMetrics = {
  tasks: number;
  runs: number;
  /** Mean pass rate over every run (pass@1). */
  passAt1: number;
  /** Share of tasks that passed on at least one run (pass@k). */
  passAtK: number;
  /** Share of tasks that passed on every run (pass^k): reliable, not lucky. */
  passPowK: number;
};

/** `results[task][run]` is whether that run passed. Tasks with a different run count use the shortest. */
export function runMetrics(results: boolean[][]): RunMetrics {
  const tasks = results.length;
  if (!tasks) return { tasks: 0, runs: 0, passAt1: 0, passAtK: 0, passPowK: 0 };
  const runs = Math.min(...results.map((row) => row.length));
  if (runs <= 0) return { tasks, runs: 0, passAt1: 0, passAtK: 0, passPowK: 0 };
  let wins = 0;
  let any = 0;
  let all = 0;
  for (const row of results) {
    const used = row.slice(0, runs);
    const passes = used.filter(Boolean).length;
    wins += passes;
    if (passes > 0) any += 1;
    if (passes === runs) all += 1;
  }
  return {
    tasks,
    runs,
    passAt1: wins / (tasks * runs),
    passAtK: any / tasks,
    passPowK: all / tasks,
  };
}

/**
 * Exact two-sided McNemar test for paired pass/fail results of two configurations on the same tasks.
 * `onlyA` = tasks only A passed, `onlyB` = tasks only B passed. Returns the p-value (1 when nothing differs).
 */
export function mcnemarExact(onlyA: number, onlyB: number): number {
  const n = onlyA + onlyB;
  if (n === 0) return 1;
  const k = Math.min(onlyA, onlyB);
  // P(X <= k) for X ~ Binomial(n, 0.5), computed in log space to stay stable for large n.
  let logChoose = 0;
  let sum = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logChoose - n * Math.LN2);
  }
  return Math.min(1, 2 * sum);
}

/** Paired comparison of two configurations. Positive `delta` favours B. */
export function comparePaired(a: boolean[], b: boolean[]) {
  const n = Math.min(a.length, b.length);
  let onlyA = 0;
  let onlyB = 0;
  let passA = 0;
  let passB = 0;
  for (let i = 0; i < n; i += 1) {
    if (a[i]) passA += 1;
    if (b[i]) passB += 1;
    if (a[i] && !b[i]) onlyA += 1;
    if (!a[i] && b[i]) onlyB += 1;
  }
  return {
    tasks: n,
    delta: n ? (passB - passA) / n : 0,
    onlyA,
    onlyB,
    p: mcnemarExact(onlyA, onlyB),
  };
}

/** Small stable hash (FNV-1a) of a fixture list, so a result names exactly the tasks it used. */
export function fixtureHash(ids: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of [...ids].sort().join("\n")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const BENCHMARK_VERSION = "1.0";

/** Domain weights of FRIDAY Brain Benchmark 1.0. They must add up to 100. */
export const DOMAIN_WEIGHTS: Readonly<Record<string, number>> = {
  cognitive: 12,
  deepThinking: 8,
  memory: 10,
  learning: 8,
  multiModel: 8,
  agents: 12,
  coding: 10,
  research: 8,
  computerUse: 7,
  multimodal: 5,
  selfDevelopment: 5,
  reliability: 7,
};

/** Fewer task-runs than this and a domain is "insufficient", not a score. */
export const MIN_DOMAIN_RUNS = 50;

export type ResultRecord = {
  benchmark: string;
  version: string;
  fixtureHash: string;
  /** A, B, C or D: current, optimised, plus open source, best providers. */
  configuration: "A" | "B" | "C" | "D";
  commit: string;
  models: string[];
  hardware: string;
  seed: number;
  k: number;
  limitations: string[];
};

export type DomainResult = { domain: string; passed: number; runs: number };

export type BrainScore = {
  /** 0 to 100 across the domains that had enough runs, or null when none did. */
  score: number | null;
  low: number | null;
  high: number | null;
  scored: string[];
  insufficient: string[];
  /** Weight that went unscored. It is not redistributed. */
  unscoredWeight: number;
};

/** Weighted score across domains with their combined interval. Weights of unscored domains stay unscored. */
export function brainScore(results: readonly DomainResult[]): BrainScore {
  const scored: string[] = [];
  const insufficient: string[] = [];
  let weight = 0;
  let value = 0;
  let low = 0;
  let high = 0;
  for (const result of results) {
    const w = DOMAIN_WEIGHTS[result.domain];
    if (w === undefined) continue;
    if (result.runs < MIN_DOMAIN_RUNS) {
      insufficient.push(result.domain);
      continue;
    }
    const ci = wilson(result.passed, result.runs);
    weight += w;
    value += (w * result.passed) / result.runs;
    low += w * ci.low;
    high += w * ci.high;
    scored.push(result.domain);
  }
  const total = Object.values(DOMAIN_WEIGHTS).reduce((a, b) => a + b, 0);
  if (!weight) {
    return { score: null, low: null, high: null, scored, insufficient, unscoredWeight: total };
  }
  // Scaled to the weight that was scored, so a partial run is not shown as a small number.
  return {
    score: (100 * value) / weight,
    low: (100 * low) / weight,
    high: (100 * high) / weight,
    scored,
    insufficient,
    unscoredWeight: total - weight,
  };
}

export type PromotionVerdict = { promote: boolean; reason: string };

/**
 * May a learned change (a skill, a routing preference, a prompt) replace what it came from? Only when the
 * held-out tasks did not get worse, nothing on the regression set got significantly worse, and no security
 * gate failed. A gate failure rejects the change whatever the numbers say. The verdict is advice to the
 * owner's review; nothing is applied here.
 */
export function promotionVerdict(input: {
  heldBefore: boolean[];
  heldAfter: boolean[];
  regressionBefore: boolean[];
  regressionAfter: boolean[];
  gateFailures: string[];
}): PromotionVerdict {
  if (input.gateFailures.length) {
    return { promote: false, reason: `security gate failed: ${input.gateFailures.join(", ")}` };
  }
  if (input.heldBefore.length < 5)
    return { promote: false, reason: "too few held-out tasks to judge" };
  const held = comparePaired(input.heldBefore, input.heldAfter);
  if (held.delta < 0) return { promote: false, reason: "held-out tasks got worse" };
  const regression = comparePaired(input.regressionBefore, input.regressionAfter);
  if (regression.delta < 0 && regression.p < 0.05) {
    return { promote: false, reason: "regression set got significantly worse" };
  }
  if (held.delta === 0) return { promote: false, reason: "no measured gain on held-out tasks" };
  return { promote: true, reason: `held-out +${Math.round(held.delta * 100)}%, no regression` };
}
