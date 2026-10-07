/**
 * FRIDAY · priority / importance engine
 *
 * One place that decides how much a piece of work matters, so background jobs
 * never elbow in front of what the owner is actually doing.
 *
 * Pure functions over real signals: what the owner wrote, what state the
 * system is in, and how the affect engine is currently reading him.
 */

import { affect } from "./affect";

export type Priority = "critical" | "important" | "useful" | "optional" | "irrelevant";

/** Higher wins. Used to order queues and to gate interruptions. */
export const PRIORITY_WEIGHT: Record<Priority, number> = {
  critical: 100,
  important: 70,
  useful: 45,
  optional: 20,
  irrelevant: 0,
};

export type PriorityInput = {
  text: string;
  /** Set for work FRIDAY started herself rather than work the owner asked for. */
  background?: boolean;
  /** A failing subsystem raises everything that touches it. */
  systemDegraded?: boolean;
  /** Explicit deadline in ms since epoch, when the caller knows one. */
  dueAt?: number | null;
  /** Work another task is waiting on is never optional. */
  blocksOthers?: boolean;
};

export type PriorityVerdict = {
  priority: Priority;
  weight: number;
  /** Whether this is allowed to interrupt what the owner is doing. */
  mayInterrupt: boolean;
  /** Whether this should be held until the foreground is quiet. */
  deferrable: boolean;
  reasons: string[];
};

const CRITICAL =
  /\b(crash\w*|data loss|corrupt\w*|cannot start|won'?t start|broken build|installer fail\w*|security|urgent)\b/i;
const IMPORTANT =
  /\b(fix|error|failed|bug|release|build|deploy|install|deadline|today|production|owner)\b/i;
const OPTIONAL = /\b(maybe|sometime|later|idea|nice to have|explore|curious|when free)\b/i;
const TRIVIAL = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|hmm)\b/i;

/** Classify one unit of work. */
export function classifyPriority(input: PriorityInput): PriorityVerdict {
  const text = (input.text ?? "").trim();
  const reasons: string[] = [];
  const state = affect.getSnapshot();

  let priority: Priority = input.background ? "useful" : "important";
  if (input.background) reasons.push("background work starts below foreground work");

  if (TRIVIAL.test(text) && text.length < 24) {
    priority = "optional";
    reasons.push("short conversational turn");
  }
  if (OPTIONAL.test(text)) {
    priority = "optional";
    reasons.push("phrased as a maybe");
  }
  if (IMPORTANT.test(text)) {
    priority = "important";
    reasons.push("touches a fix, a build or a release");
  }
  if (CRITICAL.test(text) || input.systemDegraded) {
    priority = "critical";
    reasons.push(input.systemDegraded ? "a subsystem is degraded" : "described as a failure");
  }

  if (input.blocksOthers && priority !== "critical") {
    priority = "important";
    reasons.push("other work is blocked on it");
  }

  if (typeof input.dueAt === "number") {
    const hours = (input.dueAt - Date.now()) / 3_600_000;
    if (hours <= 2 && priority !== "critical") {
      priority = "critical";
      reasons.push("due within two hours");
    } else if (hours <= 24 && PRIORITY_WEIGHT[priority] < PRIORITY_WEIGHT.important) {
      priority = "important";
      reasons.push("due today");
    }
  }

  // The owner's own urgency lifts a request one step, never two.
  if (state.user.urgency >= 0.5 && priority === "useful") {
    priority = "important";
    reasons.push("owner is signalling urgency");
  }

  const weight = PRIORITY_WEIGHT[priority];
  return {
    priority,
    weight,
    // Only genuinely critical work is allowed to break into a focused session.
    mayInterrupt:
      priority === "critical" ||
      (priority === "important" && state.attention < 0.6 && !input.background),
    deferrable: weight <= PRIORITY_WEIGHT.useful,
    reasons,
  };
}

/** Order a queue: highest priority first, oldest first inside a tier. */
export function orderByPriority<T extends { priority?: Priority; createdAt?: number }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const delta = PRIORITY_WEIGHT[b.priority ?? "useful"] - PRIORITY_WEIGHT[a.priority ?? "useful"];
    return delta !== 0 ? delta : (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

/** Whether a background job should run at all right now. */
export function shouldRunBackground(verdict: PriorityVerdict): boolean {
  const state = affect.getSnapshot();
  if (verdict.priority === "critical") return true;
  // Hold light work back while the owner is clearly mid-task and engaged.
  if (state.attention >= 0.8 && verdict.deferrable) return false;
  return verdict.priority !== "irrelevant";
}
