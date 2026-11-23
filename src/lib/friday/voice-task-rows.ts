/**
 * FRIDAY · what the voice task panel shows for each task (pure) and the buttons it calls.
 *
 * The rows are plain words with an ordinal and a waiting reason; the buttons are the task desk's own exports.
 */
import { cancelAllVoiceTasks, voiceTaskActions } from "./voice-engine/voice-tasks";
import { TERMINAL, type VoiceTask } from "./voice-engine/task-orchestrator";

/** The state of a task in plain words. INTERRUPTED is a task a restart cut short (the desk may not set it yet). */
const WORDS: Record<string, string> = {
  CREATED: "starting",
  QUEUED: "queued",
  RUNNING: "running",
  WAITING_FOR_INPUT: "waiting for your answer",
  WAITING_FOR_APPROVAL: "waiting for your yes",
  PAUSED: "paused",
  COMPLETED: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
};

/** Fields the task desk may add later; every one is optional, so the panel works with today's tasks too. */
type TaskExtras = { spoken?: string; ordinal?: number; reason?: string };

export type TaskRow = {
  id: string;
  ordinal: number;
  name: string;
  state: string;
  words: string;
  /** Why it is not running (a yes, an answer, an earlier task), or empty. */
  waiting: string;
  detail: string;
  live: boolean;
  canRetry: boolean;
};

const ordinalOf = (task: VoiceTask, index: number): number => {
  const extra = (task as VoiceTask & TaskExtras).ordinal;
  if (typeof extra === "number" && Number.isFinite(extra)) return extra;
  const seq = /(\d+)$/.exec(task.id);
  return seq ? Number(seq[1]) : index + 1;
};

/** The rows the panel shows: newest first, at most `limit`, each with its ordinal, plain state and waiting reason. */
export function taskRows(tasks: readonly VoiceTask[], limit = 5): TaskRow[] {
  const running = tasks.find((t) => t.state === "RUNNING");
  return tasks
    .map((task, index) => ({ task, index }))
    .slice(-limit)
    .reverse()
    .map(({ task, index }) => {
      const extras = task as VoiceTask & TaskExtras;
      const state = String(task.state);
      const note = (extras.reason ?? task.note ?? "").trim();
      let waiting = "";
      if (state === "WAITING_FOR_APPROVAL")
        waiting = note || "it changes something, so it asks first";
      else if (state === "WAITING_FOR_INPUT") waiting = note || "it needs an answer from you";
      else if (state === "QUEUED" && running)
        waiting = `behind task ${ordinalOf(running, tasks.indexOf(running))}`;
      else if (state === "PAUSED") waiting = note;
      const live = !TERMINAL.includes(task.state) && state !== "INTERRUPTED";
      const detail =
        state === "FAILED" && task.error
          ? task.error
          : live && task.percent !== undefined
            ? `${task.percent}%`
            : "";
      return {
        id: task.id,
        ordinal: ordinalOf(task, index),
        name: (extras.spoken ?? task.label).trim() || task.label,
        state,
        words: WORDS[state] ?? state.toLowerCase().replace(/_/g, " "),
        waiting,
        detail,
        live,
        canRetry: state === "FAILED" || state === "INTERRUPTED",
      };
    });
}

export type TaskPanelActions = {
  approve: (id: string, yes: boolean) => boolean;
  pause: (id: string) => boolean;
  resume: (id: string) => boolean;
  cancel: (id: string) => boolean;
  /** Present only when the task desk can run a failed or interrupted task again. */
  retry?: ((id: string) => boolean) | undefined;
  cancelAll: () => number;
};

/** The task desk's own buttons. `retry` appears the day the desk exports it; no button is drawn for what does not exist. */
export const liveTaskActions: TaskPanelActions = {
  approve: voiceTaskActions.approve,
  pause: voiceTaskActions.pause,
  resume: voiceTaskActions.resume,
  cancel: voiceTaskActions.cancel,
  retry: (voiceTaskActions as { retry?: (id: string) => boolean }).retry,
  cancelAll: cancelAllVoiceTasks,
};
