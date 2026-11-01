import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backgroundTasks } from "../../src/lib/friday/self/background-tasks";

describe("jobs the owner counts on are not held back", () => {
  beforeEach(() => {
    (globalThis as unknown as { document: unknown }).document = {
      hidden: true,
      hasFocus: () => false,
      fullscreenElement: null,
      addEventListener: () => undefined,
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  it("an always job runs while the window is hidden and while another job is running; a normal job does not", async () => {
    const ran: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    backgroundTasks.register({
      id: "t-slow",
      label: "Slow job",
      everyMinutes: 0,
      run: async () => {
        ran.push("slow-start");
        await gate;
        ran.push("slow-end");
        return "done";
      },
    });
    backgroundTasks.register({
      id: "t-always",
      label: "Reminder-like job",
      everyMinutes: 0,
      always: true,
      run: async () => {
        ran.push("always");
        return "ok";
      },
    });
    // Hidden window: only the always job runs.
    await backgroundTasks.tick();
    expect(ran).toEqual(["always"]);

    // A visible window starts the slow job; the always job still runs at its next tick, not behind it.
    (globalThis as unknown as { document: { hidden: boolean } }).document.hidden = false;
    backgroundTasks.setEnabled("desk-reminders", false);
    for (const job of backgroundTasks.getSnapshot().jobs) {
      if (job.id !== "t-slow" && job.id !== "t-always") backgroundTasks.setEnabled(job.id, false);
    }
    const slow = backgroundTasks.tick();
    await Promise.resolve();
    await backgroundTasks.tick();
    expect(ran.filter((entry) => entry === "always").length).toBeGreaterThanOrEqual(2);
    release();
    await slow;
    expect(ran).toContain("slow-end");
    expect(backgroundTasks.getSnapshot().runs.some((run) => run.job === "Reminder-like job")).toBe(
      true,
    );
  });
});
