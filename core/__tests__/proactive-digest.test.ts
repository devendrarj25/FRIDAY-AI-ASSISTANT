import { beforeEach, describe, expect, it } from "vitest";
import { notifications } from "../../src/lib/friday/notifications";
import { personalDesk } from "../../src/lib/friday/personal-desk";
import {
  buildDigest,
  deliverDigest,
  resetDigestForTests,
  slotKey,
} from "../../src/lib/friday/proactive-digest";
import { autonomy } from "../../src/lib/friday/self/autonomy";

const at = (h: number, day = 10) => new Date(2026, 5, day, h, 0, 0).getTime();

describe("the digest text", () => {
  it("says what needs the owner and nothing else", () => {
    const now = at(8);
    const out = buildDigest({
      now,
      tasks: [
        { title: "file GST", dueAt: now - 1000, done: false },
        { title: "call CA", dueAt: now + 3 * 3_600_000, done: false },
        { title: "old", dueAt: now - 5000, done: true },
        { title: "no time", dueAt: null, done: false },
      ],
      pendingApprovals: 2,
      failedRuns: ["Build docs"],
      unreadAlerts: 4,
    });
    expect(out.quiet).toBe(false);
    expect(out.lines).toEqual([
      "Overdue: file GST.",
      "Due in the next day: call CA.",
      "2 proposal(s) are waiting for your approval.",
      "1 run(s) failed since yesterday: Build docs.",
      "4 alert(s) you have not opened.",
    ]);
    expect(
      buildDigest({ now, tasks: [], pendingApprovals: 0, failedRuns: [], unreadAlerts: 0 }),
    ).toEqual({
      lines: [],
      quiet: true,
    });
  });

  it("names a brief slot once a day and none in the small hours or midday", () => {
    expect(slotKey(at(8))).toBe("2026-06-10:morning");
    expect(slotKey(at(19))).toBe("2026-06-10:evening");
    expect(slotKey(at(2))).toBeNull();
    expect(slotKey(at(13))).toBeNull();
  });
});

describe("delivering the digest", () => {
  beforeEach(() => {
    resetDigestForTests();
    autonomy.update({ halted: false, approvalLevel: "balanced" });
  });

  it("offers it once per slot through the notification centre", () => {
    personalDesk.add("digest-test-task", at(9, 11));
    const first = deliverDigest(at(8, 12));
    expect(first).toMatchObject({ delivered: true });
    expect(
      notifications.getSnapshot().items.some((n) => n.id === "digest:2026-06-12:morning"),
    ).toBe(true);
    expect(deliverDigest(at(9, 12))).toEqual({
      delivered: false,
      reason: "already offered this slot",
    });
  });

  it("is held back by Stop everything, Ask every time and outside the brief hours", () => {
    personalDesk.add("digest-held-task", at(9, 14));
    autonomy.update({ halted: true });
    expect(deliverDigest(at(8, 13))).toMatchObject({ delivered: false, reason: "halted" });
    autonomy.update({ halted: false, approvalLevel: "strict" });
    expect(deliverDigest(at(8, 15))).toMatchObject({ delivered: false, reason: "ask" });
    autonomy.update({ approvalLevel: "balanced" });
    expect(deliverDigest(at(13, 16))).toEqual({ delivered: false, reason: "not a brief slot" });
  });
});
