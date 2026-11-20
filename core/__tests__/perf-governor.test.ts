/**
 * FRIDAY must stay smooth beside a game and on any PC, without a smaller workload:
 *  - decorative loops hold still while another window is in use (the occlusion check is off for the voice timers),
 *  - the page steps its decoration down only after it measured itself missing frames, and back up slowly,
 *  - the AI service runs below normal priority and the window above normal while it is in use,
 *  - the graphics state and the main loop's delay are reported, so "it lags" has a number behind it.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BAD_TO_STEP_DOWN,
  GOOD_TO_STEP_UP,
  MIN_FRAMES,
  UNFOCUSED_CLASS,
  createGovernor,
  installPerfGovernor,
  judgeSample,
} from "../../src/lib/friday/perf-governor";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const smooth = (n = 120) => Array.from({ length: n }, () => 16.7);
const choppy = (n = 120) => Array.from({ length: n }, (_, i) => (i % 5 === 0 ? 80 : 16.7));

describe("judging a frame sample", () => {
  it("calls smooth frames good, hitching frames bad, and too few frames idle", () => {
    expect(judgeSample({ frameMs: smooth(), longTaskMs: [] })).toBe("good");
    expect(judgeSample({ frameMs: choppy(), longTaskMs: [] })).toBe("bad");
    expect(judgeSample({ frameMs: smooth(MIN_FRAMES - 1), longTaskMs: [900] })).toBe("idle");
  });

  it("counts blocking tasks even when the frames look fine", () => {
    expect(judgeSample({ frameMs: smooth(), longTaskMs: [130, 150, 200] })).toBe("bad");
    expect(judgeSample({ frameMs: smooth(), longTaskMs: [450] })).toBe("bad");
    expect(judgeSample({ frameMs: smooth(), longTaskMs: [60, 90] })).toBe("good");
  });
});

describe("the quality tier", () => {
  it("steps down after repeated bad windows, one tier at a time, and never below lean", () => {
    const g = createGovernor();
    for (let i = 0; i < BAD_TO_STEP_DOWN - 1; i++) expect(g.push("bad")).toBe("full");
    expect(g.push("bad")).toBe("balanced");
    for (let i = 0; i < BAD_TO_STEP_DOWN; i++) g.push("bad");
    expect(g.tier()).toBe("lean");
    for (let i = 0; i < 10; i++) g.push("bad");
    expect(g.tier()).toBe("lean");
  });

  it("comes back only after a long smooth stretch, and a blip resets the count; idle changes nothing", () => {
    const g = createGovernor("lean");
    for (let i = 0; i < GOOD_TO_STEP_UP - 1; i++) g.push("good");
    g.push("bad");
    for (let i = 0; i < GOOD_TO_STEP_UP - 1; i++) g.push("good");
    expect(g.tier()).toBe("lean");
    expect(g.push("idle")).toBe("lean");
    expect(g.push("good")).toBe("balanced");
  });

  it("a PC that copes never leaves the full look", () => {
    const g = createGovernor();
    for (let i = 0; i < 50; i++) g.push(judgeSample({ frameMs: smooth(), longTaskMs: [] }));
    expect(g.tier()).toBe("full");
  });
});

describe("installing it in the page", () => {
  function fakeEnv() {
    const classes = new Set<string>();
    const state = { focused: true, visible: true };
    const listeners: Array<() => void> = [];
    let timer: (() => void) | null = null;
    let sample: number[] = smooth();
    let longs: ((ms: number) => void) | null = null;
    return {
      classes,
      state,
      env: {
        root: {
          classList: {
            add: (c: string) => void classes.add(c),
            remove: (c: string) => void classes.delete(c),
          },
          dataset: {} as Record<string, string | undefined>,
        },
        focused: () => state.focused,
        visible: () => state.visible,
        onFocusChange: (fn: () => void) => {
          listeners.push(fn);
          return () => undefined;
        },
        onLongTask: (fn: (ms: number) => void) => {
          longs = fn;
          return () => undefined;
        },
        sampleFrames: async () => sample,
        setTimer: (fn: () => void) => {
          timer = fn;
          return 1;
        },
        clearTimer: () => undefined,
      },
      focusChanged: () => listeners.forEach((fn) => fn()),
      tick: async () => {
        timer?.();
        await new Promise((r) => setTimeout(r, 0));
      },
      setSample: (frames: number[]) => (sample = frames),
      longTask: (ms: number) => longs?.(ms),
    };
  }

  it("holds the infinite decorative loops while another window is in use and releases them on return", () => {
    const f = fakeEnv();
    const off = installPerfGovernor(f.env);
    expect(f.classes.has(UNFOCUSED_CLASS)).toBe(false);
    f.state.focused = false;
    f.focusChanged();
    expect(f.classes.has(UNFOCUSED_CLASS)).toBe(true);
    f.state.focused = true;
    f.focusChanged();
    expect(f.classes.has(UNFOCUSED_CLASS)).toBe(false);
    off();
  });

  it("steps the decoration down after the page measures itself choppy, and restores everything when removed", async () => {
    const f = fakeEnv();
    const off = installPerfGovernor(f.env);
    f.setSample(choppy());
    for (let i = 0; i < BAD_TO_STEP_DOWN; i++) await f.tick();
    expect(f.classes.has("friday-perf-balanced")).toBe(true);
    off();
    expect(f.classes.has("friday-perf-balanced")).toBe(false);
  });

  it("does not measure a window nobody is looking at", async () => {
    const f = fakeEnv();
    installPerfGovernor(f.env);
    f.state.focused = false;
    f.setSample(choppy());
    for (let i = 0; i < 6; i++) await f.tick();
    expect(f.classes.has("friday-perf-balanced")).toBe(false);
  });
});

describe("the style rules", () => {
  const css = read("src/styles.css");

  it("pauses only loops that never end when another window is in use, so a reveal is never left half-drawn", () => {
    const block = css.slice(css.indexOf("html.friday-unfocused body::before"));
    expect(block).toContain(".orb-halo");
    expect(block).toContain(".animate-spin");
    expect(css).not.toMatch(/html\.friday-unfocused \*[,\s{]/);
  });

  it("only steps the decoration down under the tier classes, and keeps spinners alive", () => {
    expect(css).toContain("html.friday-perf-balanced body::before");
    expect(css).toContain("html.friday-perf-lean *:not(.animate-spin)");
    expect(read("src/components/friday/AppShell.tsx")).toContain("installPerfGovernor()");
  });
});

describe("process priority", () => {
  const prio = require_("../../electron/process-priority.cjs") as {
    createPriorityManager: (o: Record<string, unknown>) => {
      enabled: boolean;
      lowerKernel: (pid: number) => boolean;
      setUiFocus: (f: boolean) => boolean;
    };
    uiPids: (m: unknown, own?: number) => number[];
  };
  const fakeOs = (calls: Array<[number, number]>, fail = false) => ({
    constants: {
      priority: { PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7 },
    },
    setPriority: (pid: number, level: number) => {
      if (fail) throw new Error("access denied");
      calls.push([pid, level]);
    },
  });
  const metrics = [
    { pid: 11, type: "Browser" },
    { pid: 12, type: "GPU" },
    { pid: 13, type: "Tab" },
    { pid: 14, type: "Utility" },
  ];

  it("runs the AI service below normal and the window above normal only while it is in use (Windows)", () => {
    const calls: Array<[number, number]> = [];
    const m = prio.createPriorityManager({
      osModule: fakeOs(calls),
      platform: "win32",
      env: {},
      getMetrics: () => metrics,
    });
    expect(m.lowerKernel(99)).toBe(true);
    expect(calls).toContainEqual([99, 10]);
    m.setUiFocus(true);
    for (const pid of [11, 12, 13]) expect(calls).toContainEqual([pid, -7]);
    expect(calls.some(([pid]) => pid === 14)).toBe(false);
    calls.length = 0;
    m.setUiFocus(false);
    for (const pid of [11, 12, 13]) expect(calls).toContainEqual([pid, 0]);
  });

  it("does nothing off Windows or when FRIDAY_PRIORITY=0, and survives a refused call", () => {
    const calls: Array<[number, number]> = [];
    const linux = prio.createPriorityManager({
      osModule: fakeOs(calls),
      platform: "linux",
      env: {},
    });
    expect(linux.lowerKernel(1)).toBe(false);
    const off = prio.createPriorityManager({
      osModule: fakeOs(calls),
      platform: "win32",
      env: { FRIDAY_PRIORITY: "0" },
    });
    expect(off.lowerKernel(1)).toBe(false);
    expect(calls).toEqual([]);
    const denied = prio.createPriorityManager({
      osModule: fakeOs([], true),
      platform: "win32",
      env: {},
      getMetrics: () => metrics,
    });
    expect(denied.lowerKernel(5)).toBe(false);
    expect(denied.setUiFocus(true)).toBe(false);
  });

  it("is wired: kernel lowered after it starts, window focus raises it, nothing else is touched", () => {
    const main = read("electron/main.cjs");
    expect(main).toContain("priority.lowerKernel(kernel.pid)");
    expect(main).toContain('win.on("focus", () => priority.setUiFocus(true))');
    expect(main).toContain('win.on("blur", () => priority.setUiFocus(false))');
    expect(prio.uiPids(metrics, 7).sort((a, b) => a - b)).toEqual([7, 11, 12, 13]);
  });
});

describe("graphics state and loop delay", () => {
  const gpu = require_("../../electron/gpu-status.cjs") as {
    summarizeGpu: (
      s: unknown,
      o?: { softwareMode?: boolean },
    ) => { accelerated: boolean | null; text: string };
  };
  const lag = require_("../../electron/loop-lag.cjs") as {
    createLoopLag: (o: Record<string, unknown>) => {
      start: (ms?: number) => boolean;
      read: () => { p99Ms: number; maxMs: number };
      stop: () => void;
    };
  };

  it("says in plain words whether the card draws the window, and why not", () => {
    const on = gpu.summarizeGpu({ gpu_compositing: "enabled_on", rasterization: "enabled_on" });
    expect(on.accelerated).toBe(true);
    expect(on.text).toContain("card in use");
    const soft = gpu.summarizeGpu({ gpu_compositing: "disabled_software" });
    expect(soft.accelerated).toBe(false);
    expect(soft.text).toContain("software");
    expect(gpu.summarizeGpu({}, { softwareMode: true }).text).toContain("FRIDAY_FORCE_GPU=1");
    expect(gpu.summarizeGpu(null).accelerated).toBeNull();
    expect(read("electron/main.cjs")).toContain("gpuStatus.summarizeGpu(app.getGPUFeatureStatus()");
  });

  it("reports the main loop's delay in milliseconds and is published with the system metrics", () => {
    const histogram = {
      enable: () => undefined,
      disable: () => undefined,
      reset: () => undefined,
      percentile: () => 180e6,
      max: 400e6,
    };
    const l = lag.createLoopLag({ perfHooks: { monitorEventLoopDelay: () => histogram } });
    expect(l.read()).toEqual({ p99Ms: 0, maxMs: 0 });
    expect(l.start(1_000_000)).toBe(true);
    expect(l.read()).toEqual({ p99Ms: 180, maxMs: 400 });
    l.stop();
    expect(read("electron/system-monitor.cjs")).toContain("loopLagP99Ms");
  });
});
