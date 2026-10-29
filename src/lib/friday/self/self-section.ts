/**
 * Self-Management page helpers.
 *
 * Diagnose uses the existing Doctor scan + inspectSelfComplete path (not a
 * second inspector). Approval listings put waiting items first so a busy
 * history cannot bury an Allow/Reject decision.
 */

import { inspectSelfComplete, describeSelfReport, inspectSelf } from "../brain/self-diagnosis";
import { doctor } from "../doctor-engine";
import { systemMap } from "../system-map";
import { self } from "./self-manager";

export type ApprovalStageItem = { stage: string };

/** Waiting-approval rows first, then the rest in original order. */
export function approvalFirst<T extends ApprovalStageItem>(items: T[]): T[] {
  const waiting = items.filter((item) => item.stage === "waiting-approval");
  const rest = items.filter((item) => item.stage !== "waiting-approval");
  return [...waiting, ...rest];
}

/** Live doctor + source-health fold, then the cheap self pulse and map. */
export async function diagnoseNow(): Promise<{ spoken: string; problems: number }> {
  await doctor.scan({ deep: false });
  const report = await inspectSelfComplete();
  self.pulse();
  systemMap.refresh();
  return { spoken: describeSelfReport(report), problems: report.problems.length };
}

/** Snapshot of the last folded stores — no extra scan. */
export function currentDiagnosis(): string {
  return describeSelfReport(inspectSelf());
}
