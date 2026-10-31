/**
 * FRIDAY · routines from habit
 *
 * When the owner asks for the same thing around the same hour on several different days, that is a routine. FRIDAY
 * notices it from the experience log and offers one reminder for the next usual time. It is a proposal: it goes
 * through governance and nothing is scheduled until the owner's dial lets it. Only the local log is read.
 */

import { experiences, type Experience } from "./task-ledger";
import { governance } from "./governance";
import { personalDesk } from "../personal-desk";

export type Routine = {
  id: string;
  title: string;
  hour: number;
  days: number;
  nextAt: number;
};

const DAY = 24 * 60 * 60 * 1000;
export const ROUTINE_MIN_DAYS = 3;
export const ROUTINE_WINDOW_DAYS = 21;

const normal = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 60);

function nextOccurrence(hour: number, now: number): number {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  return at.getTime() > now ? at.getTime() : at.getTime() + DAY;
}

/** Pure: titles asked on at least three different days, most of them within an hour of each other. */
export function routinesFrom(rows: readonly Experience[], now: number): Routine[] {
  const since = now - ROUTINE_WINDOW_DAYS * DAY;
  const groups = new Map<string, { title: string; stamps: number[] }>();
  for (const row of rows) {
    if (row.at < since || row.at > now || !row.success) continue;
    const key = normal(row.title);
    if (key.length < 6) continue;
    const group = groups.get(key) ?? { title: row.title, stamps: [] };
    group.stamps.push(row.at);
    groups.set(key, group);
  }
  const out: Routine[] = [];
  for (const [key, group] of groups) {
    const hours = group.stamps.map((stamp) => new Date(stamp).getHours());
    let best: { hour: number; days: Set<string> } | null = null;
    for (const centre of new Set(hours)) {
      const days = new Set<string>();
      group.stamps.forEach((stamp, index) => {
        const hour = hours[index] ?? 0;
        if (Math.abs(hour - centre) <= 1) days.add(new Date(stamp).toDateString());
      });
      if (!best || days.size > best.days.size) best = { hour: centre, days };
    }
    if (best && best.days.size >= ROUTINE_MIN_DAYS) {
      out.push({
        id: `routine-${key.replace(/ /g, "-").slice(0, 48)}`,
        title: group.title,
        hour: best.hour,
        days: best.days.size,
        nextAt: nextOccurrence(best.hour, now),
      });
    }
  }
  return out.sort((a, b) => b.days - a.days).slice(0, 3);
}

/** File each routine once for the owner's approval; applying it adds one reminder for the next usual time. */
export function fileRoutines(list: readonly Routine[]): number {
  let filed = 0;
  for (const routine of list) {
    if (governance.get(routine.id)) continue;
    filed += 1;
    void governance
      .submit({
        id: routine.id,
        kind: "research",
        title: `Routine: ${routine.title}`.slice(0, 100),
        rationale: `You asked for this on ${routine.days} different days, around ${routine.hour}:00. A reminder for the next usual time can be set.`,
        risk: "review",
        evidence: [`${routine.days} days`],
        dryRun: async () => ({ ok: true, detail: "one reminder will be added to your tasks" }),
        apply: async () => {
          personalDesk.add(`Usual: ${routine.title}`, routine.nextAt);
          return { ok: true, detail: "reminder added" };
        },
      })
      .catch(() => undefined);
  }
  return filed;
}

export function routinesNow(now = Date.now()): { found: number; filed: number } {
  const found = routinesFrom(experiences.list(500), now);
  return { found: found.length, filed: fileRoutines(found) };
}
