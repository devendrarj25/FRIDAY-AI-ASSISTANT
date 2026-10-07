/**
 * FRIDAY · read-only Tasks observation
 *
 * Core Brain only reads the live Tasks session the owner (or FRIDAY) already
 * produced. It never opens a second queue. The stores stay
 * `self/task-graph.ts` and `self/task-ledger.ts`.
 */

import { formatTasksExtra, tasksSnapshot, type TasksSession } from "../tasks-awareness";

const LOOK =
  /\b(look at (the |my )?tasks?|what(?:'s| is) (in|on) (the |my )?tasks?|tasks? (page|queue|graph|list|buffer)|that task|explain (that|this|the) (task|queue|graph)|show (me )?(the )?(tasks?|queue)|what(?:'s| is) (running|queued) (on|in) (the )?(tasks?|queue|graph)|task status|queue status|how much (is |has )?(been )?(complete|done|finished)|what failed (on|in) (the )?(task|queue)|resume (all |the )?tasks?|interrupt( the task)?|pause (all |the )?tasks?|cancel (the )?task|retry (the )?task|run (the )?task again|ab next(?: kya)?|next kya(?: karna)?|kya pending|step complete(?: ho gaya)?|ye kar diya|baad mein continue|continue karo|wahi (project|task|kaam)|project wala|task wala|isko (pause|test|fix|complete)|resume karo)\b/i;

export function tasksLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

/** Chat / Auto Mode should attach the live queue for looks and queue commands. */
export function shouldAttachTasksExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return tasksLookRequested(text);
}

export type TasksObservation = {
  readOnly: true;
  spawned: false;
  runningId: string | null;
  summary: string;
  extra: string;
};

export function observationFromTasks(snap: TasksSession): TasksObservation {
  const live = snap.graphs.filter(
    (graph) => graph.state === "queued" || graph.state === "running" || graph.state === "paused",
  );
  let summary: string;
  if (!snap.graphs.length && !snap.tasks.length) {
    summary = "tasks idle — nothing in the live graph or ledger yet";
  } else if (snap.runningId) {
    const running = snap.graphs.find((graph) => graph.id === snap.runningId);
    summary = `tasks running ${running?.request.slice(0, 80) || snap.runningId} · ${snap.queue.length} queued`;
  } else if (live.length) {
    summary = `tasks ${live.length} open · ${snap.queue.length} queued`;
  } else {
    summary = `tasks ${snap.graphs.length} graphs, ${snap.tasks.length} ledger rows`;
  }
  return {
    readOnly: true,
    spawned: false,
    runningId: snap.runningId,
    summary,
    extra: formatTasksExtra(),
  };
}

export function observeTasksState(): TasksObservation {
  return observationFromTasks(tasksSnapshot());
}
