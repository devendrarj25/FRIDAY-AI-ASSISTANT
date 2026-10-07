/**
 * FRIDAY · gated per-stage turn timing
 *
 * Console/log only. Off unless `FRIDAY_DEBUG_TURN_TIMING=1` or
 * `localStorage.friday.debug.turnTiming === "1"`. Never invents durations:
 * a stage that did not start has no mark.
 */

export function turnTimingEnabled(): boolean {
  try {
    if (typeof process !== "undefined" && process.env?.["FRIDAY_DEBUG_TURN_TIMING"] === "1") {
      return true;
    }
  } catch {
    /* Node process.env may be unavailable in some renderer bundles */
  }
  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("friday.debug.turnTiming") === "1"
    ) {
      return true;
    }
  } catch {
    /* private mode / tests */
  }
  return false;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

const marks = new Map<string, number>();

/** Real stage outcomes (successes, failures, and timeouts). Never guessed. */
export type StageOutcome = {
  runId: string;
  stage: string;
  ms: number;
  extra?: string;
  at: number;
  failed: boolean;
  timedOut: boolean;
};

const OUTCOMES: StageOutcome[] = [];
const MAX_OUTCOMES = 80;
const FAIL_EXTRA = /\b(fail|failed|error|threw|unavailable|timeout|timed out)\b/i;

function trimOutcomes(): void {
  if (OUTCOMES.length <= MAX_OUTCOMES) return;
  for (let i = OUTCOMES.length - 1; i >= 0 && OUTCOMES.length > MAX_OUTCOMES; i -= 1) {
    const row = OUTCOMES[i];
    if (row && !row.failed && !row.timedOut) OUTCOMES.splice(i, 1);
  }
  if (OUTCOMES.length > MAX_OUTCOMES) OUTCOMES.length = MAX_OUTCOMES;
}

export function recordStageOutcome(
  entry: Omit<StageOutcome, "at"> & { at?: number },
): StageOutcome {
  const row: StageOutcome = {
    runId: entry.runId,
    stage: entry.stage,
    ms: entry.ms,
    failed: entry.failed,
    timedOut: entry.timedOut,
    at: entry.at ?? Date.now(),
    ...(entry.extra ? { extra: entry.extra } : {}),
  };
  OUTCOMES.unshift(row);
  trimOutcomes();
  return row;
}

export function recentStageOutcomes(limit = 20): StageOutcome[] {
  return OUTCOMES.slice(0, Math.max(1, limit));
}

export function recentFailedStages(limit = 12): StageOutcome[] {
  return OUTCOMES.filter((row) => row.failed || row.timedOut).slice(0, Math.max(1, limit));
}

export function resetStageOutcomes(): void {
  OUTCOMES.length = 0;
}

function key(runId: string, stage: string): string {
  return `${runId}:${stage}`;
}

/** Start a named stage clock. */
export function turnMark(runId: string, stage: string): void {
  marks.set(key(runId, stage), nowMs());
  if (turnTimingEnabled()) {
    console.info(`[friday.turn] ${runId} ${stage} start`);
  }
}

/** Stop a named stage clock and return elapsed milliseconds (0 if never started). */
export function turnDone(runId: string, stage: string, extra?: string): number {
  const started = marks.get(key(runId, stage));
  marks.delete(key(runId, stage));
  const ms = started != null ? Math.max(0, Math.round(nowMs() - started)) : 0;
  if (turnTimingEnabled()) {
    console.info(`[friday.turn] ${runId} ${stage} ${ms}ms${extra ? ` ${extra}` : ""}`);
  }
  const timedOut = Boolean(extra && /timeout|timed out/i.test(extra));
  const failed = Boolean(extra && FAIL_EXTRA.test(extra));
  recordStageOutcome({
    runId,
    stage,
    ms,
    ...(extra ? { extra } : {}),
    failed: Boolean(failed || timedOut),
    timedOut,
  });
  return ms;
}

/**
 * Bound a promise. On timeout, resolve `fallback` instead of hanging.
 * The original work may still finish in the background; the caller moves on.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  meta?: { runId: string; stage: string },
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (meta) {
        recordStageOutcome({
          runId: meta.runId,
          stage: meta.stage,
          ms,
          extra: `timed out after ${ms}ms`,
          failed: true,
          timedOut: true,
        });
      }
      resolve(fallback);
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
