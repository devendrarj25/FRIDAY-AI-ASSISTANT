/**
 * FRIDAY · core/orchestration
 *
 * The task queue behind every FRIDAY action. Guarantees exactly the things
 * that were missing before: bounded concurrency, cancellation, timeouts,
 * retries, progress and de-duplication (the same key never runs twice at the
 * same time).
 */
import type { FridayModule, ModuleContext } from "../types";
import { bus } from "../event-bus";

export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled" | "timeout";

export interface TaskHandle<T = unknown> {
  id: string;
  key: string;
  state: TaskState;
  promise: Promise<T>;
  cancel: (reason?: string) => void;
}

export interface TaskOptions {
  /** De-duplication key. A second submit with a live key joins the first run. */
  key: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  priority?: number;
}

export interface TaskRunContext {
  signal: AbortSignal;
  progress: (percent: number, label?: string) => void;
}

interface QueuedTask {
  id: string;
  key: string;
  priority: number;
  start: () => void;
}

let counter = 0;
const nextId = () => `task-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export class TaskQueue {
  private running = new Map<string, TaskHandle<unknown>>();
  private pending: QueuedTask[] = [];
  private concurrency = 4;

  setConcurrency(value: number): void {
    this.concurrency = Math.max(1, value);
    this.drain();
  }

  active(): TaskHandle<unknown>[] {
    return [...this.running.values()];
  }

  submit<T>(options: TaskOptions, run: (ctx: TaskRunContext) => Promise<T>): TaskHandle<T> {
    const existing = this.running.get(options.key);
    if (existing) return existing as TaskHandle<T>;

    const id = nextId();
    const controller = new AbortController();
    let settle!: (value: T) => void;
    let fail!: (error: unknown) => void;

    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    const handle: TaskHandle<T> = {
      id,
      key: options.key,
      state: "queued",
      promise,
      cancel: (reason = "cancelled by user") => {
        if (handle.state === "done" || handle.state === "failed") return;
        handle.state = "cancelled";
        controller.abort(reason);
        this.pending = this.pending.filter((t) => t.id !== id);
        this.finish(handle, () => fail(new Error(reason)));
      },
    };

    const attempt = async (left: number): Promise<void> => {
      handle.state = "running";
      bus.emit("task:started", { id, key: options.key });
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const work = run({
          signal: controller.signal,
          progress: (percent, label) =>
            bus.emit("task:progress", { id, key: options.key, percent, label }),
        });
        const guarded = options.timeoutMs
          ? Promise.race([
              work,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort("timeout");
                  reject(new Error(`task "${options.key}" timed out`));
                }, options.timeoutMs);
              }),
            ])
          : work;
        const value = await guarded;
        if (timer) clearTimeout(timer);
        handle.state = "done";
        this.finish(handle, () => settle(value));
        bus.emit("task:done", { id, key: options.key });
      } catch (error) {
        if (timer) clearTimeout(timer);
        if ((handle.state as TaskState) === "cancelled") return;
        if (left > 0 && !controller.signal.aborted) {
          bus.emit("task:retry", { id, key: options.key, left });
          await new Promise((r) => setTimeout(r, options.retryDelayMs ?? 400));
          return attempt(left - 1);
        }
        handle.state = controller.signal.aborted ? "timeout" : "failed";
        this.finish(handle, () => fail(error));
        bus.emit("task:failed", { id, key: options.key, error: String(error) });
      }
    };

    this.running.set(options.key, handle as TaskHandle<unknown>);
    this.pending.push({
      id,
      key: options.key,
      priority: options.priority ?? 0,
      start: () => void attempt(options.retries ?? 0),
    });
    this.drain();
    return handle;
  }

  cancelAll(reason = "shutting down"): void {
    for (const handle of [...this.running.values()]) handle.cancel(reason);
  }

  private finish(handle: TaskHandle<unknown> | TaskHandle<never>, settle: () => void): void {
    this.running.delete(handle.key);
    settle();
    this.drain();
  }

  private drain(): void {
    const inFlight = [...this.running.values()].filter((h) => h.state === "running").length;
    let slots = this.concurrency - inFlight;
    if (slots <= 0 || this.pending.length === 0) return;
    this.pending.sort((a, b) => b.priority - a.priority);
    while (slots-- > 0) {
      const next = this.pending.shift();
      if (!next) return;
      next.start();
    }
  }
}

export const tasks = new TaskQueue();

export type OrchestrationModule = FridayModule;

export const orchestrationModule: OrchestrationModule = {
  id: "core/orchestration",
  init(ctx: ModuleContext) {
    bus.on("task:failed", (payload) => ctx.log("error", "task failed", payload));
  },
  dispose() {
    tasks.cancelAll();
  },
};

export default orchestrationModule;
