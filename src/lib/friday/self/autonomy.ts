/**
 * FRIDAY · autonomy settings backend
 *
 * The single functional source of truth for how autonomous FRIDAY is allowed
 * to be: what she may research, how she picks models, how much she may learn,
 * when she may update herself and what she must never do without approval.
 *
 * These settings are consumed by the governance queue, the research worker and
 * the health monitor. They persist through `persist.ts`, so a restart keeps the
 * exact policy the owner last chose. No UI is added here — existing Settings
 * surfaces (and FRIDAY herself) can read and write this store.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";

/** How much FRIDAY may do on her own before asking. */
export type ApprovalLevel =
  /** Ask every time, including safe work. */
  | "strict"
  /** Safe, reversible actions run automatically; everything else asks. Fresh install. */
  | "balanced"
  /** Safe + reviewed actions run automatically; risky actions still ask. */
  | "trusted"
  /** Runs, writes, executes, and rewires without a per-action prompt. The kill switch still stops her. */
  | "full";

export type UpdatePolicy = "manual" | "stage" | "auto-safe";

export type AutonomySettings = {
  /** Global switch for the background improvement worker. */
  autonomyEnabled: boolean;
  approvalLevel: ApprovalLevel;
  /** Kill switch. While this is on, nothing new is applied. */
  halted: boolean;

  /* research */
  researchEnabled: boolean;
  /** Hostnames FRIDAY is allowed to read from. Empty = no restriction. */
  researchSources: string[];
  /** Max research/improvement passes per idle cycle. */
  researchDepth: number;

  /* models */
  modelPreference: "local-first" | "cloud-first" | "balanced";
  parallelSpecialists: boolean;
  maxParallelModels: number;

  /* memory + learning */
  learningEnabled: boolean;
  /** Only verified outcomes are promoted to long-term knowledge. */
  learnVerifiedOnly: boolean;
  memoryRetentionDays: number;

  /* execution safety */
  sandboxRequired: boolean;
  /** Security probing is limited to local/owned targets. */
  securityScopeLocalOnly: boolean;

  /* updates */
  updatePolicy: UpdatePolicy;
  backupsEnabled: boolean;
  autoRollback: boolean;

  /* resources */
  maxConcurrentTasks: number;
  idleCycleMinutes: number;
};

export const DEFAULT_AUTONOMY: AutonomySettings = {
  autonomyEnabled: true,
  approvalLevel: "balanced",
  halted: false,

  researchEnabled: true,
  researchSources: [
    "github.com",
    "raw.githubusercontent.com",
    "developer.mozilla.org",
    "nodejs.org",
    "python.org",
    "docs.python.org",
    "electronjs.org",
    "huggingface.co",
    "ollama.com",
    "npmjs.com",
    "pypi.org",
  ],
  researchDepth: 3,

  modelPreference: "local-first",
  parallelSpecialists: true,
  maxParallelModels: 3,

  learningEnabled: true,
  learnVerifiedOnly: true,
  memoryRetentionDays: 90,

  sandboxRequired: true,
  securityScopeLocalOnly: true,

  updatePolicy: "stage",
  backupsEnabled: true,
  autoRollback: true,

  maxConcurrentTasks: 3,
  idleCycleMinutes: 15,
};

const STORAGE_KEY = "friday.autonomy.v1";

/** What Stop everything stopped, counted per kind. */
export type StopSummary = {
  graphs: number;
  kernelTasks: number;
  terminalRuns: number;
  /** Set when the kernel did not answer the open-task query or a cancel: its tasks may still be running. */
  kernelSilent?: boolean;
};
export type StopReport = {
  settings: AutonomySettings;
  /** Counted at once (background graphs). */
  stopped: StopSummary;
  /** Counted once the kernel and the terminal answered. Never rejects. */
  settled: Promise<StopSummary>;
};
type StopName = "graphs" | "kernelTasks" | "terminalRuns";
type StopParticipant = { name: StopName; stop: () => number | Promise<number> };

const KERNEL_FINISHED = new Set(["done", "failed", "cancelled", "denied"]);

/** Cancels every kernel task that has not finished. The planner honours the cancel between steps. */
async function cancelOpenKernelTasks(): Promise<{ count: number; silent: boolean }> {
  const { kernelApi } = await import("../kernel-api");
  const answer = await kernelApi.tasks.pending().catch(() => null);
  // No answer is not "nothing is running": the caller must say the kernel was silent.
  if (!answer || !Array.isArray(answer.tasks)) return { count: 0, silent: true };
  let count = 0;
  let silent = false;
  for (const task of answer.tasks) {
    const id = String(task["taskId"] ?? task.id ?? "");
    if (!id || KERNEL_FINISHED.has(String(task["state"] ?? ""))) continue;
    const reply = await kernelApi.tasks.cancel(id).catch(() => null);
    if (!reply) silent = true;
    else if (reply.ok) count += 1;
  }
  return { count, silent };
}

/** Cancels every terminal run (the whole process tree on Windows). */
async function cancelTerminalRuns(): Promise<number> {
  const { terminalCancel, terminalRuns } = await import("../terminal");
  const runs = await terminalRuns().catch(() => []);
  let count = 0;
  for (const run of runs) {
    const answer = await terminalCancel(run.runId).catch(() => null);
    if (answer?.ok) count += 1;
  }
  return count;
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** One short line that says what was really stopped, never more. */
export function describeStop(summary: StopSummary): string {
  const parts = [
    summary.graphs ? `paused ${plural(summary.graphs, "background task")}` : "",
    summary.kernelTasks ? `cancelled ${plural(summary.kernelTasks, "kernel task")}` : "",
    summary.terminalRuns ? `ended ${plural(summary.terminalRuns, "terminal run")}` : "",
  ].filter(Boolean);
  const silent = summary.kernelSilent
    ? " The kernel did not answer, so its tasks may still be running."
    : "";
  if (!parts.length) {
    return summary.kernelSilent ? `Stopped here.${silent}` : "Stopped. Nothing else was running.";
  }
  const last = parts.pop()!;
  const list = parts.length ? `${parts.join(", ")} and ${last}` : last;
  return `Stopped: ${list}.${silent}`;
}

class AutonomyStore {
  private state: AutonomySettings = { ...DEFAULT_AUTONOMY };
  private snapshot: AutonomySettings = this.state;
  private listeners = new Set<() => void>();
  private loaded = false;

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): AutonomySettings => {
    this.load();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const local = readLocalState<Partial<AutonomySettings>>(STORAGE_KEY);
    if (local) this.state = { ...DEFAULT_AUTONOMY, ...local };
    this.snapshot = this.state;
    restoreFromDisk<Partial<AutonomySettings>>(STORAGE_KEY, (disk) => {
      if (!disk) return;
      this.state = { ...DEFAULT_AUTONOMY, ...disk };
      this.emit(false);
    });
  }

  private emit(persist = true) {
    this.snapshot = { ...this.state };
    this.listeners.forEach((l) => l());
    if (persist) writeState(STORAGE_KEY, this.state);
  }

  private stopParticipants = new Map<string, StopParticipant>();
  private participantSeq = 0;

  /**
   * A part of FRIDAY that runs work on its own registers how to stop it. Stop everything calls every one. The
   * background task graph registers itself; kernel tasks and terminal runs are stopped below.
   */
  registerStopParticipant(name: StopName, stop: () => number | Promise<number>): () => void {
    const entry: StopParticipant = { name, stop };
    this.participantSeq += 1;
    const key = `${name}:${this.participantSeq}`;
    this.stopParticipants.set(key, entry);
    return () => void this.stopParticipants.delete(key);
  }

  /**
   * Stop everything: the one fan-out. Sets `halted` (persisted until the owner resumes; the voice, the tool gate and
   * the task graph read it), pauses every running background graph and aborts its active subtask, cancels every open
   * kernel task, cancels every terminal run, and halts MCP calls. `stopped` counts what stopped at once; `settled`
   * resolves when the kernel and terminal cancels came back. Pass either to `describeStop` for the line to say.
   */
  stopEverything(): StopReport {
    const settings = this.update({ halted: true });
    const stopped: StopSummary = { graphs: 0, kernelTasks: 0, terminalRuns: 0 };
    const later: Promise<void>[] = [];
    const add = (name: StopName, count: number | Promise<number>) => {
      if (typeof count === "number") stopped[name] += count;
      else later.push(count.then((n) => void (stopped[name] += n)).catch(() => undefined));
    };
    for (const participant of this.stopParticipants.values()) {
      try {
        add(participant.name, participant.stop());
      } catch {
        /* one part failing to stop must not keep the rest running */
      }
    }
    later.push(
      cancelOpenKernelTasks()
        .then(({ count, silent }) => {
          stopped.kernelTasks += count;
          if (silent) stopped.kernelSilent = true;
        })
        .catch(() => void (stopped.kernelSilent = true)),
    );
    add("terminalRuns", cancelTerminalRuns());
    void import("../desktop")
      .then(({ desktopApi }) => desktopApi()?.mcpDesk?.({ action: "halt" }))
      .catch(() => undefined);
    const now = { ...stopped };
    const settled = Promise.all(later).then(() => ({ ...stopped }));
    return { settings, stopped: now, settled };
  }

  resume(): AutonomySettings {
    const next = this.update({ halted: false });
    void import("../desktop")
      .then(({ desktopApi }) => desktopApi()?.mcpDesk?.({ action: "resume" }))
      .catch(() => undefined);
    return next;
  }

  /** Merge-patch — flipping one control never drops the rest. */
  update(patch: Partial<AutonomySettings>): AutonomySettings {
    this.load();
    this.state = { ...this.state, ...patch };
    this.emit();
    return this.snapshot;
  }

  reset(): AutonomySettings {
    this.state = { ...DEFAULT_AUTONOMY };
    this.emit();
    return this.snapshot;
  }

  /** True when the host is an allowed research source. */
  allowsSource(url: string): boolean {
    const settings = this.getSnapshot();
    if (!settings.researchEnabled) return false;
    if (!settings.researchSources.length) return true;
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return settings.researchSources.some(
        (source) => host === source || host.endsWith(`.${source}`),
      );
    } catch {
      return false;
    }
  }
}

export const autonomy = new AutonomyStore();
