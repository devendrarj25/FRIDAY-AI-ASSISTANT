/**
 * FRIDAY · recurring failures across tasks
 *
 * One failure is an event; the same failure again is a pattern. This groups the ledger's failed tasks by the
 * error fingerprint that `error-intelligence` already computes (stable across paths and numbers), so a fault
 * that keeps coming back is seen once with its count, the tools and models involved, and a suggested kind of
 * fix. It only reads. Filing a pattern goes through the existing limitation loop, which is discovery only and
 * never applies anything.
 */

import { normalizeError } from "../brain/error-intelligence";
import { proposeFabricLimitation, type LimitationProposal } from "./limitation-loop";
import type { TaskRecord } from "./task-ledger";

export type FailurePattern = {
  fingerprint: string;
  kind: string;
  sample: string;
  count: number;
  taskIds: string[];
  tools: string[];
  models: string[];
  firstAt: number;
  lastAt: number;
  /** What kind of change would address it. A suggestion for the owner's review, never an action. */
  suggestion: "rule" | "skill" | "routing" | "investigate";
};

const FAILED = new Set(["failed", "timeout"]);

/**
 * The structured fingerprint when the error text has a recognisable shape. Plain prose gives the structured
 * reader nothing to hold on to (every such message would share one fingerprint), so it falls back to the
 * words themselves with numbers, paths and quoted names removed.
 */
function fingerprintOf(text: string): string {
  const parsed = normalizeError(text);
  if (parsed.errorType || parsed.message || parsed.codes.length || parsed.frames.length) {
    return parsed.fingerprint;
  }
  const words = text
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s'"]+/g, " ")
    .replace(/['"`][^'"`]*['"`]/g, " ")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .join(" ");
  let hash = 0x811c9dc5;
  for (const ch of words) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return words ? `txt-${hash.toString(16).padStart(8, "0")}` : "";
}

function suggest(
  pattern: Pick<FailurePattern, "tools" | "models" | "sample">,
): FailurePattern["suggestion"] {
  if (
    /rate.?limit|quota|429|insufficient|billing|context length|too many tokens/i.test(
      pattern.sample,
    )
  ) {
    return "routing";
  }
  if (pattern.tools.length) return "skill";
  if (pattern.models.length && /refus|cannot|can't|unable|not supported/i.test(pattern.sample)) {
    return "routing";
  }
  return pattern.sample ? "rule" : "investigate";
}

/**
 * Patterns that happened at least `minCount` times, most frequent first. A task with no error text is not
 * grouped: an unexplained failure is not evidence that two failures are the same.
 */
export function mineFailurePatterns(tasks: readonly TaskRecord[], minCount = 2): FailurePattern[] {
  const groups = new Map<string, FailurePattern>();
  for (const task of tasks) {
    const failed = FAILED.has(task.status) || task.success === false;
    const text = String(task.error ?? "").trim();
    if (!failed || !text) continue;
    const fingerprint = fingerprintOf(text);
    if (!fingerprint) continue;
    const key = `${task.kind}|${fingerprint}`;
    const at = task.endedAt ?? task.startedAt;
    const found = groups.get(key);
    if (found) {
      found.count += 1;
      found.taskIds.push(task.id);
      found.firstAt = Math.min(found.firstAt, at);
      found.lastAt = Math.max(found.lastAt, at);
      for (const tool of task.tools ?? []) if (!found.tools.includes(tool)) found.tools.push(tool);
      for (const model of task.models ?? [])
        if (!found.models.includes(model)) found.models.push(model);
    } else {
      groups.set(key, {
        fingerprint,
        kind: task.kind,
        sample: text.slice(0, 160),
        count: 1,
        taskIds: [task.id],
        tools: [...(task.tools ?? [])],
        models: [...(task.models ?? [])],
        firstAt: at,
        lastAt: at,
        suggestion: "investigate",
      });
    }
  }
  return [...groups.values()]
    .filter((pattern) => pattern.count >= Math.max(2, minCount))
    .map((pattern) => ({ ...pattern, suggestion: suggest(pattern) }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

/** File each pattern once as a limitation for the owner's review. Re-filing the same pattern is a no-op. */
export function fileFailurePatterns(patterns: readonly FailurePattern[]): LimitationProposal[] {
  return patterns.map((pattern) =>
    proposeFabricLimitation({
      id: `failure-${pattern.kind}-${pattern.fingerprint}`,
      title: `Recurring ${pattern.kind} failure (${pattern.count} times)`,
      rationale: `The same fault fingerprint ${pattern.fingerprint} ended ${pattern.count} ${pattern.kind} tasks. Suggested kind of fix: ${pattern.suggestion}.`,
      evidence: [pattern.sample, ...pattern.taskIds.slice(0, 5).map((id) => `task ${id}`)],
      risk: "review",
    }),
  );
}
