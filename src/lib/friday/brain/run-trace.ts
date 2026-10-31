/**
 * FRIDAY · one turn, as a redacted local record
 *
 * Built from the stage clocks that already exist (`turn-timing.ts`). It carries stage names, millisecond
 * timings and a failed flag, never prompt text, answers, paths, keys or stage detail, so it is safe to keep
 * on this PC and to attach to a benchmark result. Nothing leaves the machine and there is no exporter.
 */

import { recentStageOutcomes } from "./turn-timing";

export const RUN_TRACE_VERSION = 1;

export type RunTrace = {
  version: number;
  runId: string;
  stages: { stage: string; ms: number; failed: boolean }[];
  totalMs: number;
  failedStages: number;
};

/** A run id the kernel will accept in a log line: letters, digits, dot, dash and underscore only. */
export function safeRunId(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw : "";
  return /^[\w.-]{1,64}$/.test(text) ? text : null;
}

export function buildRunTrace(runId: string, limit = 200): RunTrace {
  const rows = recentStageOutcomes(Math.max(1, limit))
    .filter((row) => row.runId === runId)
    .reverse();
  const stages = rows.map((row) => ({
    stage: row.stage.replace(/[^\w:.-]/g, "_").slice(0, 80),
    ms: row.ms,
    failed: row.failed || row.timedOut,
  }));
  return {
    version: RUN_TRACE_VERSION,
    runId,
    stages,
    totalMs: stages.reduce((sum, row) => sum + row.ms, 0),
    failedStages: stages.filter((row) => row.failed).length,
  };
}
