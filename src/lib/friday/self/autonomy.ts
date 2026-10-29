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

  /** Stop everything. Persists until the owner resumes. Also halts MCP calls. */
  stopEverything(): AutonomySettings {
    const next = this.update({ halted: true });
    void import("../desktop")
      .then(({ desktopApi }) => desktopApi()?.mcpDesk?.({ action: "halt" }))
      .catch(() => undefined);
    return next;
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
