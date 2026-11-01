import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { personalDesk } from "../../src/lib/friday/personal-desk";

const require = createRequire(import.meta.url);
const engine = require("../../electron/reminder-engine.cjs") as {
  run: (input: Record<string, unknown>) => { ok: boolean; item?: { id: string } };
  pull: (root: string) => {
    ok: boolean;
    items: { id: string; text: string; dueAt: number | null }[];
  };
  load: (root: string) => { id: string; synced?: boolean; done?: boolean }[];
};

describe("reminders an agent tool wrote reach the personal desk", () => {
  let root = "";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-rem-"));
    personalDesk.reset();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("hands each reminder over once, and leaves done ones out", () => {
    const a = engine.run({ action: "add", text: "call the accountant in 2 hours", root });
    const b = engine.run({ action: "add", text: "send the invoice", root });
    engine.run({ action: "done", id: b.item!.id, root });
    const first = engine.pull(root);
    expect(first.items.map((item) => item.id)).toEqual([a.item!.id]);
    expect(first.items[0]?.dueAt).toBeGreaterThan(Date.now());
    expect(engine.pull(root).items).toEqual([]);
    expect(engine.load(root).find((item) => item.id === a.item!.id)?.synced).toBe(true);
  });

  it("the desk adds them as tasks that can fire, and does nothing without the desktop bridge", async () => {
    expect(await personalDesk.importToolReminders()).toBe(0);
    const due = Date.now() + 3_600_000;
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      addEventListener: () => undefined,
      friday: {
        pullReminders: async () => ({
          ok: true,
          items: [{ id: "rem-1", text: "pay GST", dueAt: due }],
        }),
      },
    };
    expect(await personalDesk.importToolReminders()).toBe(1);
    const task = personalDesk.list().find((item) => item.title === "pay GST");
    expect(task?.dueAt).toBe(due);
  });
});
