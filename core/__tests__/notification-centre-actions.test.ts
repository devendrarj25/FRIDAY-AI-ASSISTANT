import { beforeEach, describe, expect, it } from "vitest";
import { notifications } from "../../src/lib/friday/notifications";

/**
 * The notification centre is the one place every alert survives after its
 * corner popup fades: each entry knows where it came from, and can carry
 * FRIDAY's own explanation and fix instructions.
 */
describe("FRIDAY notification centre — routing and advice", () => {
  beforeEach(() => {
    notifications.setEnabled(true);
    notifications.clear();
  });

  it("keeps the route so the owner can jump to the source of an alert", () => {
    notifications.push({
      id: "doctor:python",
      level: "error",
      title: "Python missing",
      source: "Doctor",
      route: "/doctor",
    });
    expect(notifications.getSnapshot().items[0]?.route).toBe("/doctor");
  });

  it("stores FRIDAY's explanation on the alert", () => {
    notifications.push({ id: "a", level: "warn", title: "Kernel slow", source: "Kernel" });
    notifications.attachAdvice("a", "1. Restart the kernel\n2. Re-run Setup & Doctor");
    expect(notifications.getSnapshot().items[0]?.advice).toContain("Restart the kernel");
  });

  it("ignores empty advice and unknown ids", () => {
    notifications.push({ id: "a", level: "info", title: "One", source: "Tasks" });
    notifications.attachAdvice("a", "   ");
    notifications.attachAdvice("missing", "text");
    expect(notifications.getSnapshot().items[0]?.advice).toBeUndefined();
  });

  it("keeps an explanation when the same condition is re-published with new detail", () => {
    notifications.push({ id: "a", level: "warn", title: "Disk", detail: "80%", source: "Doctor" });
    notifications.attachAdvice("a", "Free up space");
    notifications.push({ id: "a", level: "error", title: "Disk", detail: "95%", source: "Doctor" });
    const item = notifications.getSnapshot().items[0];
    expect(item?.detail).toBe("95%");
    expect(item?.advice).toBe("Free up space");
  });
});
