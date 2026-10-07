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

export type DeskTask = {
  id: string;
  title: string;
  dueAt: number | null;
  done: boolean;
  createdAt: number;
  doneAt: number | null;
  remindedAt: number | null;
};

export type DeskState = {
  tasks: DeskTask[];
};

const STORAGE_KEY = "friday.personal-desk.v1";
let seq = 0;
const nextId = () => `desk-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

class PersonalDesk {
  private tasks: DeskTask[] = [];
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    const local = readLocalState<DeskState>(STORAGE_KEY);
    if (local?.tasks) this.tasks = local.tasks;
    restoreFromDisk<DeskState>(STORAGE_KEY, (disk) => {
      if (disk?.tasks?.length) this.tasks = disk.tasks;
    });
  }

  private emit() {
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

  getSnapshot(): DeskState {
    this.load();
    return { tasks: [...this.tasks] };
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
    const due = this.tasks.filter(
      (task) => !task.done && task.dueAt != null && task.dueAt <= now && !task.remindedAt,
    );
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
    if (due.length) this.emit();
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
