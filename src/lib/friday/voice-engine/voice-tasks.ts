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
  TERMINAL,
  type TaskContext,
  type TaskRisk,
  type VoiceTask,
} from "./task-orchestrator";
import type { VoiceControl } from "./interruption-controller";
import { sanitizeForSpeech, type NarrateEvent, type NarrationLang } from "./narration-policy";
import { stripChange, type Route, type RouterTask } from "./utterance-router";

export type TaskWork = (task: VoiceTask, context: TaskContext) => Promise<string>;

const announcer = new TaskAnnouncer();
let speaker: ((text: string) => void) | null = null;
let busyNow: () => VoiceBusy = () => "idle";

const listeners = new Set<() => void>();
let snapshot: VoiceTask[] = [];
const refresh = () => {
  snapshot = orchestrator.list();
  for (const listener of listeners) listener();
};

/** The conductor's narrator: every update of every task goes here when one is attached (see narration-policy). */
export type TaskNarrator = (update: TaskUpdate, task: VoiceTask) => void;
let narrator: TaskNarrator | null = null;
/** While a "cancel everything" runs, the one summary line is spoken instead of one line per task. */
let hushCancels = false;
let focusTask = "";

const orchestrator: TaskOrchestrator = new TaskOrchestrator({
  // The clock is read at each call (not captured), so a test clock and the router's "now" agree.
  now: () => Date.now(),
  run: (task, context, payload) =>
    typeof payload === "function"
      ? (payload as TaskWork)(task, context)
      : Promise.reject(new Error("no work was given for this task")),
  onUpdate: (task, update) => {
    refresh();
    if (narrator) {
      if (hushCancels && update.kind === "cancelled") return;
      narrator(update, task);
      return;
    }
    for (const line of announcer.offer(update, busyNow())) speaker?.(line.text);
  },
});

/** The conductor narrates task updates itself (priorities, caps, gates). Pass null to fall back to the announcer. */
export function attachVoiceTaskNarrator(next: TaskNarrator | null): void {
  narrator = next;
}

/** The task she last spoke about, for "that one" and a bare "more detail". */
export function setTaskFocus(id: string): void {
  focusTask = id;
}
export function taskFocusId(): string | undefined {
  return focusTask && orchestrator.get(focusTask) ? focusTask : undefined;
}

/** The desk as the utterance router reads it. */
export function routerTasks(): RouterTask[] {
  return orchestrator.list().map((t) => ({
    id: t.id,
    label: t.label,
    state: t.state,
    createdAt: t.createdAt,
  }));
}

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
  const made = orchestrator.create({ label, risk, payload: job });
  refresh();
  return made;
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

/** For the Tasks panel: a stable snapshot that changes only when a task changes. */
export function voiceTaskSnapshot(): VoiceTask[] {
  return snapshot;
}

export function subscribeVoiceTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Buttons of the Tasks panel. Each returns whether it changed anything. */
export const voiceTaskActions = {
  cancel: (id: string): boolean => orchestrator.cancel(id) && (refresh(), true),
  pause: (id: string): boolean => orchestrator.pause(id) && (refresh(), true),
  resume: (id: string): boolean => orchestrator.resume(id) && (refresh(), true),
  approve: (id: string, yes: boolean): boolean =>
    orchestrator.approve(id, yes) && (refresh(), true),
};

/**
 * Stop everything: every task that has not finished is cancelled, so none ends as COMPLETED with the words of a
 * stopped run. Returns how many were cancelled. A finished task is left as it is.
 */
export function cancelAllVoiceTasks(options: { quiet?: boolean } = {}): number {
  let count = 0;
  hushCancels = Boolean(options.quiet);
  try {
    for (const task of orchestrator.list()) if (orchestrator.cancel(task.id)) count += 1;
  } finally {
    hushCancels = false;
  }
  if (count) refresh();
  return count;
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

/* ---------- what a task update says, and what a spoken task word does ---------- */

/**
 * The narration event an update stands for. A cancel has no spoken policy of its own (the owner asked for it) and
 * returns null; the conductor says it as a plain direct line.
 */
export function narrationEventFor(update: TaskUpdate, task: VoiceTask): NarrateEvent | null {
  const id = update.taskId;
  switch (update.kind) {
    case "started":
      return { kind: "ack", taskId: id };
    case "progress":
      return {
        kind: "progress",
        taskId: id,
        label: task.label,
        ...(typeof update.percent === "number" ? { percent: update.percent } : {}),
        ...(update.text ? { step: update.text } : {}),
      };
    case "needs-approval":
      return { kind: "needs-approval", taskId: id, label: task.label };
    case "needs-input":
      return { kind: "needs-input", taskId: id, label: task.label };
    case "failed":
      return {
        kind: "failed",
        taskId: id,
        label: task.label,
        ...(task.error ? { cause: task.error } : {}),
      };
    case "completed":
      return {
        kind: "done",
        taskId: id,
        label: task.label,
        ...(task.result ? { answer: task.result } : {}),
      };
    case "cancelled":
      return null;
  }
}

/** The order with change-of-mind words ("actually", "instead", "rukko") taken off the front, in its own casing. */
export function withoutChangeOfMind(text: string): string {
  const mind = stripChange(text.trim());
  return mind.changed ? mind.rest.replace(/^[\s,.;:!?-]+/u, "") : text;
}

/** The label as it may be said aloud: the owner's own words, with links, paths and secret-looking values removed. */
export function speakableLabel(label: string): string {
  const clean = sanitizeForSpeech(label);
  return clean.removed || clean.unsafe || clean.secret ? "" : clean.text.trim();
}

const STATE_WORDS: Record<NarrationLang, Partial<Record<VoiceTask["state"], string>>> = {
  en: {
    RUNNING: "running",
    QUEUED: "waiting its turn",
    CREATED: "waiting its turn",
    PAUSED: "paused",
    WAITING_FOR_APPROVAL: "waiting for your yes",
    WAITING_FOR_INPUT: "waiting for your answer",
    COMPLETED: "done",
    FAILED: "failed",
    CANCELLED: "cancelled",
  },
  hi: {
    RUNNING: "chal raha hai",
    QUEUED: "apni baari ka intezaar",
    CREATED: "apni baari ka intezaar",
    PAUSED: "ruka hua hai",
    WAITING_FOR_APPROVAL: "aapki haan ka intezaar",
    WAITING_FOR_INPUT: "aapke jawab ka intezaar",
    COMPLETED: "ho gaya",
    FAILED: "nahi ho paya",
    CANCELLED: "radd ho gaya",
  },
};

/** One short spoken summary of the desk: the live tasks first, at most three named. */
export function taskStatusLine(
  lang: NarrationLang,
  tasks: readonly VoiceTask[] = orchestrator.list(),
): string {
  const live = tasks.filter((t) => !TERMINAL.includes(t.state));
  const shown = (live.length ? live : tasks.slice(-1)).slice(-3);
  if (!shown.length) return lang === "hi" ? "Abhi koi kaam nahi chal raha." : "Nothing is running.";
  const parts = shown.map((t) => {
    const name = speakableLabel(t.label) || (lang === "hi" ? "ek kaam" : "a task");
    const word = STATE_WORDS[lang][t.state] ?? "";
    const pct =
      t.state === "RUNNING" && typeof t.percent === "number" ? `, ${t.percent} percent` : "";
    return `${name}: ${word}${pct}`;
  });
  const head =
    live.length > 1
      ? lang === "hi"
        ? `${live.length} kaam hain. `
        : `${live.length} tasks. `
      : "";
  return `${head}${parts.join(". ")}.`;
}

/**
 * Apply a `task-control` route and return the one line to say. A cancel needs no line of its own (the task desk
 * announces it); pause and resume are quiet on the desk, so they get one here.
 */
export function applyTaskRoute(route: Route, lang: NarrationLang): string | null {
  const hi = lang === "hi";
  const action = route.action;
  if (route.ambiguous) {
    const names = (route.candidates ?? [])
      .map((id) => orchestrator.get(id))
      .filter((t): t is VoiceTask => Boolean(t))
      .slice(0, 3)
      .map((t) => speakableLabel(t.label) || t.id);
    return hi ? `Kaun sa: ${names.join(" ya ")}?` : `Which one: ${names.join(" or ")}?`;
  }
  if (route.reason === "no-such-task")
    return hi ? "Is naam ka koi kaam nahi mila." : "I don't have a task like that.";
  if (route.reason === "no-task")
    return action === "resume"
      ? hi
        ? "Koi kaam ruka hua nahi hai."
        : "No task is paused."
      : hi
        ? "Koi kaam nahi chal raha."
        : "No task is running.";
  if (route.ref && "all" in route.ref) {
    const n = cancelAllVoiceTasks({ quiet: true });
    if (!n) return hi ? "Koi kaam nahi chal raha." : "No task is running.";
    return hi
      ? `${n} kaam radd kar diye.`
      : n === 1
        ? "Cancelled the task."
        : `Cancelled ${n} tasks.`;
  }
  const id = route.ref && "taskId" in route.ref ? route.ref.taskId : "";
  const task = id ? orchestrator.get(id) : null;
  if (!task || !action) return null;
  const name = speakableLabel(task.label) || (hi ? "ye kaam" : "that task");
  if (action === "cancel") {
    return voiceTaskActions.cancel(id)
      ? null
      : hi
        ? `${name} abhi radd nahi ho sakta.`
        : `I could not cancel ${name} right now.`;
  }
  if (action === "pause" || action === "resume") {
    const done = action === "pause" ? voiceTaskActions.pause(id) : voiceTaskActions.resume(id);
    if (!done)
      return hi
        ? `${name} ke saath abhi ye nahi ho sakta.`
        : `I could not ${action} ${name} right now.`;
    focusTask = id;
    return action === "pause"
      ? hi
        ? `${name} roka.`
        : `Paused: ${name}.`
      : hi
        ? `${name} phir shuru.`
        : `Resumed: ${name}.`;
  }
  // status, detail and repeat about one task: what it is doing, or what it said when it finished
  focusTask = id;
  if ((action === "detail" || action === "repeat") && task.state === "COMPLETED" && task.result) {
    const said = sanitizeForSpeech(task.result);
    if (!said.unsafe && !said.secret) return said.text.trim() || null;
  }
  return taskStatusLine(lang, [task]);
}

/* ---------- the owner's task settings (voice.tasks), read safely ---------- */

export type TaskPrefs = {
  maxParallel: number;
  narration: "normal" | "quiet" | "chatty";
  progressLinesPerMinute: number;
  speakDone: boolean;
  resumeAfterRestart: "ask" | "auto";
  sideQuestionLane: boolean;
};

export const TASK_PREF_DEFAULTS: TaskPrefs = {
  maxParallel: 1,
  narration: "normal",
  progressLinesPerMinute: 3,
  speakDone: true,
  resumeAfterRestart: "ask",
  sideQuestionLane: true,
};

/** The stored `voice.tasks` row (absent or old shapes included) as safe values; a missing key takes its default. */
export function taskPrefsFrom(raw: unknown): TaskPrefs {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(hi, Math.max(lo, Math.round(v)))
      : fallback;
  const narration =
    row["narration"] === "quiet" || row["narration"] === "chatty" ? row["narration"] : "normal";
  return {
    maxParallel: num(row["maxParallel"], 1, 4, TASK_PREF_DEFAULTS.maxParallel),
    narration,
    progressLinesPerMinute: num(
      row["progressLinesPerMinute"],
      0,
      12,
      TASK_PREF_DEFAULTS.progressLinesPerMinute,
    ),
    speakDone: row["speakDone"] !== false,
    resumeAfterRestart: row["resumeAfterRestart"] === "auto" ? "auto" : "ask",
    sideQuestionLane: row["sideQuestionLane"] !== false,
  };
}

/** How many progress-class lines a minute may be spoken: the setting, shaped by the narration level. */
export function progressLinesFor(prefs: TaskPrefs): number {
  if (prefs.narration === "quiet") return Math.min(1, prefs.progressLinesPerMinute);
  if (prefs.narration === "chatty") return Math.max(6, prefs.progressLinesPerMinute);
  return prefs.progressLinesPerMinute;
}

export type { TaskUpdate };
