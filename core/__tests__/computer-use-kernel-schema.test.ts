/**
 * The desktop loop sent `{target, text}` for every step, but the kernel reads `app` for a launch, `title` for a
 * focus, `keys` for a hotkey and `x,y,x2,y2` for a drag (kernel/tools.py). Each step is now shaped for the tool that
 * runs it, a click with nothing to click is refused before it reaches the mouse, and the loop's clock defaults to
 * the real clock so the 120 s time budget can trip.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  kernelArgsFor,
  planDesktop,
  runComputerUse,
  type DesktopAction,
  type DesktopPort,
  type Perception,
} from "../../src/lib/friday/self/computer-use";

const TOOLS_PY = readFileSync(resolve(__dirname, "../../kernel/tools.py"), "utf8");

/** The argument keys the kernel handler of one tool reads (`args.get("x")` and `args["x"]`). */
function kernelKeys(tool: string): Set<string> {
  const method = `_${tool.replace(".", "_")}`;
  const start = TOOLS_PY.indexOf(`async def ${method}(`);
  expect(start, `kernel handler ${method}`).toBeGreaterThan(-1);
  const rest = TOOLS_PY.slice(start + 10);
  const end = rest.search(/\n {4}(?:async )?def /);
  const body = rest.slice(0, end < 0 ? undefined : end);
  const keys = new Set<string>();
  for (const match of body.matchAll(/args(?:\.get\(|\[)"([a-zA-Z0-9_]+)"/g)) keys.add(match[1]!);
  return keys;
}

function stepFor(request: string): DesktopAction {
  const step = planDesktop(request).actions[0];
  expect(step, request).toBeTruthy();
  return step!;
}

describe("each desktop step is shaped for the kernel tool that runs it", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["launch notepad", { app: "notepad" }],
    ["focus Untitled - Notepad", { title: "Untitled - Notepad" }],
    ["close Untitled - Notepad", { title: "Untitled - Notepad" }],
    ["press ctrl+shift+s", { keys: ["ctrl", "shift", "s"] }],
    ["type hello world into Notepad", { text: "hello world", target: "Notepad" }],
    ["drag 10,20 to 300,400", { x: 10, y: 20, x2: 300, y2: 400 }],
    ["click Save", { target: "Save" }],
    ["copy some text", { text: "some text" }],
    ["read file notes/todo.txt", { path: "notes/todo.txt" }],
    ["write file notes/todo.txt buy milk", { path: "notes/todo.txt", content: "buy milk" }],
  ];
  for (const [request, expected] of cases) {
    it(`${request} -> ${JSON.stringify(expected)}`, () => {
      const step = stepFor(request);
      const shaped = kernelArgsFor(step);
      expect(shaped.ok, request).toBe(true);
      if (!shaped.ok) return;
      expect(shaped.args).toEqual(expected);
      const read = kernelKeys(step.tool);
      for (const key of Object.keys(shaped.args)) {
        expect(read.has(key), `${step.tool} reads "${key}"`).toBe(true);
      }
    });
  }

  it("refuses a click with no resolvable target", () => {
    for (const request of ["click it", "click that", "click there"]) {
      const shaped = kernelArgsFor(stepFor(request));
      expect(shaped.ok, request).toBe(false);
    }
  });

  it("refuses a drag without coordinates instead of dragging from the screen corner", () => {
    expect(kernelArgsFor(stepFor("drag the file to the folder")).ok).toBe(false);
  });

  it("does not move the mouse for an unresolvable click", async () => {
    const acted: string[] = [];
    const seen = (at: number): Perception => ({
      source: "uia",
      confidence: 0.9,
      freshAt: at,
      generation: 1,
      untrusted: true,
      dpi: 96,
      monitor: 1,
      windows: [],
      text: "",
    });
    const desktop: DesktopPort = {
      state: {
        monitors: [],
        windows: [],
        focusedId: null,
        clipboard: "",
        files: {},
        generation: 0,
        applied: [],
        writesInFlight: 0,
        maxWritesInFlight: 0,
        readsInFlight: 0,
        maxReadsInFlight: 0,
        slowHits: 0,
      },
      perceive: async (at) => seen(at),
      act: async (step) => {
        acted.push(step.kind);
        return { ok: true, detail: "done" };
      },
    };
    const report = await runComputerUse({
      request: "click it",
      source: "task",
      level: "full",
      halted: false,
      desktop,
    });
    expect(report.ok).toBe(false);
    expect(acted).toEqual([]);
  });
});

describe("the loop runs on the real clock unless a test injects one", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a slow desktop trips the 120 s budget under the default clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 0, 1, 12, 0, 0));
    const acted: string[] = [];
    let generation = 0;
    const desktop: DesktopPort = {
      state: {
        monitors: [],
        windows: [],
        focusedId: null,
        clipboard: "",
        files: {},
        generation: 0,
        applied: [],
        writesInFlight: 0,
        maxWritesInFlight: 0,
        readsInFlight: 0,
        maxReadsInFlight: 0,
        slowHits: 0,
      },
      // Every look at the screen takes 70 seconds of wall time.
      perceive: async (at) => {
        vi.setSystemTime(Date.now() + 70_000);
        return {
          source: "uia",
          confidence: 0.9,
          freshAt: at,
          generation,
          untrusted: true,
          dpi: 96,
          monitor: 1,
          windows: [{ id: "w1", title: "Notepad", focused: true }],
          text: "hello",
        } as unknown as Perception;
      },
      act: async (step) => {
        acted.push(step.kind);
        generation += 1;
        return { ok: true, detail: "done" };
      },
    };
    const report = await runComputerUse({
      request: "press ctrl+s then press ctrl+s then press ctrl+s",
      source: "task",
      level: "full",
      halted: false,
      desktop,
      budget: { timeMs: 120_000, maxSteps: 8, spend: 0, tokens: 0 },
      leaseExpiresAt: Date.now() + 3_600_000,
    });
    expect(report.stoppedReason).toMatch(/time|budget|ms|second/i);
    expect(acted.length).toBeLessThan(3);
  });
});
