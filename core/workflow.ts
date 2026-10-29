/**
 * FRIDAY · core/workflow
 *
 * Executes a plan (or a saved workflow) on top of the task queue: sequential
 * by dependency, parallel where it is safe, with progress, cancellation,
 * timeout, retry, verification and a persisted-shaped history entry.
 * Re-running a workflow that is already running joins the existing run.
 */
import type { PlanStep } from "./brain/planner";
import { verifyResult } from "./brain/decision";
import { bus } from "./event-bus";
import { tasks } from "./orchestration";

export type RunState = "running" | "done" | "failed" | "cancelled";

export interface StepResult {
  stepId: string;
  target: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  ms: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  state: RunState;
  startedAt: number;
  finishedAt?: number;
  results: StepResult[];
}

export type StepExecutor = (step: PlanStep, signal: AbortSignal) => Promise<unknown>;

export interface WorkflowOptions {
  workflowId: string;
  waves: PlanStep[][];
  execute: StepExecutor;
  stepTimeoutMs?: number;
  retries?: number;
  /** Stop the whole run on the first failed step. Defaults to true. */
  stopOnError?: boolean;
}

export class WorkflowEngine {
  private history: WorkflowRun[] = [];
  private readonly historyLimit = 100;

  runs(): WorkflowRun[] {
    return [...this.history];
  }

  /** De-duplicated by workflow id via the task queue. */
  start(options: WorkflowOptions) {
    return tasks.submit<WorkflowRun>(
      { key: `workflow:${options.workflowId}`, retries: 0 },
      async ({ signal, progress }) => {
        const run: WorkflowRun = {
          id: `run-${Date.now().toString(36)}`,
          workflowId: options.workflowId,
          state: "running",
          startedAt: Date.now(),
          results: [],
        };
        this.remember(run);
        bus.emit("workflow:started", { workflowId: options.workflowId, runId: run.id });

        const total = options.waves.reduce((sum, wave) => sum + wave.length, 0) || 1;
        let completed = 0;

        for (const wave of options.waves) {
          if (signal.aborted) break;
          // Steps inside a wave have no dependencies on each other.
          const settled = await Promise.all(
            wave.map((step) => this.runStep(step, options, signal)),
          );
          run.results.push(...settled);
          completed += settled.length;
          progress(Math.round((completed / total) * 100), wave.map((s) => s.target).join(", "));

          const failed = settled.find((r) => !r.ok);
          if (failed && (options.stopOnError ?? true)) {
            run.state = "failed";
            run.finishedAt = Date.now();
            bus.emit("workflow:failed", {
              runId: run.id,
              step: failed.stepId,
              error: failed.error,
            });
            return run;
          }
        }

        run.state = signal.aborted ? "cancelled" : "done";
        run.finishedAt = Date.now();
        bus.emit("workflow:finished", { runId: run.id, state: run.state });
        return run;
      },
    );
  }

  cancel(workflowId: string): void {
    tasks
      .active()
      .filter((t) => t.key === `workflow:${workflowId}`)
      .forEach((t) => t.cancel("cancelled by user"));
  }

  private async runStep(
    step: PlanStep,
    options: WorkflowOptions,
    signal: AbortSignal,
  ): Promise<StepResult> {
    const started = Date.now();
    const attempts = (options.retries ?? 0) + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) break;
      try {
        const value = await this.withTimeout(
          options.execute(step, signal),
          options.stepTimeoutMs ?? 60_000,
          step.target,
        );
        const verification = verifyResult(step, value);
        if (!verification.ok) throw new Error(verification.detail);
        return { stepId: step.id, target: step.target, ok: true, value, ms: Date.now() - started };
      } catch (error) {
        lastError = error;
        bus.emit("workflow:step-retry", { stepId: step.id, attempt: attempt + 1 });
      }
    }

    return {
      stepId: step.id,
      target: step.target,
      ok: false,
      error: String(lastError ?? "cancelled"),
      ms: Date.now() - started,
    };
  }

  private withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      work.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  }

  private remember(run: WorkflowRun): void {
    this.history.push(run);
    if (this.history.length > this.historyLimit) this.history.shift();
  }
}

export const workflows = new WorkflowEngine();
