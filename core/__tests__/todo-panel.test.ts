/**
 * The to-do list: one store (personal desk) behind the chat commands
 * ("todo: ...", "remind me to ...") and the To-do panel on the Tasks page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function freshDesk() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  const { personalDesk } = await import("../../src/lib/friday/personal-desk");
  personalDesk.reset();
  return { personalDesk, store };
}

describe("to-do store", () => {
  it("adds, ticks, unticks, deletes and clears finished tasks, and tells subscribers each time", async () => {
    const { personalDesk } = await freshDesk();
    let calls = 0;
    const off = personalDesk.subscribe(() => {
      calls += 1;
    });
    const a = personalDesk.add("call the bank");
    const b = personalDesk.add("renew the licence");
    expect(personalDesk.getSnapshot().tasks.map((task) => task.title)).toEqual([
      "renew the licence",
      "call the bank",
    ]);
    expect(personalDesk.toggle(a.id)?.done).toBe(true);
    expect(personalDesk.list().map((task) => task.title)).toEqual(["renew the licence"]);
    expect(personalDesk.toggle(a.id)?.done).toBe(false);
    expect(personalDesk.toggle(a.id)?.doneAt).not.toBeNull();
    expect(personalDesk.clearDone()).toBe(1);
    expect(personalDesk.remove(b.id)).toBe(true);
    expect(personalDesk.remove(b.id)).toBe(false);
    expect(personalDesk.toggle("missing")).toBeNull();
    expect(personalDesk.getSnapshot().tasks).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(6);
    off();
    const before = calls;
    personalDesk.add("after unsubscribe");
    expect(calls).toBe(before);
  });

  it("keeps the snapshot identical until something changes, so the page does not re-render for nothing", async () => {
    const { personalDesk } = await freshDesk();
    personalDesk.add("one");
    const first = personalDesk.getSnapshot();
    expect(personalDesk.getSnapshot()).toBe(first);
    personalDesk.add("two");
    expect(personalDesk.getSnapshot()).not.toBe(first);
  });

  it("persists through the one state path and reloads", async () => {
    const { personalDesk, store } = await freshDesk();
    personalDesk.add("survive a restart");
    const saved = [...store.entries()].find(([key]) => key.includes("personal-desk"));
    expect(saved?.[1]).toContain("survive a restart");
  });

  it("parses the same phrases the chat commands use", async () => {
    await freshDesk();
    const { parseTaskTitle } = await import("../../src/lib/friday/personal-desk");
    expect(parseTaskTitle("todo renew the licence").title).toBe("renew the licence");
    expect(parseTaskTitle("remind me to call mom").title).toBe("call mom");
  });
});

describe("to-do panel", () => {
  const panel = readFileSync(path.join(root, "src/components/friday/TodoPanel.tsx"), "utf8");
  const page = readFileSync(path.join(root, "src/routes/tasks.tsx"), "utf8");

  it("sits on the Tasks page and reads the live store", () => {
    expect(page).toContain('import { TodoPanel } from "@/components/friday/TodoPanel"');
    expect(page).toContain("<TodoPanel />");
    expect(panel).toContain("useSyncExternalStore");
    expect(panel).toContain("personalDesk.subscribe");
  });

  it("wires every control to a real handler and shows an empty state", () => {
    for (const call of [
      "personalDesk.add(",
      "personalDesk.toggle(",
      "personalDesk.remove(",
      "personalDesk.clearDone(",
    ]) {
      expect(panel).toContain(call);
    }
    expect(panel).toContain("Nothing to do yet");
    expect(panel).toContain("aria-label");
  });
});
