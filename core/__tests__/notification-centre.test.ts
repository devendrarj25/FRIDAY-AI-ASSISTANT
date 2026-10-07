import { beforeEach, describe, expect, it } from "vitest";
import { notifications } from "../../src/lib/friday/notifications";

describe("FRIDAY notification centre", () => {
  beforeEach(() => {
    notifications.setEnabled(true);
    notifications.clear();
  });

  it("records an alert and counts it as unread", () => {
    notifications.push({ id: "a", level: "warn", title: "Python missing", source: "Doctor" });
    const state = notifications.getSnapshot();
    expect(state.items).toHaveLength(1);
    expect(state.unread).toBe(1);
  });

  it("never stacks the same unchanged condition twice", () => {
    notifications.push({ id: "a", level: "warn", title: "Python missing", source: "Doctor" });
    notifications.push({ id: "a", level: "warn", title: "Python missing", source: "Doctor" });
    expect(notifications.getSnapshot().items).toHaveLength(1);
  });

  it("refreshes an existing alert when its detail changes", () => {
    notifications.push({ id: "a", level: "warn", title: "Python", detail: "3.11", source: "D" });
    notifications.push({ id: "a", level: "error", title: "Python", detail: "gone", source: "D" });
    const items = notifications.getSnapshot().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toBe("gone");
  });

  it("marks all read and dismisses individually", () => {
    notifications.push({ id: "a", level: "info", title: "One", source: "Tasks" });
    notifications.push({ id: "b", level: "info", title: "Two", source: "Tasks" });
    notifications.markAllRead();
    expect(notifications.getSnapshot().unread).toBe(0);
    notifications.dismiss("a");
    expect(notifications.getSnapshot().items).toHaveLength(1);
  });

  it("records nothing while the owner has notifications paused", () => {
    notifications.setEnabled(false);
    notifications.push({ id: "a", level: "info", title: "One", source: "Tasks" });
    expect(notifications.getSnapshot().items).toHaveLength(0);
  });
});
