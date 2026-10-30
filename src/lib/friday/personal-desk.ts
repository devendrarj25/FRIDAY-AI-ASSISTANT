/**
 * FRIDAY · personal desk (tasks, reminders, notes, activity summary)
 *
 * Tasks/reminders persist through the one persist.ts path. Notes are stored
 * in the existing memory engine (no second notes database). Summaries are
 * built from the task ledger, this desk and memory — never from invented days.
 */

import { readLocalState, restoreFromDisk, writeState } from "./persist";
import { memory } from "./self/memory-engine";
import { ledger } from "./self/task-ledger";
import { notifications } from "./notifications";
import { NOTE_TAG, SOCIAL_DRAFT_TAG, parseDueAt } from "./owner-work-logic";
import { considerLifeTrigger } from "./assistant-conduct";
import { autonomy } from "./self/autonomy";

export type DeskTask = {
  id: string;
  title: string;
  dueAt: number | null;
  done: boolean;
  createdAt: number;
  doneAt: number | null;
  remindedAt: number | null;
  /** Set once the heads-up before the due time has been shown. Older stored tasks have none. */
  warnedAt?: number | null;
};

/** How long before the due time the heads-up is shown. */
export const HEADS_UP_MS = 60 * 60_000;

/** Where a task stands against its deadline: nothing to say yet, a heads-up is due, or the time has come. */
export function deadlineStage(
  task: Pick<DeskTask, "done" | "dueAt" | "remindedAt" | "warnedAt">,
  now: number,
): "none" | "heads-up" | "due" {
  if (task.done || task.dueAt == null) return "none";
  if (task.dueAt <= now) return task.remindedAt ? "none" : "due";
  if (task.dueAt - now <= HEADS_UP_MS && !task.warnedAt) return "heads-up";
  return "none";
}

export type DeskState = {
  tasks: DeskTask[];
};

const STORAGE_KEY = "friday.personal-desk.v1";
let seq = 0;
const nextId = () => `desk-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

class PersonalDesk {
  private tasks: DeskTask[] = [];
  private loaded = false;
  private listeners = new Set<() => void>();
  private snapshot: DeskState = { tasks: [] };

  /** The page re-reads the list through useSyncExternalStore. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    const local = readLocalState<DeskState>(STORAGE_KEY);
    if (local?.tasks) this.tasks = local.tasks;
    this.refresh();
    restoreFromDisk<DeskState>(STORAGE_KEY, (disk) => {
      if (disk?.tasks?.length) {
        this.tasks = disk.tasks;
        this.refresh();
      }
    });
  }

  /** A new snapshot object only when the list changed, then tell the page. */
  private refresh() {
    this.snapshot = { tasks: [...this.tasks] };
    for (const listener of this.listeners) listener();
  }

  private emit() {
    this.refresh();
    if (typeof window === "undefined") return;
    writeState(STORAGE_KEY, { tasks: this.tasks } satisfies DeskState);
  }

  reset() {
    this.loaded = true;
    this.tasks = [];
    this.emit();
  }

  restore(state: DeskState) {
    this.loaded = true;
    this.tasks = Array.isArray(state.tasks) ? state.tasks : [];
    this.emit();
  }

  /** Stable between changes, so a subscribed component does not re-render for nothing. */
  getSnapshot(): DeskState {
    this.load();
    return this.snapshot;
  }

  /** Tick or untick one task by id (the page's checkbox). */
  toggle(id: string): DeskTask | null {
    this.load();
    const task = this.tasks.find((item) => item.id === id);
    if (!task) return null;
    task.done = !task.done;
    task.doneAt = task.done ? Date.now() : null;
    this.emit();
    return task;
  }

  /** Delete one task by id. */
  remove(id: string): boolean {
    this.load();
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((item) => item.id !== id);
    if (this.tasks.length === before) return false;
    this.emit();
    return true;
  }

  /** Delete every finished task. */
  clearDone(): number {
    this.load();
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((item) => !item.done);
    if (this.tasks.length !== before) this.emit();
    return before - this.tasks.length;
  }

  add(title: string, dueAt: number | null = null): DeskTask {
    this.load();
    const task: DeskTask = {
      id: nextId(),
      title: title.trim().slice(0, 200),
      dueAt,
      done: false,
      createdAt: Date.now(),
      doneAt: null,
      remindedAt: null,
    };
    this.tasks = [task, ...this.tasks];
    this.emit();
    return task;
  }

  complete(match: string): DeskTask | null {
    this.load();
    const want = match.trim().toLowerCase();
    const task = this.tasks.find((item) => !item.done && item.title.toLowerCase().includes(want));
    if (!task) return null;
    task.done = true;
    task.doneAt = Date.now();
    this.emit();
    return task;
  }

  list(opts: { includeDone?: boolean } = {}): DeskTask[] {
    this.load();
    return this.tasks.filter((task) => opts.includeDone || !task.done);
  }

  fireDueReminders(now = Date.now()): DeskTask[] {
    this.load();
    const snap = autonomy.getSnapshot();
    const gate = considerLifeTrigger({
      kind: "reminder",
      now,
      offeredAt: [],
      level: snap.approvalLevel,
      halted: snap.halted,
      solicited: true,
    });
    if (!gate.offer) return [];
    const soon = this.tasks.filter((task) => deadlineStage(task, now) === "heads-up");
    for (const task of soon) {
      task.warnedAt = now;
      const minutes = Math.max(1, Math.round(((task.dueAt ?? now) - now) / 60_000));
      notifications.push({
        id: `desk-headsup:${task.id}`,
        level: "info",
        title: `Coming up in ${minutes} min: ${task.title}`,
        detail: "A heads-up before the time you set. Nothing is done for you.",
        source: "Personal desk",
        route: "/chat",
      });
    }
    const due = this.tasks.filter((task) => deadlineStage(task, now) === "due");
    for (const task of due) {
      task.remindedAt = now;
      notifications.push({
        id: `desk-reminder:${task.id}`,
        level: "action",
        title: `Reminder: ${task.title}`,
        detail: "This is the time you asked me to remind you.",
        source: "Personal desk",
        route: "/chat",
      });
    }
    if (due.length || soon.length) this.emit();
    return due;
  }

  addNote(title: string, body: string) {
    return memory.remember({
      tier: "semantic",
      title: title.trim().slice(0, 80) || "Note",
      text: body.trim().slice(0, 4000),
      tags: [NOTE_TAG, "note"],
      source: "user",
      confidence: 1,
      pinned: false,
    });
  }

  findNotes(query: string) {
    return memory.retrieve(query, 8).filter((hit) => hit.item.tags.includes(NOTE_TAG));
  }

  listNotes() {
    return memory
      .getSnapshot()
      .items.filter((item) => item.tags.includes(NOTE_TAG) && item.tier !== "archived");
  }

  addSocialDraft(body: string) {
    return memory.remember({
      tier: "semantic",
      title: `Draft post: ${body.trim().slice(0, 40)}`,
      text: body.trim().slice(0, 4000),
      tags: [SOCIAL_DRAFT_TAG, "draft"],
      source: "user",
      confidence: 1,
      pinned: false,
    });
  }

  listSocialDrafts() {
    return memory
      .getSnapshot()
      .items.filter((item) => item.tags.includes(SOCIAL_DRAFT_TAG) && item.tier !== "archived");
  }

  /** Real activity only — empty windows stay empty. */
  summarise(range: "day" | "week", now = Date.now()): string {
    const since = now - (range === "day" ? 24 : 24 * 7) * 3600_000;
    const label = range === "day" ? "the last day" : "the last week";
    const lines: string[] = [];

    const mine = this.getSnapshot().tasks.filter(
      (task) => task.createdAt >= since || (task.doneAt ?? 0) >= since,
    );
    const opened = mine.filter((task) => task.createdAt >= since);
    const closed = mine.filter((task) => task.done && (task.doneAt ?? 0) >= since);
    const dueSoon = this.list().filter(
      (task) => task.dueAt && task.dueAt > now && task.dueAt <= now + 48 * 3600_000,
    );

    if (opened.length) lines.push(`${opened.length} task(s) you asked me to track.`);
    if (closed.length)
      lines.push(`${closed.length} marked done: ${closed.map((t) => t.title).join("; ")}.`);
    if (dueSoon.length) lines.push(`Coming up: ${dueSoon.map((t) => t.title).join("; ")}.`);

    const notes = this.listNotes().filter((item) => item.updatedAt >= since);
    if (notes.length) lines.push(`${notes.length} note(s) filed in memory.`);

    try {
      const runs = ledger.list().filter((task) => task.startedAt >= since);
      const done = runs.filter((task) => task.status === "done");
      const failed = runs.filter((task) => task.status === "failed");
      if (done.length) lines.push(`${done.length} FRIDAY run(s) finished.`);
      if (failed.length)
        lines.push(`${failed.length} run(s) failed: ${failed.map((t) => t.title).join("; ")}.`);
    } catch {
      /* ledger not hydrated */
    }

    if (!lines.length) {
      return `I have no recorded activity of yours or mine for ${label} — I will not invent a briefing.`;
    }
    return [`What actually happened in ${label}:`, ...lines.map((line) => `• ${line}`)].join("\n");
  }
}

export const personalDesk = new PersonalDesk();

export function parseTaskTitle(text: string): { title: string; dueAt: number | null } {
  const stripped = text
    .replace(/^(please\s+)?(remind me to|add (a |the )?task|todo|remember to)\s+/i, "")
    .replace(/\s+(by|before|at|on|in)\s+.+$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  return { title: stripped.slice(0, 200) || text.trim().slice(0, 200), dueAt: parseDueAt(text) };
}
