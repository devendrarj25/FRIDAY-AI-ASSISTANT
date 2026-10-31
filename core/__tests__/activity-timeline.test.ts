import { describe, expect, it } from "vitest";
import { timeline } from "../../src/lib/friday/self/activity-timeline";

const NOW = new Date(2026, 9, 31, 20, 0).getTime();
const at = (daysAgo: number, hour: number) => new Date(2026, 9, 31 - daysAgo, hour, 0).getTime();

describe("activity timeline", () => {
  const groups = timeline(
    {
      runs: [
        {
          title: "Summarise the vendor PDF",
          status: "done",
          startedAt: at(1, 11),
          tools: ["fs.extract"],
        },
        { title: "Fix the invoice sheet", status: "failed", startedAt: at(1, 15) },
        { title: "Read password manager export", status: "done", startedAt: at(0, 9) },
        { title: "Old thing", status: "done", startedAt: at(20, 9) },
        { title: "Still going", status: "running", startedAt: at(0, 19) },
      ],
      todos: [
        { title: "Call the bank", doneAt: at(1, 17) },
        { title: "Open one", doneAt: null },
      ],
    },
    NOW,
  );

  it("groups by day, newest first, with plain day names", () => {
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[1]?.entries.map((e) => e.text)).toEqual([
      "Finished: Call the bank",
      "Fix the invoice sheet",
      "Summarise the vendor PDF [fs.extract]",
    ]);
  });

  it("marks a failure and skips running, old and unfinished items", () => {
    expect(groups[1]?.entries.find((e) => /invoice/.test(e.text))?.failed).toBe(true);
    const all = JSON.stringify(groups);
    expect(all).not.toMatch(/Old thing|Still going|Open one/);
  });

  it("hides a run that involved a credential", () => {
    expect(JSON.stringify(groups)).not.toMatch(/password manager/);
    expect(groups[0]?.entries[0]?.text).toMatch(/credential/);
  });

  it("is empty when nothing was done", () => {
    expect(timeline({ runs: [], todos: [] }, NOW)).toEqual([]);
  });
});
