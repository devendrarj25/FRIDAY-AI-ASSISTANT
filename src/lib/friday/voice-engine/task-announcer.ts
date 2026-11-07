/**
 * FRIDAY · spoken updates for background work.
 *
 * Background tasks keep running while the owner talks; this decides what is worth saying and when. A task's
 * own state lives in the task ledger and `background-tasks.ts`; the voice state is separate and is only an input
 * here. Rules: say start, a real milestone, a need for input or approval, a failure, and the finish; never speak
 * over the owner or over FRIDAY's own answer; hold updates while busy and release them in order; merge progress
 * lines of the same task so only the newest is spoken; the held list is bounded.
 */

export type TaskUpdate = {
  taskId: string;
  kind:
    | "started"
    | "progress"
    | "needs-input"
    | "needs-approval"
    | "completed"
    | "failed"
    | "cancelled";
  text: string;
  /** Whole percent, when the task really reports one. */
  percent?: number;
};

export type VoiceBusy = "listening-to-owner" | "speaking" | "idle";

const URGENT = new Set<TaskUpdate["kind"]>(["needs-input", "needs-approval", "failed"]);

export class TaskAnnouncer {
  private held: TaskUpdate[] = [];
  private lastProgress = new Map<string, { percent: number; at: number }>();

  constructor(
    private readonly options: {
      maxHeld?: number;
      progressStepPercent?: number;
      progressMinGapMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** True when this update is worth saying at all. */
  private worthSaying(update: TaskUpdate): boolean {
    if (update.kind !== "progress") return true;
    const step = this.options.progressStepPercent ?? 25;
    const gap = this.options.progressMinGapMs ?? 20_000;
    if (typeof update.percent !== "number") return false;
    const last = this.lastProgress.get(update.taskId);
    const moved = update.percent - (last?.percent ?? 0) >= step;
    const waited = !last || this.now() - last.at >= gap;
    if (moved && waited) {
      this.lastProgress.set(update.taskId, { percent: update.percent, at: this.now() });
      return true;
    }
    return false;
  }

  /** Returns what to speak now (possibly nothing). Updates that must wait are held. */
  offer(update: TaskUpdate, busy: VoiceBusy): TaskUpdate[] {
    if (!this.worthSaying(update)) return [];
    if (busy !== "idle") {
      this.hold(update);
      return [];
    }
    return [...this.drain(), update];
  }

  /** The owner stopped talking or FRIDAY finished a reply: release what waited, in order. */
  release(busy: VoiceBusy): TaskUpdate[] {
    return busy === "idle" ? this.drain() : [];
  }

  pending(): number {
    return this.held.length;
  }

  private drain(): TaskUpdate[] {
    // Needs-input, approval and failure come first; the rest keep the order they arrived in.
    const out = [
      ...this.held.filter((h) => URGENT.has(h.kind)),
      ...this.held.filter((h) => !URGENT.has(h.kind)),
    ];
    this.held = [];
    return out;
  }

  private hold(update: TaskUpdate): void {
    if (update.kind === "progress") {
      this.held = this.held.filter((h) => !(h.taskId === update.taskId && h.kind === "progress"));
    }
    this.held.push(update);
    const max = this.options.maxHeld ?? 8;
    while (this.held.length > max) {
      const drop = this.held.findIndex((h) => h.kind === "progress" || h.kind === "started");
      this.held.splice(drop >= 0 ? drop : 0, 1);
    }
  }
}
