/**
 * FRIDAY · continuous background work
 *
 * A single, cheap scheduler that keeps FRIDAY working while nothing is being
 * asked of her. It owns one timer for all jobs (no per-job intervals, no
 * polling storms), skips a job when the app is hidden or a job is still
 * running, and records every run so the owner can see what she actually did.
 *
 * Each job calls a real subsystem — there is no synthetic activity here.
 */

import { inspectSelf } from "../brain/self-diagnosis";
import { doctor, isProblem } from "../doctor-engine";
import { networkMeter } from "../network";
import { notifications } from "../notifications";
import { autonomy } from "./autonomy";
import { memory } from "./memory-engine";
import { taskGraph } from "./task-graph";
import { ensureIdleWork, registerTaskRunners } from "./task-runners";
import { personalDesk } from "../personal-desk";
import {
  prefNumber,
  prefOn,
  shouldOptimizeMemory,
  shouldPauseOnBattery,
  shouldRunBackground,
  shouldSnapshotMemory,
} from "../settings-runtime";

export type BackgroundRun = {
  id: string;
  job: string;
  at: number;
  ms: number;
  ok: boolean;
  note: string;
};

export type BackgroundJob = {
  id: string;
  label: string;
  /** How often it may run, in minutes. */
  everyMinutes: number;
  lastAt: number;
  enabled: boolean;
  run: () => Promise<string>;
};

export type BackgroundState = {
  running: boolean;
  jobs: { id: string; label: string; everyMinutes: number; lastAt: number; enabled: boolean }[];
  runs: BackgroundRun[];
};

const TICK_MS = 60_000;
const MAX_RUNS = 40;

class BackgroundTasks {
  private jobs: BackgroundJob[] = [];
  private state: BackgroundState = { running: false, jobs: [], runs: [] };
  private snapshot: BackgroundState = this.state;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor() {
    this.register({
      id: "health",
      label: "Health watch",
      everyMinutes: 10,
      run: async () => {
        await doctor.scan();
        const checks = doctor.getSnapshot().checks ?? [];
        const bad = checks.filter((c) => isProblem(c.status)).length;
        // The doctor is only the machine half. Her own self-assessment folds in
        // the system map, models and capabilities too — and the doctor.subscribe
        // wiring in notification-wiring.ts turns each problem into a real
        // notification, so this note reports the whole picture, not a subset.
        let mine = 0;
        try {
          mine = inspectSelf().problems.length;
        } catch {
          /* stores not hydrated yet */
        }
        if (bad || mine) {
          return `${bad} environment problem(s), ${mine} issue(s) I'm tracking overall`;
        }
        return `${checks.length} checks healthy, nothing flagged`;
      },
    });

    this.register({
      id: "memory",
      label: "Memory upkeep",
      everyMinutes: 30,
      run: async () => {
        const kept = shouldSnapshotMemory() || shouldOptimizeMemory() ? memory.backup() : 0;
        const archived = shouldOptimizeMemory() ? memory.decayStale() : 0;
        const dropped = shouldOptimizeMemory() ? memory.optimize() : 0;
        if (kept && dropped) return `${kept} memories backed up, ${dropped} compacted`;
        if (archived) return `${archived} stale record(s) archived`;
        if (kept) return `${kept} memories backed up`;
        if (dropped) return `${dropped} memories compacted`;
        return "nothing new to back up";
      },
    });
    this.register({
      id: "desk-reminders",
      label: "Due reminders",
      everyMinutes: 1,
      run: async () => {
        const due = personalDesk.fireDueReminders();
        return due.length ? `${due.length} reminder(s) due` : "nothing due";
      },
    });
    this.register({
      id: "network",
      label: "Connection watch",
      everyMinutes: 5,
      run: async () => {
        await networkMeter.probeLatency();
        const net = networkMeter.getSnapshot();
        return net.online ? `online · ${Math.round(net.latencyMs)}ms` : "offline";
      },
    });
    this.register({
      id: "improve",
      label: "Self-improvement pass",
      everyMinutes: Math.max(15, autonomy.getSnapshot().idleCycleMinutes),
      run: async () => {
        // Idle self-work now runs as a low-priority graph so it checkpoints and
        // pauses the instant the owner sends something. Same pipeline, just
        // interruptible.
        if (taskGraph.busy()) return "skipped — owner work is queued or running";
        ensureIdleWork();
        await taskGraph.pump();
        const idle = taskGraph
          .list()
          .find((graph) => graph.priority === "idle" && graph.finishedAt);
        return idle?.nodes.at(-1)?.checkpoint?.result ?? "idle pass scheduled";
      },
    });

    // Safety net: after a restart (or a paused/queued graph) this brings the
    // durable task graph back to life without a second scheduler.
    this.register({
      id: "graph",
      label: "Task graph",
      everyMinutes: 2,
      run: async () => {
        registerTaskRunners();
        await taskGraph.pump();
        const snapshot = taskGraph.getSnapshot();
        const running = snapshot.runningId ? 1 : 0;
        return `${running} running · ${snapshot.queue.length} queued`;
      },
    });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.state.jobs = this.jobs.map(({ id, label, everyMinutes, lastAt, enabled }) => ({
      id,
      label,
      everyMinutes,
      lastAt,
      enabled,
    }));
    this.snapshot = { ...this.state, jobs: [...this.state.jobs], runs: [...this.state.runs] };
    this.listeners.forEach((l) => l());
  }

  register(job: Omit<BackgroundJob, "lastAt" | "enabled"> & { enabled?: boolean }): void {
    if (this.jobs.some((j) => j.id === job.id)) return;
    this.jobs.push({ lastAt: 0, enabled: job.enabled ?? true, ...job });
    this.emit();
  }

  setEnabled(id: string, enabled: boolean): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.enabled === enabled) return;
    job.enabled = enabled;
    this.emit();
  }

  start(): void {
    if (this.timer || typeof window === "undefined") return;
    this.state.running = true;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.emit();
    // Let the window settle before the first pass.
    setTimeout(() => void this.tick(), 20_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    this.emit();
  }

  /** Runs one named job immediately (owner-triggered), bypassing the schedule. */
  async runNow(id: string): Promise<BackgroundRun | null> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || this.busy) return null;
    job.lastAt = 0;
    return this.tick(job);
  }

  /** One scheduler pass — runs at most one due job so the UI never stalls. */
  async tick(forced?: BackgroundJob): Promise<BackgroundRun | null> {
    if (this.busy || typeof document === "undefined") return null;

    if (!forced && document.hidden) return null;
    if (!forced && !shouldRunBackground()) return null;
    const now = Date.now();
    const due =
      forced ??
      this.jobs
        .filter((j) => j.enabled && now - j.lastAt >= j.everyMinutes * 60_000)
        .sort((a, b) => a.lastAt - b.lastAt)[0];
    if (!due) return null;
    if (!forced && shouldPauseOnBattery() && due.id === "improve") {
      if (await deviceOnBattery()) return null;
    }
    if (!forced && due.id === "improve" && prefOn("throttleFullscreen", false)) {
      if (typeof document !== "undefined" && (!document.hasFocus() || document.fullscreenElement)) {
        return null;
      }
    }
    if (!forced && due.id === "improve" && (await cpuOverBudget())) return null;

    this.busy = true;
    const started = Date.now();
    let ok = true;
    let note: string;
    try {
      note = await due.run();
    } catch (error) {
      ok = false;
      note = error instanceof Error ? error.message : String(error);
    } finally {
      due.lastAt = Date.now();
      this.busy = false;
    }

    const run: BackgroundRun = {
      id: `${due.id}-${started}`,
      job: due.label,
      at: started,
      ms: Date.now() - started,
      ok,
      note,
    };
    this.state.runs = [run, ...this.state.runs].slice(0, MAX_RUNS);
    this.emit();

    if (!ok) {
      notifications.push({
        id: `background:${due.id}:failed`,
        level: "warn",
        title: `${due.label} could not finish`,
        detail: note,
        source: "Background work",
        route: "/status",
      });
    }
    return run;
  }
}

export const backgroundTasks = new BackgroundTasks();

async function deviceOnBattery(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{ charging: boolean }>;
    };
    if (!nav.getBattery) return false;
    const battery = await nav.getBattery();
    return Boolean(battery) && battery.charging === false;
  } catch {
    return false;
  }
}

async function cpuOverBudget(): Promise<boolean> {
  const budget = prefNumber("cpuBudget", 50, 10, 100);
  if (budget >= 100) return false;
  try {
    const api = (
      window as unknown as {
        friday?: { systemMetrics?: () => Promise<{ cpu?: { percent?: number | null } } | null> };
      }
    ).friday;
    const sample = await api?.systemMetrics?.();
    const percent = sample?.cpu?.percent;
    return typeof percent === "number" && percent > budget;
  } catch {
    return false;
  }
}
