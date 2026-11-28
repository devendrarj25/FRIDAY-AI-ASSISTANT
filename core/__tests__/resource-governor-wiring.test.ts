import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resourceRows, type ResourceView } from "../../src/lib/friday/voice-diagnostics-rows";
import type { GovernorStatus } from "../../src/lib/friday/desktop";

const require_ = createRequire(import.meta.url);
const root = path.join(__dirname, "..", "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const { watchWindowHang } = require_("../../electron/window-hang.cjs") as {
  watchWindowHang: (win: unknown, options: Record<string, unknown>) => () => void;
};
const governorApi = require_("../../electron/resource-governor.cjs") as {
  createIdleTracker: (o: Record<string, unknown>) => { observe: (m: unknown[]) => string[] };
  createResourceGovernor: (o: Record<string, unknown>) => {
    note: (k: string, d: string) => void;
    status: () => { actions: Array<{ kind: string; detail: string }> };
    tick: () => Promise<void>;
    onLag: (w: { p99Ms: number; maxMs: number }) => Promise<void>;
  };
};

afterEach(() => vi.useRealTimers());

describe("the unresponsive recovery sequence (fake clock)", () => {
  function rig(response = 0) {
    const clock = { t: 0 };
    const win = Object.assign(new EventEmitter(), {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      webContents: { reloadIgnoringCache: vi.fn() },
    });
    const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
    let abortPrompt: (() => void) | null = null;
    const dialog = {
      showMessageBox: vi.fn(
        (_w: unknown, options: { signal?: AbortSignal }) =>
          new Promise<{ response: number }>((resolve) => {
            if (response >= 0) {
              resolve({ response });
              return;
            }
            options.signal?.addEventListener("abort", () => resolve({ response: 0 }), {
              once: true,
            });
            abortPrompt = () => undefined;
          }),
      ),
    };
    const log = vi.fn();
    const onPersist = vi.fn();
    watchWindowHang(win, {
      dialog,
      log,
      onPersist,
      persistMs: 4_000,
      delayMs: 8_000,
      askAgainMs: 30_000,
      autoReloadMs: 90_000,
      autoReloadCooldownMs: 600_000,
      now: () => clock.t,
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, at: clock.t + ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t: { live: boolean }) => {
        t.live = false;
      },
    });
    /** Move the clock and run every live timer that came due, in time order. */
    const advance = async (ms: number) => {
      const target = clock.t + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.t = due.at;
        due.live = false;
        due.fn();
        await new Promise((r) => setImmediate(r));
      }
      clock.t = target;
    };
    void abortPrompt;
    return { win, dialog, log, onPersist, advance };
  }

  it("notice at 4 s, prompt at 8 s, one automatic reload at 90 s", async () => {
    const r = rig(-1); // nobody answers the prompt
    r.win.emit("unresponsive");
    await r.advance(3_000);
    expect(r.onPersist).not.toHaveBeenCalled();
    await r.advance(1_500);
    expect(r.onPersist).toHaveBeenCalledTimes(1);
    expect(r.onPersist).toHaveBeenCalledWith(90_000);
    expect(r.dialog.showMessageBox).not.toHaveBeenCalled();
    await r.advance(4_000);
    expect(r.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(r.win.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    await r.advance(90_000);
    expect(r.win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
  });

  it("a page that answers again cancels the notice and the reload", async () => {
    const r = rig(0);
    r.win.emit("unresponsive");
    await r.advance(2_000);
    r.win.emit("responsive");
    await r.advance(200_000);
    expect(r.onPersist).not.toHaveBeenCalled();
    expect(r.win.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    expect(r.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("waiting at the prompt does not stop the one automatic reload", async () => {
    const r = rig(0); // the owner keeps choosing Wait
    r.win.emit("unresponsive");
    await r.advance(120_000);
    expect(r.win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
  });

  it("reloads on its own at most once per cooldown, so a page that hangs again is not looped", async () => {
    const r = rig(0);
    r.win.emit("unresponsive");
    await r.advance(95_000);
    expect(r.win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    r.win.emit("unresponsive");
    await r.advance(95_000);
    expect(r.win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    await r.advance(700_000);
    r.win.emit("responsive");
    r.win.emit("unresponsive");
    await r.advance(95_000);
    expect(r.win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(2);
  });

  it("a destroyed window is left alone", async () => {
    const r = rig(0);
    r.win.emit("unresponsive");
    r.win.destroyed = true;
    await r.advance(200_000);
    expect(r.onPersist).not.toHaveBeenCalled();
    expect(r.win.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
  });
});

describe("the idle model tracker", () => {
  it("calls a model idle only when its expiry stamp has not moved for the idle time", () => {
    const clock = { t: 0 };
    const tracker = governorApi.createIdleTracker({ now: () => clock.t, minIdleMs: 45_000 });
    const m = (stamp: string) => [{ id: "qwen3:4b", expiresAt: stamp }];
    expect(tracker.observe(m("a"))).toEqual([]);
    clock.t = 50_000;
    expect(tracker.observe(m("a"))).toEqual(["qwen3:4b"]);
    clock.t = 60_000;
    expect(tracker.observe(m("b"))).toEqual([]); // it was used: the stamp moved
    clock.t = 70_000;
    expect(tracker.observe([])).toEqual([]); // unloaded: forgotten
    clock.t = 200_000;
    expect(tracker.observe(m("b"))).toEqual([]); // seen anew
  });

  it("is what the governor asks first: pending, then a real unload", async () => {
    const clock = { t: 0 };
    const tracker = governorApi.createIdleTracker({ now: () => clock.t, minIdleMs: 45_000 });
    const unload = vi.fn();
    const g = governorApi.createResourceGovernor({
      now: () => clock.t,
      readMemory: () => ({ freeMb: 2_000, totalMb: 16_384 }),
      unloadEveryMs: 60_000,
      actions: {
        unloadIdleModels: async () => {
          const idle = tracker.observe([{ id: "m", expiresAt: "x" }]);
          idle.forEach((id) => unload(id));
          return idle.length ? true : "pending";
        },
      },
    });
    await g.tick(); // first look: pending
    expect(unload).not.toHaveBeenCalled();
    clock.t += 16_000; // the retry comes after 15 s, not 60 s: second look, still not idle long enough
    await g.tick();
    expect(unload).not.toHaveBeenCalled();
    clock.t += 31_000; // third look: the stamp has not moved for 47 s
    await g.tick();
    expect(unload).toHaveBeenCalledWith("m");
  });

  it("note() records a diagnostics row from outside and the ring stays bounded", () => {
    const g = governorApi.createResourceGovernor({});
    for (let i = 0; i < 40; i += 1) g.note("window", `hang ${i}`);
    const rows = g.status().actions;
    expect(rows.length).toBeLessThanOrEqual(12);
    expect(rows.at(-1)).toMatchObject({ kind: "window", detail: "hang 39" });
  });
});

describe("loop-lag hands each window to the governor", () => {
  it("calls onWindow with the p99 and max, never lets a throwing listener stop it", () => {
    vi.useFakeTimers();
    const lag = require_("../../electron/loop-lag.cjs") as {
      createLoopLag: (o: Record<string, unknown>) => {
        start: (ms?: number) => boolean;
        stop: () => void;
      };
    };
    const histogram = {
      enable: () => undefined,
      disable: () => undefined,
      reset: () => undefined,
      percentile: () => 300e6,
      max: 900e6,
    };
    const onWindow = vi.fn(() => {
      throw new Error("listener bug");
    });
    const l = lag.createLoopLag({
      perfHooks: { monitorEventLoopDelay: () => histogram },
      onWindow,
    });
    expect(l.start(10_000)).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(onWindow).toHaveBeenCalledTimes(2);
    expect(onWindow).toHaveBeenCalledWith({ p99Ms: 300, maxMs: 900 });
    l.stop();
  });
});

describe("main process wiring (source pins)", () => {
  const main = read("electron/main.cjs");

  it("builds one governor from the real readers and rides the loop-lag window, not a new timer", () => {
    expect(main).toContain('require("./resource-governor.cjs")');
    expect(main).toMatch(/createLoopLag\(\{[^}]*onWindow: \(window\) => governorWindow\(window\)/s);
    expect(main).toMatch(
      /function governorWindow\(window\) \{[\s\S]*?governor\s*\.onLag\(window\)\s*\.then\(\(\) => governor\.tick\(\)\)/,
    );
    expect(main).toContain("systemMonitor.cachedVram()");
    expect(main).toContain("stt.releaseIdle(60_000)");
    expect(main).toContain("modelsApi.ollamaUnload(id)");
    // the governor block adds no timer of its own
    const start = main.indexOf(
      "// ------------------------------------------------ resource governor ---",
    );
    const end = main.indexOf('ipcMain.handle("governor:status"');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(main.slice(start, end)).not.toMatch(/setInterval\s*\(|setTimeout\s*\(/);
  });

  it("the pressure unload is not gated on a held speech lease and compares the real Ollama tag", () => {
    // The speech worker keeps its lease for as long as it lives, so a kind-based gate would never let it close.
    expect(main).toMatch(/unloadSpeech:\s*async \(\) => stt\.releaseIdle\(60_000\)/);
    expect(main).not.toMatch(/busyKinds\.includes\("speech"\)/);
    expect(main).toMatch(/governorApi\.unloadIdleOllama\(\{[\s\S]*?busyOwners,/);
    // A chat lease is owned as `chat:<Ollama tag>`, the id Ollama lists, so the busy filter matches.
    expect(main).toMatch(
      /owner: `chat:\$\{\s*model\.meta\?\.providerId === "ollama" && model\.meta\?\.modelName\s*\? model\.meta\.modelName\s*: model\.id\s*\}`/,
    );
  });

  it("serves one read-only governor:status IPC, allowlisted, budgeted and typed", () => {
    expect(main).toContain('ipcMain.handle("governor:status"');
    expect(read("electron/preload.cjs")).toContain(
      'governorStatus: () => ipcRenderer.invoke("governor:status")',
    );
    expect(read("electron/preload.cjs")).toContain('onGovernorNotice: on("governor:notice")');
    expect(read("electron/ipc-budget-table.cjs")).toContain('"governor:status": "quick"');
    const desktop = read("src/lib/friday/desktop.ts");
    expect(desktop).toContain("governorStatus?: () => Promise<GovernorStatus>;");
    expect(desktop).toContain("onGovernorNotice?:");
  });

  it("puts model pulls inside the download cap and clamps the renderer's concurrency", () => {
    expect(main).toMatch(/cappedJob\(\s*"download"/);
    expect(main).toContain("Math.min(Number(payload?.concurrency) || 2, DOWNLOAD_CONCURRENCY_MAX)");
    // the cap helper falls back to a plain call when the governor could not start
    expect(main).toMatch(
      /function cappedJob\(cls, fn, signal, onWaiting\) \{\s*if \(!governor\) return fn\(\);/,
    );
  });

  it("watches the main window for a stuck page with a native notice and one automatic reload", () => {
    expect(main).toMatch(
      /watchWindowHang\(win, \{[\s\S]*?onPersist: \(autoMs\) => notifyWindowStuck\(autoMs\),\s*autoReloadMs: 90_000,/,
    );
    expect(main).toContain('governor?.note("render-process-gone"');
    expect(main).toMatch(/governor\?\.note\(\s*"child-process-gone"/);
    expect(main).toMatch(/if \(governor && !governor\.allowsPrefetch\(\)\) return;/);
  });

  it("shares the video memory reading and the speech release instead of probing again", () => {
    const monitor = read("electron/system-monitor.cjs");
    expect(monitor).toContain("function cachedVram()");
    expect(monitor).toMatch(/async function refreshVram\(\) \{\s*await gpuSample\(\);/);
    const stt = read("electron/stt.cjs");
    expect(stt).toMatch(
      /function releaseIdle\(minIdleMs = 60_000, session = worker\) \{[\s\S]*?session\.pending\.size > 0/,
    );
    expect(stt).toContain("session.lastUsedAt = Date.now();");
  });

  it("the renderer shows the governor's one-line notice as a toast", () => {
    const pressure = read("src/lib/friday/system-pressure.ts");
    expect(pressure).toContain("desktop.onGovernorNotice");
    expect(pressure).toContain("toast.warning(notice.line)");
  });
});

describe("the Resources rows of the diagnostics", () => {
  const status: GovernorStatus = {
    ok: true,
    level: "high",
    notice: null,
    memory: { freeMb: 2048, totalMb: 16384, level: "high" },
    vram: { freeMb: 5120, totalMb: 6144, level: "ok" },
    lag: { p99Ms: 40, maxMs: 90, paused: false },
    power: { stress: "battery", preferSmall: true },
    holds: ["pressure"],
    leases: [
      {
        id: "l1",
        owner: "qwen3:4b",
        kind: "llm",
        priority: "chat",
        state: "active",
        vramMb: 3000,
        ramMb: 0,
        ageMs: 5,
      },
    ],
    queued: [{ owner: "flux", priority: "background", reason: "deferred: pressure" }],
    jobs: {
      download: { running: 2, queued: 1, cap: 2, maxQueue: 32, saturated: false },
      install: { running: 0, queued: 0, cap: 1, maxQueue: 8, saturated: false },
    },
    actions: [{ at: 1, kind: "unload-idle", detail: "high; models:freed" }],
  };

  it("shows loading, offline and error on every row, with Retry wording", () => {
    for (const view of [
      { phase: "loading" },
      { phase: "offline" },
      { phase: "error", message: "boom" },
    ] as ResourceView[]) {
      const rows = resourceRows(view);
      expect(rows).toHaveLength(7);
      expect(new Set(rows.map((r) => r.value)).size).toBe(1);
    }
    expect(resourceRows({ phase: "error", message: "boom" })[0]).toMatchObject({ bad: true });
    expect(resourceRows({ phase: "error", message: "" })[0]?.value).toContain("refresh resources");
  });

  it("reads the real figures, flags what is under pressure, and says when nothing was measured", () => {
    const rows = Object.fromEntries(
      resourceRows({ phase: "ready", status }).map((r) => [r.label, r]),
    );
    expect(rows["resources: memory (free · level)"]).toMatchObject({
      value: "2 GB of 16 GB · high",
      bad: true,
    });
    expect(rows["resources: video memory (free · level)"]?.bad).toBeUndefined();
    expect(rows["resources: leases held"]?.value).toContain("qwen3:4b (chat, active)");
    expect(rows["resources: leases held"]?.value).toContain("1 waiting");
    expect(rows["resources: jobs (running/cap · waiting)"]?.value).toContain(
      "download 2/2 · 1 waiting",
    );
    expect(rows["resources: power"]?.value).toContain("on battery");
    expect(rows["resources: last action"]?.value).toBe("unload-idle: high; models:freed");
    const bare = resourceRows({
      phase: "ready",
      status: {
        ...status,
        memory: null,
        vram: null,
        leases: [],
        queued: [],
        actions: [],
        lag: { p99Ms: 400, maxMs: 900, paused: true },
      },
    });
    expect(bare[0]?.value).toBe("not measured");
    expect(bare[1]?.value).toContain("not measured");
    expect(bare[2]?.value).toBe("none held");
    expect(bare[4]).toMatchObject({ bad: true });
    expect(bare[4]?.value).toContain("paused");
    expect(bare[6]?.value).toBe("nothing yet");
  });

  it("is wired to the diagnostics page with its own refresh control", () => {
    const page = read("src/components/friday/VoiceDiagnostics.tsx");
    expect(page).toContain("...resourceRows(resources)");
    expect(page).toContain("Refresh resources");
    expect(page).toContain("api.governorStatus()");
  });
});
