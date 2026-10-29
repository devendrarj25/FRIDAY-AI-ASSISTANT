/**
 * FRIDAY · long-horizon goals
 *
 * Goal → subgoal tracking that survives conversations by using the existing
 * task-graph persist layer (`friday.task-graph.v1`). Not a second database.
 */

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

export function adoptHorizonGoal(request: string): { id: string; graph: TaskGraph | undefined } {
  const goal = String(request || "").trim();
  const deadline = extractDeadline(goal);
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
