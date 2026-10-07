/**
 * FRIDAY · live Tasks session (renderer)
 *
 * One shared snapshot of the Tasks page so Core Brain, Auto Mode, and Chat see
 * the same graph + ledger the owner is looking at. The stores stay
 * `self/task-graph.ts` and `self/task-ledger.ts` — this module never opens a
 * second queue.
 */

import { graphProgress, taskGraph, type GraphState, type TaskGraph } from "./self/task-graph";
import { ledger, type PendingApproval, type TaskRecord } from "./self/task-ledger";

export type TasksFilter =
  "all" | "live" | "queued" | "paused" | "failed" | "done" | "idle" | "waiting";

export type TasksSession = {
  desktop: boolean;
  follow: boolean;
  filter: TasksFilter;
  query: string;
  runningId: string | null;
  idlePaused: boolean;
  graphs: TaskGraph[];
  queue: { id: string; request: string; position: number }[];
  tasks: TaskRecord[];
  approvals: PendingApproval[];
};

const empty = (): TasksSession => ({
  desktop: false,
  follow: true,
  filter: "all",
  query: "",
  runningId: null,
  idlePaused: false,
  graphs: [],
  queue: [],
  tasks: [],
  approvals: [],
});

let session: TasksSession = empty();
let asker: ((prompt: string) => void) | null = null;

export function tasksSnapshot(): TasksSession {
  return readLiveTasks();
}

/**
 * Page overlay (filter / follow) plus the live engines, so Chat / Auto Mode
 * still see the real graph when the Tasks page is not open. Session-only
 * graphs stay visible for tests that do not touch the singleton engine.
 */
export function readLiveTasks(): TasksSession {
  const graph = taskGraph.getSnapshot();
  const book = ledger.getSnapshot();
  return {
    ...session,
    runningId: graph.runningId ?? session.runningId,
    idlePaused: graph.idlePaused || session.idlePaused,
    graphs: mergeById(session.graphs, graph.graphs),
    queue: graph.queue.length ? graph.queue : session.queue,
    tasks: mergeById(session.tasks, book.tasks),
    approvals: mergeApprovals(session.approvals, book.approvals),
  };
}

function mergeById<T extends { id: string }>(sessionRows: T[], storeRows: T[]): T[] {
  const map = new Map<string, T>();
  for (const row of sessionRows) map.set(row.id, row);
  for (const row of storeRows) map.set(row.id, row);
  return [...map.values()];
}

function mergeApprovals(
  sessionRows: PendingApproval[],
  storeRows: PendingApproval[],
): PendingApproval[] {
  const map = new Map<string, PendingApproval>();
  for (const row of sessionRows) map.set(row.taskId, row);
  for (const row of storeRows) map.set(row.taskId, row);
  return [...map.values()];
}

export function publishTasksSession(patch: Partial<TasksSession>): TasksSession {
  session = {
    ...session,
    ...patch,
    graphs: patch.graphs ? patch.graphs.slice(0, 40) : session.graphs,
    queue: patch.queue ? patch.queue.slice(0, 40) : session.queue,
    tasks: patch.tasks ? patch.tasks.slice(0, 120) : session.tasks,
    approvals: patch.approvals ? patch.approvals.slice(0, 40) : session.approvals,
  };
  return session;
}

export function registerTasksAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestTasksAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function graphIsLive(state: GraphState): boolean {
  return state === "queued" || state === "running" || state === "paused";
}

export function filterGraphs(
  graphs: TaskGraph[],
  options: { filter?: TasksFilter; query?: string },
): TaskGraph[] {
  const filter = options.filter ?? "all";
  const query = String(options.query || "")
    .trim()
    .toLowerCase();
  return graphs.filter((graph) => {
    if (filter === "live" && !graphIsLive(graph.state)) return false;
    if (filter === "queued" && graph.state !== "queued") return false;
    if (filter === "paused" && graph.state !== "paused") return false;
    if (filter === "failed" && graph.state !== "failed") return false;
    if (filter === "done" && graph.state !== "completed" && graph.state !== "cancelled")
      return false;
    if (filter === "idle" && graph.priority !== "idle") return false;
    if (filter === "waiting" && !graph.nodes.some((node) => node.state === "waiting")) return false;
    if (query && !`${graph.request} ${graph.id} ${graph.state}`.toLowerCase().includes(query)) {
      return false;
    }
    return true;
  });
}

export function filterLedger(
  tasks: TaskRecord[],
  options: { filter?: TasksFilter; query?: string },
): TaskRecord[] {
  const filter = options.filter ?? "all";
  const query = String(options.query || "")
    .trim()
    .toLowerCase();
  return tasks.filter((task) => {
    if (filter === "live" && !["queued", "running", "awaiting-approval"].includes(task.status)) {
      return false;
    }
    if (filter === "queued" && task.status !== "queued") return false;
    if (filter === "paused") return false;
    if (filter === "failed" && task.status !== "failed" && task.status !== "timeout") return false;
    if (filter === "done" && task.status !== "done" && task.status !== "cancelled") return false;
    if (filter === "idle") return false;
    if (filter === "waiting" && task.status !== "awaiting-approval") return false;
    if (
      query &&
      !`${task.title} ${task.kind} ${task.id} ${task.status}`.toLowerCase().includes(query)
    ) {
      return false;
    }
    return true;
  });
}

export function summarizeTaskErrors(
  graphs: TaskGraph[],
  tasks: TaskRecord[],
  maxLines = 12,
): string {
  const lines: string[] = [];
  for (const graph of graphs) {
    if (graph.state === "failed" || graph.error) {
      lines.push(
        `${graph.state} ${graph.request.slice(0, 80)}${graph.error ? ` — ${graph.error}` : ""}`,
      );
    }
    for (const node of graph.nodes) {
      if (node.state === "failed" && node.error) {
        lines.push(`${node.title}: ${node.error}`);
      }
    }
  }
  for (const task of tasks) {
    if ((task.status === "failed" || task.status === "timeout") && task.error) {
      lines.push(`${task.title}: ${task.error}`);
    }
  }
  return lines.slice(-maxLines).join("\n");
}

export function formatTasksExtra(maxChars = 4000): string {
  const snap = readLiveTasks();
  const live = snap.graphs.filter((graph) => graphIsLive(graph.state));
  const running = snap.graphs.find((graph) => graph.id === snap.runningId);
  const body = (running ? [running] : live)
    .slice(0, 4)
    .map((graph) => {
      const progress = graphProgress(graph);
      const current = graph.nodes.find(
        (node) => node.state === "running" || node.state === "retrying",
      );
      const checkpoint =
        current?.checkpoint ??
        [...graph.nodes].reverse().find((node) => node.checkpoint)?.checkpoint;
      return [
        `${graph.state}: ${graph.request.slice(0, 140)}`,
        `${progress.done}/${progress.total} subtasks${current ? ` — now: ${current.title}` : ""}`,
        graph.horizon?.deadline ? `deadline: ${graph.horizon.deadline}` : "",
        checkpoint?.nextAction ? `next: ${checkpoint.nextAction}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n")
    .slice(-maxChars);
  const errors = summarizeTaskErrors(snap.graphs, snap.tasks).slice(-1200);
  const waiting = snap.approvals.map((row) => row.question).filter(Boolean);
  return [
    "TASKS SESSION (live FRIDAY task graph + ledger — not invented)",
    `graphs: ${snap.graphs.length}`,
    `queue: ${snap.queue.length}`,
    `running: ${running ? running.request.slice(0, 120) : "none"}`,
    `idle paused: ${snap.idlePaused ? "yes" : "no"}`,
    waiting.length
      ? `waiting approval:\n${waiting.slice(0, 4).join("\n")}`
      : "waiting approval: none",
    errors ? `recent errors:\n${errors}` : "recent errors: none in this buffer",
    "recent live graphs:",
    body || "(empty)",
  ].join("\n");
}

export function resetTasksSession(): void {
  session = empty();
}
