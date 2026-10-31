import { describe, expect, it } from "vitest";
import { personalDesk } from "../../src/lib/friday/personal-desk";
import {
  adoptHorizonGoal,
  deadlineToDueAt,
  trackGoalDeadline,
} from "../../src/lib/friday/self/horizon-goals";

// Wednesday 2026-06-10 10:00 local time.
const WED = new Date(2026, 5, 10, 10, 0, 0).getTime();
const local = (y: number, m: number, d: number, h = 18) => new Date(y, m, d, h, 0, 0).getTime();

describe("deadlines written in a goal", () => {
  it("reads weekdays, end of day, tomorrow and a day with a month", () => {
    expect(deadlineToDueAt("by friday", WED)).toBe(local(2026, 5, 12));
    expect(deadlineToDueAt("by wednesday", WED)).toBe(local(2026, 5, 10));
    expect(deadlineToDueAt("by monday", WED)).toBe(local(2026, 5, 15));
    expect(deadlineToDueAt("by eod", WED)).toBe(local(2026, 5, 10));
    expect(deadlineToDueAt("by tomorrow", WED)).toBe(local(2026, 5, 11));
    expect(deadlineToDueAt("by 20 june", WED)).toBe(local(2026, 5, 20));
    expect(deadlineToDueAt("by 5 may", WED)).toBe(local(2027, 4, 5));
  });

  it("does not guess: a past end of day, a bad date or other words give nothing", () => {
    const evening = new Date(2026, 5, 10, 19, 0, 0).getTime();
    expect(deadlineToDueAt("by eod", evening)).toBeNull();
    expect(deadlineToDueAt("by wednesday", evening)).toBe(local(2026, 5, 17));
    expect(deadlineToDueAt("by 31 feb", WED)).toBeNull();
    expect(deadlineToDueAt("by someday", WED)).toBeNull();
    expect(deadlineToDueAt("", WED)).toBeNull();
  });

  it("puts a deadline from a goal on the desk once", () => {
    const goal = "Finish the tender draft by friday";
    const first = trackGoalDeadline(goal, WED);
    expect(first).toEqual({ tracked: true, dueAt: local(2026, 5, 12) });
    expect(personalDesk.list().some((t) => t.title === `Deadline: ${goal}`)).toBe(true);
    expect(trackGoalDeadline(goal, WED).tracked).toBe(false);
    expect(trackGoalDeadline("Tidy the shelves", WED)).toEqual({ tracked: false, dueAt: null });
  });

  it("is done when a horizon goal is adopted", () => {
    const goal = "Finish the audit report by tomorrow evening";
    const { id } = adoptHorizonGoal(goal);
    expect(id).toBeTruthy();
    expect(personalDesk.list().some((t) => t.title === `Deadline: ${goal}`)).toBe(true);
  });
});
