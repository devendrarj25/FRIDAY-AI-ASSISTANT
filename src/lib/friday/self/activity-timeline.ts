/**
 * FRIDAY · what was worked on, by day
 *
 * "What was I doing yesterday?" answered from records FRIDAY already keeps: the runs she did with the owner
 * (the task ledger) and the to-dos he finished. Nothing new is recorded for this: no screen capture, no key
 * log, no window titles. Because it only reads existing stores, clearing those clears this too. A run that
 * touched a credential-looking name is shown without the name.
 */

import type { TaskRecord } from "./task-ledger";

export type DayEntry = { at: number; kind: "run" | "todo"; text: string; failed?: boolean };
export type DayGroup = { day: string; label: string; entries: DayEntry[] };

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const SECRETISH = /password|passwd|secret|token|api[_-]?key|credential|\.env\b|id_rsa/i;
const clip = (text: string, n = 110) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const shown = (text: string) =>
  SECRETISH.test(text) ? "(a run that involved a credential — details hidden)" : clip(text);

export function dayLabel(key: string, now: number): string {
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86_400_000)) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

export function timeline(
  input: {
    runs: readonly Pick<TaskRecord, "title" | "status" | "startedAt" | "endedAt" | "tools">[];
    todos: readonly { title: string; doneAt: number | null }[];
  },
  now: number,
  days = 7,
): DayGroup[] {
  const since = now - days * 86_400_000;
  const entries: DayEntry[] = [];
  for (const run of input.runs) {
    const at = run.endedAt ?? run.startedAt;
    if (at < since || at > now) continue;
    if (run.status === "queued" || run.status === "running") continue;
    const failed = run.status === "failed" || run.status === "timeout";
    const tools = run.tools?.length ? ` [${run.tools.slice(0, 3).join(", ")}]` : "";
    entries.push({
      at,
      kind: "run",
      text: `${shown(run.title)}${tools}`,
      ...(failed ? { failed: true } : {}),
    });
  }
  for (const todo of input.todos) {
    if (todo.doneAt && todo.doneAt >= since && todo.doneAt <= now) {
      entries.push({ at: todo.doneAt, kind: "todo", text: `Finished: ${shown(todo.title)}` });
    }
  }
  const groups = new Map<string, DayEntry[]>();
  for (const entry of entries.sort((a, b) => b.at - a.at)) {
    const key = dayKey(entry.at);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups].map(([day, list]) => ({ day, label: dayLabel(day, now), entries: list }));
}
