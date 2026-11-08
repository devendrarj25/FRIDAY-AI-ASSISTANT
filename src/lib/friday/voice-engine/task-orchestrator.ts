/**
 * FRIDAY · voice task orchestrator (work that continues while the owner keeps talking).
 *
 * A task is separate from the voice state: starting, pausing or cancelling one never changes whether FRIDAY is
 * listening or speaking, and a spoken "stop" never touches a task (see `classifyVoiceControl`). `create`
 * returns at once; the work runs on a bounded worker pool (one heavy worker by default) and reports through
 * `onUpdate`, which feeds the `TaskAnnouncer`. A risky task waits for an explicit yes before it starts.
 *
 * Pause is cooperative: the runner calls `ctx.checkpoint()` between steps, which waits while paused and throws
 * when the task was cancelled. A runner that never checkpoints cannot be paused, only cancelled.
 */
import type { TaskUpdate } from "./task-announcer";

export type TaskState =
  | "CREATED"
  | "QUEUED"
  | "RUNNING"
  | "WAITING_FOR_INPUT"
  | "WAITING_FOR_APPROVAL"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type TaskRisk = "safe" | "needs-approval";

export type VoiceTask = {
  id: string;
  label: string;
  state: TaskState;
  risk: TaskRisk;
  createdAt: number;
  updatedAt: number;
  percent?: number;
  note?: string;
  result?: string;
  error?: string;
};

export type TaskContext = {
  signal: AbortSignal;
  progress: (percent: number | undefined, note: string) => void;
  /** Await between steps: waits while paused, throws when cancelled. */
  checkpoint: () => Promise<void>;
};

export type TaskRunner = (
  task: VoiceTask,
  context: TaskContext,
  payload?: unknown,
) => Promise<string>;

const NEXT: Record<TaskState, TaskState[]> = {
  CREATED: ["QUEUED", "WAITING_FOR_APPROVAL", "CANCELLED"],
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: [
    "WAITING_FOR_INPUT",
    "WAITING_FOR_APPROVAL",
    "PAUSED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ],
  WAITING_FOR_INPUT: ["RUNNING", "CANCELLED", "FAILED"],
  WAITING_FOR_APPROVAL: ["QUEUED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL: TaskState[] = ["COMPLETED", "FAILED", "CANCELLED"];

export function canMoveTask(from: TaskState, to: TaskState): boolean {
  return NEXT[from].includes(to);
}

export type OrchestratorOptions = {
  run: TaskRunner;
  maxWorkers?: number;
  /** Tasks that may wait (queued or waiting for approval) at once. */
  maxWaiting?: number;
  /** How many finished tasks are remembered. */
  keepFinished?: number;
  now?: () => number;
  onUpdate?: (task: VoiceTask, update: TaskUpdate) => void;
};

export class TaskOrchestrator {
  private readonly tasks = new Map<string, VoiceTask>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly payloads = new Map<string, unknown>();
  private readonly gates = new Map<string, { paused: boolean; wake: (() => void)[] }>();
  private seq = 0;
  private readonly maxWorkers: number;
  private readonly maxWaiting: number;
  private readonly keepFinished: number;
  private readonly now: () => number;

  constructor(private readonly options: OrchestratorOptions) {
    this.maxWorkers = Math.max(1, options.maxWorkers ?? 1);
    this.maxWaiting = Math.max(1, options.maxWaiting ?? 8);
    this.keepFinished = Math.max(1, options.keepFinished ?? 20);
    this.now = options.now ?? Date.now;
  }

  list(): VoiceTask[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  get(id: string): VoiceTask | null {
    const task = this.tasks.get(id);
    return task ? { ...task } : null;
  }

  /** The newest task that has not finished, for "cancel the task" with no name. */
  latestActive(): VoiceTask | null {
    const active = [...this.tasks.values()].filter((t) => !TERMINAL.includes(t.state));
    const last = active[active.length - 1];
    return last ? { ...last } : null;
  }

  create(input: {
    label: string;
    risk?: TaskRisk;
    payload?: unknown;
  }): { ok: true; task: VoiceTask } | { ok: false; error: string } {
    const waiting = [...this.tasks.values()].filter(
      (t) => t.state === "QUEUED" || t.state === "WAITING_FOR_APPROVAL" || t.state === "CREATED",
    ).length;
    if (waiting >= this.maxWaiting)
      return { ok: false, error: "too many tasks are waiting; finish or cancel one first" };
    const t = this.now();
    const task: VoiceTask = {
      id: `task-${(this.seq += 1)}`,
      label: input.label.slice(0, 120),
      state: "CREATED",
      risk: input.risk ?? "safe",
      createdAt: t,
      updatedAt: t,
    };
    this.tasks.set(task.id, task);
    this.aborts.set(task.id, new AbortController());
    this.payloads.set(task.id, input.payload);
    if (task.risk === "needs-approval") {
      this.move(
        task,
        "WAITING_FOR_APPROVAL",
        "needs-approval",
        `${task.label}: I need your yes before I start.`,
      );
    } else {
      this.move(task, "QUEUED", "started", `Started: ${task.label}.`);
      this.pump();
    }
    this.trim();
    return { ok: true, task: { ...task } };
  }

  /** The owner's answer to a task that asked for approval. A no cancels it. */
  approve(id: string, yes: boolean): boolean {
    const task = this.tasks.get(id);
    if (!task || task.state !== "WAITING_FOR_APPROVAL") return false;
    if (!yes) return this.cancel(id);
    this.move(task, "QUEUED", "started", `Started: ${task.label}.`);
    this.pump();
    return true;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || TERMINAL.includes(task.state)) return false;
    this.aborts.get(id)?.abort();
    this.gates
      .get(id)
      ?.wake.splice(0)
      .forEach((w) => w());
    this.move(task, "CANCELLED", "cancelled", `Cancelled: ${task.label}.`);
    this.pump();
    return true;
  }

  pause(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.state !== "RUNNING") return false;
    const gate = this.gates.get(id);
    if (!gate) return false;
    gate.paused = true;
    this.move(task, "PAUSED", "progress", `Paused: ${task.label}.`, true);
    return true;
  }

  resume(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.state !== "PAUSED") return false;
    const gate = this.gates.get(id);
    if (gate) {
      gate.paused = false;
      gate.wake.splice(0).forEach((w) => w());
    }
    this.move(task, "RUNNING", "progress", `Resumed: ${task.label}.`, true);
    return true;
  }

  private move(
    task: VoiceTask,
    to: TaskState,
    kind: TaskUpdate["kind"],
    text: string,
    quiet = false,
  ): void {
    if (!canMoveTask(task.state, to))
      throw new Error(`a task cannot go from ${task.state} to ${to}`);
    task.state = to;
    task.updatedAt = this.now();
    if (!quiet || kind !== "progress")
      this.options.onUpdate?.({ ...task }, { taskId: task.id, kind, text });
  }

  private running(): number {
    return [...this.tasks.values()].filter((t) => t.state === "RUNNING" || t.state === "PAUSED")
      .length;
  }

  private pump(): void {
    while (this.running() < this.maxWorkers) {
      const next = [...this.tasks.values()].find((t) => t.state === "QUEUED");
      if (!next) return;
      this.start(next);
    }
  }

  private start(task: VoiceTask): void {
    const abort = this.aborts.get(task.id) ?? new AbortController();
    const gate = { paused: false, wake: [] as (() => void)[] };
    this.gates.set(task.id, gate);
    task.state = "RUNNING";
    task.updatedAt = this.now();
    const context: TaskContext = {
      signal: abort.signal,
      progress: (percent, note) => {
        if (TERMINAL.includes(task.state)) return;
        if (percent !== undefined) task.percent = Math.max(0, Math.min(100, Math.round(percent)));
        task.note = note.slice(0, 160);
        task.updatedAt = this.now();
        this.options.onUpdate?.(
          { ...task },
          {
            taskId: task.id,
            kind: "progress",
            text: note,
            ...(task.percent === undefined ? {} : { percent: task.percent }),
          },
        );
      },
      checkpoint: async () => {
        while (gate.paused && !abort.signal.aborted)
          await new Promise<void>((r) => gate.wake.push(r));
        if (abort.signal.aborted) throw new DOMException("cancelled", "AbortError");
      },
    };
    void (async () => {
      try {
        const result = await this.options.run({ ...task }, context, this.payloads.get(task.id));
        if (!TERMINAL.includes(task.state)) {
          this.unpause(task);
          task.result = result.slice(0, 2000);
          this.move(
            task,
            "COMPLETED",
            "completed",
            `Done: ${task.label}. ${result.slice(0, 200)}`.trim(),
          );
        }
      } catch (error) {
        if (!TERMINAL.includes(task.state)) {
          this.unpause(task);
          task.error = error instanceof Error ? error.message : String(error);
          this.move(task, "FAILED", "failed", `${task.label} failed: ${task.error}`);
        }
      } finally {
        this.gates.delete(task.id);
        this.aborts.delete(task.id);
        this.payloads.delete(task.id);
        this.pump();
        this.trim();
      }
    })();
  }

  /** A runner that never checkpoints can finish while the task is marked paused; it is running again for good. */
  private unpause(task: VoiceTask): void {
    if (task.state === "PAUSED") task.state = "RUNNING";
  }

  private trim(): void {
    const finished = [...this.tasks.values()].filter((t) => TERMINAL.includes(t.state));
    for (const old of finished.slice(0, Math.max(0, finished.length - this.keepFinished)))
      this.tasks.delete(old.id);
  }
}
