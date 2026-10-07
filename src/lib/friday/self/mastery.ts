/**
 * FRIDAY · derived capability metrics (mastery / activity)
 *
 * Skills "mastery" and agents "activity" have no objectively correct
 * definition, so they are *derived* from the real task ledger instead of being
 * invented. Formula — keep this comment and AUDIT.md in sync when tuning:
 *
 *   executions   = ledger tasks whose kind/key belongs to the capability
 *   successes    = executions with status "done"
 *   successRate  = successes / executions            (0 when never executed)
 *   volume       = min(1, ln(1 + executions) / ln(1 + SATURATION))
 *                  → experience saturates at SATURATION (20) runs
 *   mastery      = round(100 * (0.7 * successRate + 0.3 * volume))
 *
 *   level        = mastery >= 80 Expert
 *                | mastery >= 55 Advanced
 *                | mastery >= 25 Intermediate
 *                | executions > 0 Basic
 *                | otherwise      Untrained      (never executed — honest 0)
 *
 *   activity     = running >= 2 High | running == 1 Medium | otherwise Low
 *                  (running = tasks currently in "running" state)
 *
 * Nothing here estimates, smooths or back-fills: a capability that has never
 * run reports 0 / "Untrained", which is the truth.
 */
import type { TaskRecord } from "./task-ledger";

export const SATURATION = 20;
export const SUCCESS_WEIGHT = 0.7;
export const VOLUME_WEIGHT = 0.3;

export type MasteryLevel = "Expert" | "Advanced" | "Intermediate" | "Basic" | "Untrained";

export interface CapabilityStats {
  executions: number;
  successes: number;
  failures: number;
  running: number;
  successRate: number;
  mastery: number;
  level: MasteryLevel;
  activity: "High" | "Medium" | "Low";
  lastUsedAt: number | null;
}

/** Tasks belonging to one capability id/name. */
export function tasksFor(tasks: TaskRecord[], id: string, name?: string): TaskRecord[] {
  const needle = id.toLowerCase();
  const alt = (name ?? "").toLowerCase();
  return tasks.filter((task) => {
    const kind = task.kind.toLowerCase();
    const key = task.key.toLowerCase();
    return (
      kind === needle ||
      key === needle ||
      key.startsWith(`${needle}:`) ||
      key.startsWith(needle) ||
      (alt.length > 2 && (kind === alt || key.startsWith(alt)))
    );
  });
}

export function statsFor(tasks: TaskRecord[], id: string, name?: string): CapabilityStats {
  const mine = tasksFor(tasks, id, name);
  const executions = mine.filter((t) => t.status !== "queued").length;
  const successes = mine.filter((t) => t.status === "done").length;
  const failures = mine.filter((t) => t.status === "failed" || t.status === "timeout").length;
  const running = mine.filter((t) => t.status === "running").length;
  const successRate = executions ? successes / executions : 0;
  const volume = executions ? Math.min(1, Math.log1p(executions) / Math.log1p(SATURATION)) : 0;
  const mastery = Math.round(100 * (SUCCESS_WEIGHT * successRate + VOLUME_WEIGHT * volume));
  const level: MasteryLevel =
    mastery >= 80
      ? "Expert"
      : mastery >= 55
        ? "Advanced"
        : mastery >= 25
          ? "Intermediate"
          : executions > 0
            ? "Basic"
            : "Untrained";
  const lastUsedAt = mine.reduce<number | null>(
    (latest, task) => Math.max(latest ?? 0, task.endedAt ?? task.startedAt) || null,
    null,
  );
  return {
    executions,
    successes,
    failures,
    running,
    successRate,
    mastery,
    level,
    activity: running >= 2 ? "High" : running === 1 ? "Medium" : "Low",
    lastUsedAt,
  };
}

/** Human "last used" label; "never" when the capability has not run yet. */
export function lastUsedLabel(at: number | null): string {
  if (!at) return "never";
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return "Today";
  if (diff < 172_800_000) return "Yesterday";
  return new Date(at).toLocaleDateString();
}
