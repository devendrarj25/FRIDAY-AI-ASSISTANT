/**
 * FRIDAY · one id scheme for a durable run.
 *
 * A task, a run, a step, an action and an evidence receipt share this module.
 * The task graph and the desktop loop both use it. There is no second ledger.
 */

import { nextRetryDelayMs } from "../bounded-retry";
import type { ApprovalLevel } from "./autonomy";

export type RunIdentity = {
  taskId: string;
  runId: string;
  stepId: string;
  actionId: string;
  evidenceId: string;
};

export type TaskBudget = {
  timeMs: number;
  maxSteps: number;
  /** Currency units. Zero means this run must not spend. */
  spend: number;
  tokens: number;
};

export type BudgetUse = {
  ms: number;
  steps: number;
  spend: number;
  tokens: number;
};

export type PerceptionStamp = {
  source: "uia" | "ocr" | "vision" | "none";
  confidence: number;
  /** Age of that perception when the step was recorded, in milliseconds. */
  ageMs: number;
  handoff?: "credential" | "payment" | "captcha" | "uac";
};

export type EvidenceReceipt = {
  evidenceId: string;
  taskId: string;
  runId: string;
  stepId: string;
  actionId: string;
  done: string;
  postcondition: string;
  checked: boolean;
  result: string;
  at: number;
  /** Local words only. A screenshot is never stored. */
  undoHint?: string;
  perception?: PerceptionStamp;
};

export type TimelineRow = {
  stepId: string;
  action: string;
  source: PerceptionStamp["source"];
  confidence: number | null;
  ageMs: number | null;
  postcondition: string;
  checked: boolean;
  result: string;
  undoHint: string;
  handoff: string;
};

/** Drops secrets and images. The timeline keeps a short local note. */
export function redactRunText(value: string): string {
  const secret = /(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi;
  const dataUrl = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
  const text = String(value || "")
    .replace(dataUrl, "[image omitted]")
    .replace(secret, "[redacted]");
  let clean = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    clean += char;
  }
  return clean.slice(0, 240);
}

/** One row per receipt. No pixels, no second store. */
export function timelineFromEvidence(rows: EvidenceReceipt[]): TimelineRow[] {
  return rows.map((row) => ({
    stepId: row.stepId,
    action: redactRunText(row.done),
    source: row.perception?.source ?? "none",
    confidence: row.perception ? row.perception.confidence : null,
    ageMs: row.perception ? Math.max(0, row.perception.ageMs) : null,
    postcondition: redactRunText(row.postcondition),
    checked: row.checked,
    result: redactRunText(row.result),
    undoHint: redactRunText(row.undoHint ?? ""),
    handoff: row.perception?.handoff ?? "",
  }));
}

let seq = 0;

/** Stable within one process. Tests do not read the clock from these ids. */
export function mintIdentity(taskId: string, stepOrdinal: number): RunIdentity {
  seq += 1;
  const stamp = seq.toString(36);
  return {
    taskId,
    runId: `${taskId}-run`,
    stepId: `${taskId}-step-${stepOrdinal}`,
    actionId: `${taskId}-action-${stamp}`,
    evidenceId: `${taskId}-evidence-${stamp}`,
  };
}

export function idempotencyKey(kind: string, target: string, payload: string): string {
  return `${kind}|${target}|${payload}`;
}

/** Same three-slot backoff as the kernel restart helper. Null means stop. */
export function retryBackoffMs(attemptIndex: number): number | null {
  return nextRetryDelayMs(attemptIndex);
}

/**
 * Why this run must stop, or null when another step is still allowed.
 * Time, steps, spend and tokens are all hard caps.
 */
/** Ask and Balanced wait. Full continues only when the owner chose Full. */
export function resumeOffer(level: ApprovalLevel): "ask" | "resume" {
  return level === "full" ? "resume" : "ask";
}

/**
 * A verified step is not replayed. A changed world, or a step that never
 * checked its postcondition, runs again so the check happens on fresh state.
 */
export function shouldReplay(checkpoint?: { checked?: boolean; worldChanged?: boolean }): boolean {
  if (!checkpoint) return true;
  if (checkpoint.worldChanged) return true;
  return checkpoint.checked !== true;
}

export function budgetBlock(budget: TaskBudget, used: BudgetUse): string | null {
  if (used.steps >= budget.maxSteps) return "step budget reached";
  if (used.ms > budget.timeMs) return "time budget reached";
  if (used.spend > budget.spend) return "spend budget reached";
  if (used.tokens > budget.tokens) return "token budget reached";
  return null;
}
