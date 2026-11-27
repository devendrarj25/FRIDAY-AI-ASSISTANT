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
import { ledger as taskLedger, voiceLedgerId } from "../self/task-ledger";
import { looksSensitive } from "../brain/memory-policy";

export type TaskWork = (task: VoiceTask, context: TaskContext) => Promise<string>;

const announcer = new TaskAnnouncer();
let speaker: ((text: string) => void) | null = null;
let busyNow: () => VoiceBusy = () => "idle";

const listeners = new Set<() => void>();
let snapshot: VoiceTask[] = [];
const refresh = () => {
  snapshot = orchestrator.list();
  mirrorToLedger(snapshot);
  for (const listener of listeners) listener();
};

/* ---------- the ledger copy (write-through) and the work of a task that came back after a restart ---------- */

/** What the desk needs of the task ledger. A test can hand in its own. */
export type VoiceTaskLedger = Pick<
  typeof taskLedger,
  "syncVoiceTask" | "restartVoiceRows" | "markVoiceRows"
>;
let ledgerSink: VoiceTaskLedger | null = taskLedger;
/** Swap the ledger the desk mirrors into (a test), or null for none. Returns the previous one. */
export function setVoiceTaskLedger(next: VoiceTaskLedger | null): VoiceTaskLedger | null {
  const was = ledgerSink;
  ledgerSink = next;
  return was;
}

/** Desk id to ledger row id: a task that came back after a restart keeps the row it came from. */
const ledgerIds = new Map<string, string>();
const synced = new Map<string, string>();

function mirrorToLedger(tasks: readonly VoiceTask[]): void {
  if (!ledgerSink) return;
  for (const task of tasks) {
    // Only a task with its request is worth remembering (a redo needs it); progress is written in steps of ten.
    if (!task.request) continue;
    // A request that looks private (a password, a card number) is never written to local storage: that task simply
    // cannot be redone after a restart.
    if (looksSensitive(task.request) || looksSensitive(task.label)) continue;
    const mark = `${task.state}|${Math.floor((task.percent ?? 0) / 10)}`;
    if (synced.get(task.id) === mark) continue;
    synced.set(task.id, mark);
    try {
      ledgerSink.syncVoiceTask({
        id: ledgerIds.get(task.id) ?? voiceLedgerId(task.createdAt, task.id),
        title: task.label,
        state: task.state,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        percent: task.percent,
        error: task.error ?? task.reason,
        spokenName: task.spoken,
        ordinal: task.ordinal,
        request: task.request,
      });
    } catch {
      /* the ledger is a copy: a write that fails must never stop a task */
    }
  }
  for (const id of synced.keys()) if (!tasks.some((t) => t.id === id)) synced.delete(id);
}

/** The work for a request that has no closure any more. The conductor knows how a request runs (the Brain turn). */
let workFactory: ((request: string) => TaskWork) | null = null;
export function attachVoiceTaskWork(factory: ((request: string) => TaskWork) | null): void {
  workFactory = factory;
}

/** The conductor's narrator: every update of every task goes here when one is attached (see narration-policy). */
export type TaskNarrator = (update: TaskUpdate, task: VoiceTask) => void;
let narrator: TaskNarrator | null = null;
/** While a "cancel everything" runs, the one summary line is spoken instead of one line per task. */
let hushCancels = false;
let focusTask = "";

/**
 * How many tasks run at once. The owner's `voice.tasks.maxParallel` is read and stored (so the setting and the panel
 * keep working), but it is NOT applied yet: every task runs a Brain turn, and the Brain has one lane, so a second
 * worker would only queue behind the first. The limit stays 1 until the Brain can run turns side by side.
 */
export const TASK_WORKER_LIMIT = 1;
/** The worker count a stored `maxParallel` gives today: always `TASK_WORKER_LIMIT`. */
export function taskWorkerLimit(prefs: Pick<TaskPrefs, "maxParallel">): number {
  void prefs.maxParallel; // read, deliberately not applied: see TASK_WORKER_LIMIT
  return TASK_WORKER_LIMIT;
}

const orchestrator: TaskOrchestrator = new TaskOrchestrator({
  maxWorkers: TASK_WORKER_LIMIT,
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

/**
 * A background task-graph outcome said by the same rules as a desk task: the conductor's narrator owns priority,
 * held lines, quiet hours, mute and sensitivity; without it the announcer holds the line until the voice is idle.
 * Returns true when the line was delivered or queued, false when no voice is attached, so the caller can keep the
 * graph unannounced.
 */
export function announceBackgroundTask(update: TaskUpdate, label: string): boolean {
  const now = Date.now();
  const state: VoiceTask["state"] =
    update.kind === "completed"
      ? "COMPLETED"
      : update.kind === "failed"
        ? "FAILED"
        : update.kind === "needs-approval"
          ? "WAITING_FOR_APPROVAL"
          : "RUNNING";
  const task: VoiceTask = {
    id: update.taskId,
    label,
    state,
    risk: "safe",
    createdAt: now,
    updatedAt: now,
    ...(update.kind === "failed" ? { error: update.text } : { result: update.text }),
  };
  if (narrator) {
    narrator(update, task);
    return true;
  }
  if (!speaker) return false;
  for (const line of announcer.offer(update, busyNow())) speaker(line.text);
  return true;
}

/** Call when the voice goes quiet: held updates are spoken in order. */
export function releaseTaskUpdates(): void {
  for (const line of announcer.release(busyNow())) speaker?.(line.text);
}

export function startVoiceTask(
  label: string,
  job: TaskWork,
  risk: TaskRisk = "safe",
  meta: { request?: string } = {},
): { ok: true; task: VoiceTask } | { ok: false; error: string } {
  const spoken = speakableLabel(label);
  const made = orchestrator.create({
    label,
    risk,
    payload: job,
    ...(meta.request ? { request: meta.request } : {}),
    ...(spoken ? { spoken } : {}),
  });
  refresh();
  return made;
}

/**
 * The tasks that were live when the app closed, read back from the ledger and put on the desk as INTERRUPTED (they
 * run nothing). The rows are marked "asked" so this happens once. Returns the desk tasks, oldest first, at most five.
 */
export function restoreInterruptedVoiceTasks(): VoiceTask[] {
  if (!ledgerSink) return [];
  const rows = ledgerSink.restartVoiceRows().slice(0, 5);
  if (!rows.length) return [];
  const made = orchestrator.restore(
    rows.map((row) => {
      const spoken = row.voice?.spokenName || speakableLabel(row.title);
      return {
        label: row.title,
        ...(row.voice?.request ? { request: row.voice.request } : {}),
        ...(spoken ? { spoken } : {}),
        createdAt: row.startedAt,
        reason: "FRIDAY was closed while it ran.",
      };
    }),
  );
  made.forEach((task, i) => {
    const row = rows[i];
    if (row) ledgerIds.set(task.id, row.id);
  });
  ledgerSink.markVoiceRows(
    rows.map((row) => row.id),
    "asked",
  );
  refresh();
  return made;
}

/** The ledger row an interrupted desk task came from, so an answer can close it. */
function closeRestored(id: string, redo: "redone" | "dropped"): void {
  const row = ledgerIds.get(id);
  if (row) ledgerSink?.markVoiceRows([row], redo);
  ledgerIds.delete(id);
}

/** Run these interrupted tasks again (the owner said redo). Returns how many started. */
export function redoInterruptedVoiceTasks(ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) if (voiceTaskActions.retry(id)) count += 1;
  return count;
}

/** The owner said no to redoing: the rows leave the desk and the ledger closes them. */
export function dropInterruptedVoiceTasks(ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) {
    const task = orchestrator.get(id);
    if (task?.state !== "INTERRUPTED") continue;
    closeRestored(id, "dropped");
    if (orchestrator.drop(id)) count += 1;
  }
  if (count) refresh();
  return count;
}

/**
 * True only for a request that asks to read or look something up and names no action. A conservative whitelist: it is
 * what lets a restart redo itself under Full autonomy, so anything unclear is not read-only.
 */
export function isReadOnlyRequest(request: string): boolean {
  const text = String(request ?? "")
    .normalize("NFC")
    .trim()
    .toLowerCase();
  if (!text || text.length > 300) return false;
  if (ACTION_WORDS.test(text)) return false;
  // "check the weather then ...": every step after a then, an also or a phir must itself start with a reading verb.
  return text.split(SECOND_STEP).every((step) => READ_START.test(step.trim()));
}

const ACTION_WORDS =
  /\b(send|delete|remove|erase|wipe|install|uninstall|open|launch|close|kill|run|execute|write|edit|create|make|save|move|rename|copy|paste|buy|order|pay|purchase|book|post|publish|upload|download|email|mail|message|text|call|restart|shut\s?down|reboot|log\s?in|sign\s?in|password|type|click|press|set|change|update|turn|enable|disable|schedule|remind|add|clear|reset|format|drop|push|commit|merge|deploy|reply|respond|forward|share|approve|transfer|cancel|accept|submit|sync|export|stop|start|play|bhejo|bhej|likho|likh|kar\s?do|karo|kholo|band|hatao|bana\s?do|chalao|rakh|bhijwa)\b/;
const SECOND_STEP = /\b(?:and then|then|after that|afterwards|also|next|phir|aur phir|uske baad)\b/;
const READ_START =
  /^(?:(?:and|please|friday|can you|could you)[,\s]+)*(?:summari[sz]e|summary of|read|find|search|look up|check|show|list|explain|tell me|what|who|when|where|why|how|compare|translate|count|calculate|define|describe)\b/;

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
  /** Run a FAILED or INTERRUPTED task again with its original request. False when it is neither, or has nothing to run. */
  retry: (id: string): boolean => {
    const old = orchestrator.get(id);
    if (!old) return false;
    const fallback = old.request && workFactory ? workFactory(old.request) : undefined;
    const done = orchestrator.retry(id, fallback);
    if (done) {
      closeRestored(id, "redone");
      refresh();
    }
    return done;
  },
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
    INTERRUPTED: "stopped when I closed",
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
    INTERRUPTED: "band hone par ruk gaya",
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
