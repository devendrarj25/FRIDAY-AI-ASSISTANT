/**
 * FRIDAY · the voice task desk (one shared orchestrator and announcer).
 *
 * Work that should continue while the owner keeps talking is started with `startVoiceTask`. Its updates go to
 * the announcer, which waits for a quiet moment before they are spoken. Spoken task words ("cancel the task",
 * "pause the task", "resume the task") reach `runTaskControl`; a plain stop never does.
 */
import { TaskAnnouncer, type TaskUpdate, type VoiceBusy } from "./task-announcer";
import {
  TaskOrchestrator,
  type TaskContext,
  type TaskRisk,
  type VoiceTask,
} from "./task-orchestrator";
import type { VoiceControl } from "./interruption-controller";

export type TaskWork = (task: VoiceTask, context: TaskContext) => Promise<string>;

const announcer = new TaskAnnouncer();
let speaker: ((text: string) => void) | null = null;
let busyNow: () => VoiceBusy = () => "idle";

const orchestrator = new TaskOrchestrator({
  run: (task, context, payload) =>
    typeof payload === "function"
      ? (payload as TaskWork)(task, context)
      : Promise.reject(new Error("no work was given for this task")),
  onUpdate: (_task, update) => {
    for (const line of announcer.offer(update, busyNow())) speaker?.(line.text);
  },
});

/** The assistant tells the desk how to speak and when the voice is busy. */
export function attachVoiceTaskSpeaker(speak: (text: string) => void, busy: () => VoiceBusy): void {
  speaker = speak;
  busyNow = busy;
}

/** Call when the voice goes quiet: held updates are spoken in order. */
export function releaseTaskUpdates(): void {
  for (const line of announcer.release(busyNow())) speaker?.(line.text);
}

export function startVoiceTask(
  label: string,
  job: TaskWork,
  risk: TaskRisk = "safe",
): { ok: true; task: VoiceTask } | { ok: false; error: string } {
  return orchestrator.create({ label, risk, payload: job });
}

/** The owner's yes or no to a task that asked for approval. */
export function answerTaskApproval(yes: boolean): string | null {
  const waiting = orchestrator.list().filter((t) => t.state === "WAITING_FOR_APPROVAL");
  const task = waiting[waiting.length - 1];
  if (!task) return null;
  orchestrator.approve(task.id, yes);
  return yes ? `Starting ${task.label}.` : `Cancelled ${task.label}.`;
}

export function listVoiceTasks(): VoiceTask[] {
  return orchestrator.list();
}

/** Apply a spoken task word. Returns the line to say, or null when the words were not about a task. */
export function runTaskControl(control: VoiceControl): string | null {
  if (
    control.kind !== "cancel-task" &&
    control.kind !== "pause-task" &&
    control.kind !== "resume-task"
  )
    return null;
  const target =
    control.kind === "resume-task"
      ? [...orchestrator.list()].reverse().find((t) => t.state === "PAUSED")
      : orchestrator.latestActive();
  if (!target) return control.kind === "resume-task" ? "No task is paused." : "No task is running.";
  const done =
    control.kind === "cancel-task"
      ? orchestrator.cancel(target.id)
      : control.kind === "pause-task"
        ? orchestrator.pause(target.id)
        : orchestrator.resume(target.id);
  if (!done) return `I could not ${control.kind.replace("-task", "")} ${target.label} right now.`;
  return null; // the orchestrator already announced it
}

export type { TaskUpdate };
