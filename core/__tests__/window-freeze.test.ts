/**
 * A frozen window is recorded, then reloaded after a grace period.
 * Long IPC work does not trigger that reload. The event loop and the
 * renderer heartbeat are real stall signals.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const watchdog = require_(path.join(__dirname, "../../electron/watchdog.cjs")) as {
  FREEZE_GRACE_MS: number;
  planRecovery: (row: { kind: string }) => { action: string; owner: string };
  planFreezeRecovery: (input: { responsive?: boolean; elapsedMs?: number; longWork?: boolean }) => {
    recover: boolean;
    action: string;
    killsProcesses: boolean;
    owner: string;
  };
  createLoopMonitor: (options: {
    intervalMs?: number;
    stallMs?: number;
    now: () => number;
    setInterval: (fn: () => void, ms: number) => number;
    clearInterval: (id: number) => void;
    onLag: (lag: number) => void;
  }) => { stop: () => void };
  createHeartbeat: (options: { now: () => number; missMs?: number }) => {
    beat: (at?: number) => void;
    stalled: (at?: number) => boolean;
  };
  watchWindow: (
    win: EventEmitter,
    hooks: {
      now: () => number;
      longWork: () => boolean;
      recover: (plan: { action: string; killsProcesses: boolean }) => void;
    },
  ) => { stop: () => void };
  HEARTBEAT_MISS_MS: number;
};

describe("window freeze recovery", () => {
  it("keeps the kernel plan and reloads a window only after the grace period", () => {
    expect(watchdog.planRecovery({ kind: "kernel" })).toEqual({
      recover: true,
      owner: "lifecycle",
      action: "restart-kernel",
    });
    expect(
      watchdog.planFreezeRecovery({ responsive: false, elapsedMs: 1000, longWork: false }).action,
    ).toBe("grace");
    expect(
      watchdog.planFreezeRecovery({ responsive: false, elapsedMs: 1000, longWork: true }).action,
    ).toBe("wait");
    const plan = watchdog.planFreezeRecovery({
      responsive: false,
      elapsedMs: watchdog.FREEZE_GRACE_MS,
      longWork: false,
    });
    expect(plan).toMatchObject({
      recover: true,
      owner: "lifecycle",
      action: "reload-renderer",
      killsProcesses: false,
    });
    expect(watchdog.planFreezeRecovery({ responsive: true, elapsedMs: 60_000 }).action).toBe(
      "none",
    );
  });

  it("waits through long work, then reloads on a fake unresponsive window", async () => {
    vi.useFakeTimers();
    const win = new EventEmitter();
    let longWork = true;
    const recovered: Array<{ action: string; killsProcesses: boolean }> = [];
    const handle = watchdog.watchWindow(win, {
      now: () => Date.now(),
      longWork: () => longWork,
      recover: (plan) => recovered.push(plan),
    });
    win.emit("unresponsive");
    await vi.advanceTimersByTimeAsync(watchdog.FREEZE_GRACE_MS);
    expect(recovered).toEqual([]);
    longWork = false;
    await vi.advanceTimersByTimeAsync(watchdog.FREEZE_GRACE_MS);
    expect(recovered).toEqual([
      expect.objectContaining({ action: "reload-renderer", killsProcesses: false }),
    ]);
    win.emit("responsive");
    handle.stop();
    vi.useRealTimers();
  });

  it("records event-loop lag and a missed renderer heartbeat", () => {
    let clock = 1_000;
    const ticks: Array<() => void> = [];
    const lags: number[] = [];
    const monitor = watchdog.createLoopMonitor({
      intervalMs: 500,
      stallMs: 2000,
      now: () => clock,
      setInterval: (fn) => {
        ticks.push(fn);
        return 1;
      },
      clearInterval: () => {
        ticks.length = 0;
      },
      onLag: (lag) => lags.push(lag),
    });
    clock += 500;
    ticks[0]?.();
    expect(lags).toEqual([]);
    clock += 3000;
    ticks[0]?.();
    expect(lags[0]).toBeGreaterThanOrEqual(2000);
    monitor.stop();

    const heart = watchdog.createHeartbeat({
      now: () => clock,
      missMs: watchdog.HEARTBEAT_MISS_MS,
    });
    heart.beat(clock);
    expect(heart.stalled(clock + 1000)).toBe(false);
    expect(heart.stalled(clock + watchdog.HEARTBEAT_MISS_MS + 1)).toBe(true);
  });
});
