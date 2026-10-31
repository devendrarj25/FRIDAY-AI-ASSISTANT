/**
 * FRIDAY · long-horizon goals
 *
 * Goal → subgoal tracking that survives conversations by using the existing
 * task-graph persist layer (`friday.task-graph.v1`). Not a second database.
 */

import { personalDesk } from "../personal-desk";
import { planNodes, taskGraph, type TaskGraph } from "./task-graph";

const HORIZON =
  /\b(by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|tomorrow)|deadline|finish the|over the (week|weekend|month)|multi[- ]session)\b/i;
const DEADLINE =
  /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|tomorrow|\d{1,2}\s+\w+)\b/i;

export function looksLikeHorizonGoal(text: string): boolean {
  return HORIZON.test(String(text || ""));
}

export function extractDeadline(text: string): string | undefined {
  const match = DEADLINE.exec(String(text || ""));
  return match ? String(match[0]).trim() : undefined;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** The hour a "by <day>" deadline is taken to fall on: the end of the working day, local time. */
const DEADLINE_HOUR = 18;

/**
 * A deadline phrase ("by monday", "by eod", "by tomorrow", "by 12 may") as a local time, or null when it
 * cannot be read. A weekday means its next occurrence (today counts only while it is still before the end
 * of the working day); a day and month means the next such date. Nothing is guessed for other phrases.
 */
export function deadlineToDueAt(phrase: string, now = Date.now()): number | null {
  const text = String(phrase || "").toLowerCase();
  const at = (date: Date) => {
    date.setHours(DEADLINE_HOUR, 0, 0, 0);
    return date.getTime();
  };
  const today = new Date(now);
  if (/\beod\b/.test(text)) {
    const due = at(new Date(now));
    return due > now ? due : null;
  }
  if (/\btomorrow\b/.test(text)) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    return at(next);
  }
  const day = DAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(text));
  if (day >= 0) {
    const next = new Date(now);
    let ahead = (day - today.getDay() + 7) % 7;
    if (ahead === 0 && at(new Date(now)) <= now) ahead = 7;
    next.setDate(next.getDate() + ahead);
    return at(next);
  }
  const dm = /\b(\d{1,2})\s+([a-z]{3})[a-z]*\b/.exec(text);
  const month = dm ? MONTHS.indexOf(dm[2]!) : -1;
  if (dm && month >= 0) {
    const dayOfMonth = Number(dm[1]);
    if (dayOfMonth < 1 || dayOfMonth > 31) return null;
    const candidate = new Date(today.getFullYear(), month, dayOfMonth);
    if (candidate.getMonth() !== month) return null;
    if (at(candidate) <= now) candidate.setFullYear(candidate.getFullYear() + 1);
    return at(candidate);
  }
  return null;
}

/**
 * A deadline found in a goal becomes a task on the personal desk, so the existing heads-up and reminder
 * fire for it. One task per goal: running this again for the same goal adds nothing.
 */
export function trackGoalDeadline(
  goal: string,
  now = Date.now(),
): { tracked: boolean; dueAt: number | null } {
  const phrase = extractDeadline(goal);
  const dueAt = phrase ? deadlineToDueAt(phrase, now) : null;
  if (!dueAt) return { tracked: false, dueAt };
  const title = `Deadline: ${goal.trim().slice(0, 80)}`;
  if (personalDesk.list().some((task) => task.title === title)) return { tracked: false, dueAt };
  personalDesk.add(title, dueAt);
  return { tracked: true, dueAt };
}

export function adoptHorizonGoal(request: string): { id: string; graph: TaskGraph | undefined } {
  const goal = String(request || "").trim();
  const deadline = extractDeadline(goal);
  trackGoalDeadline(goal);
  const { id } = taskGraph.submit(goal, {
    horizon: {
      goal,
      outcome: goal,
      ...(deadline ? { deadline } : {}),
    },
    nodes: planNodes(goal),
  });
  return { id, graph: taskGraph.get(id) };
}

export function noteHorizonBlocker(graphId: string, blocker: string): TaskGraph | null {
  return taskGraph.replanBlocked(graphId, blocker);
}
