/**
 * FRIDAY · one id scheme for a durable run.
 *
 * A task, a run, a step, an action and an evidence receipt share this module.
 * The task graph and the desktop loop both use it. There is no second ledger.
 */

import { nextRetryDelayMs } from "../bounded-retry";

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
};

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
export function budgetBlock(budget: TaskBudget, used: BudgetUse): string | null {
  if (used.steps >= budget.maxSteps) return "step budget reached";
  if (used.ms > budget.timeMs) return "time budget reached";
  if (used.spend > budget.spend) return "spend budget reached";
  if (used.tokens > budget.tokens) return "token budget reached";
  return null;
}
