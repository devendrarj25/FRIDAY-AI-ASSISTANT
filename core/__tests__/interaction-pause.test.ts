import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUSY_CLASS,
  installInteractionPause,
  isTypingTarget,
} from "../../src/lib/friday/interaction-pause";

function fake() {
  const classes = new Set<string>();
  const handlers = new Map<string, (e: Event) => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const env = {
    root: {
      classList: {
        add: (c: string) => void classes.add(c),
        remove: (c: string) => void classes.delete(c),
      },
    },
    target: {
      addEventListener: (t: string, fn: (e: Event) => void) => void handlers.set(t, fn),
      removeEventListener: (t: string) => void handlers.delete(t),
    },
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
  };
  return { env, classes, handlers, timers };
}

describe("interaction pause", () => {
  it("knows which targets are text entry", () => {
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("holds while typing, ignores other keys, and resumes by itself", () => {
    const f = fake();
    const off = installInteractionPause(f.env);
    f.handlers.get("keydown")?.({ target: { tagName: "BUTTON" } } as unknown as Event);
    expect(f.classes.has(BUSY_CLASS)).toBe(false);
    f.handlers.get("keydown")?.({ target: { tagName: "TEXTAREA" } } as unknown as Event);
    expect(f.classes.has(BUSY_CLASS)).toBe(true);
    f.handlers.get("keydown")?.({ target: { tagName: "TEXTAREA" } } as unknown as Event);
    expect(f.timers.size).toBe(1); // one timer, restarted
    [...f.timers.values()][0]?.fn();
    expect(f.classes.has(BUSY_CLASS)).toBe(false);
    off();
    expect(f.handlers.size).toBe(0);
  });

  it("holds while scrolling and cleans up on removal", () => {
    const f = fake();
    const off = installInteractionPause(f.env);
    f.handlers.get("scroll")?.({} as Event);
    expect(f.classes.has(BUSY_CLASS)).toBe(true);
    off();
    expect(f.classes.has(BUSY_CLASS)).toBe(false);
    expect(f.timers.size).toBe(0);
  });

  it("is wired in the shell and styled in the sheet", () => {
    const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
    expect(read("src/components/friday/AppShell.tsx")).toContain("installInteractionPause()");
    expect(read("src/styles.css")).toContain("html.friday-busy *");
  });
});
