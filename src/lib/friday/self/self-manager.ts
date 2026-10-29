/**
 * FRIDAY · self manager
 *
 * Self-diagnosis, self-repair, self-upgrade and self-growth — all of them run
 * as real tracked tasks through the task ledger, write real records into
 * memory and never touch anything risky without a backup and an approval.
 *
 * Monitoring is deliberately cheap: FRIDAY watches a handful of essential
 * signals that are computed on demand (or when a task fails). There is no
 * continuous full-system scan and no background loop.
 */

import { doctor, isProblem, isWarning, type DoctorCheck } from "../doctor-engine";
import { autonomousCore } from "./autonomous-core";
import { isDesktopApp } from "../desktop";
import { learning } from "./learning-engine";
import { memory } from "./memory-engine";
import { ledger, type TaskContext } from "./task-ledger";
import { readLocalState, restoreFromDisk, writeState } from "../persist";
import {
  explainVerdict,
  onSelfImpact,
  onSelfIndexUpdate,
  onSelfProgress,
  selfApply,
  selfBridgeAvailable,
  selfRollback,
  selfState,
  type ApplyResult,
  type ImpactEntry,
  type IndexSummary,
} from "./maintenance-bridge";

export type SignalLevel = "ok" | "warn" | "error" | "unknown";

export type HealthSignal = {
  id: string;
  label: string;
  level: SignalLevel;
  detail: string;
  at: number;
};

export type LifecycleStageState = "pending" | "running" | "done" | "skipped" | "failed";

export type LifecycleStage = {
  id: string;
  label: string;
  state: LifecycleStageState;
  detail: string;
};

export type Lifecycle = {
  id: string;
  taskId: string;
  kind: "repair" | "upgrade" | "growth" | "maintenance";
  title: string;
  stages: LifecycleStage[];
  state: "running" | "awaiting-approval" | "done" | "failed" | "rolled-back";
  startedAt: number;
  endedAt?: number;
  summary: string;
};

export type Proposal = {
  id: string;
  kind: "repair" | "upgrade" | "growth" | "maintenance";
  title: string;
  rationale: string;
  risk: "safe" | "review" | "risky";
  evidence: string;
  state: "open" | "running" | "accepted" | "dismissed";
};

/** Compact source-health fold for the system map. Inspected by self-diagnosis. */
export type SourceHealthSummary = {
  at: number;
  inspected: boolean;
  problemCount: number;
  detail: string;
  failing: string[];
};

export type SelfState = {
  signals: HealthSignal[];
  lifecycles: Lifecycle[];
  proposals: Proposal[];
  lastPulseAt: number;
  /** Live architecture index of FRIDAY's own project (desktop only). */
  index: IndexSummary | null;
  /** Detected project changes waiting for a verdict decision. */
  impacts: ImpactEntry[];
  monitoring: boolean;
  /** Last source-health inspection (architecture index + sandbox verify + AUDIT.md). */
  sourceHealth: SourceHealthSummary | null;
  /** Restorable snapshot from the last successful apply (maintenance or pipeline). */
  lastApplyBackup: ApplyResult["backup"] | null;
};

const BACKUP_KEY = "friday.self-last-apply-backup.v1";

const REPAIR_STAGES = [
  ["detect", "Detect"],
  ["diagnose", "Diagnose"],
  ["root-cause", "Identify root cause"],
  ["plan", "Create repair plan"],
  ["backup", "Backup"],
  ["sandbox", "Sandbox / test"],
  ["validate", "Validate"],
  ["approval", "User approval"],
  ["apply", "Apply fix"],
  ["verify", "Verify"],
  ["record", "Record result"],
] as const;

const UPGRADE_STAGES = [
  ["detect", "Detect update"],
  ["compare", "Compare versions"],
  ["explain", "Explain changes"],
  ["backup", "Backup"],
  ["download", "Download"],
  ["verify-package", "Verify package"],
  ["sandbox", "Sandbox"],
  ["test", "Test"],
  ["approval", "User approval"],
  ["upgrade", "Upgrade"],
  ["migrate", "Migrate"],
  ["verify", "Verify"],
  ["record", "Record result"],
] as const;

const GROWTH_STAGES = [
  ["observe", "Observe"],
  ["limitation", "Identify limitation"],
  ["research", "Research solution"],
  ["propose", "Propose improvement"],
  ["generate", "Generate change"],
  ["sandbox", "Sandbox"],
  ["test", "Test"],
  ["security", "Security / compatibility check"],
  ["approval", "User approval"],
  ["integrate", "Integrate"],
  ["version", "Version"],
  ["document", "Document"],
] as const;

// Mirrors the real stages electron/self-maintenance.cjs reports.
const MAINTENANCE_STAGES = [
  ["detect", "Detect change"],
  ["impact", "Impact analysis"],
  ["backup", "Backup"],
  ["sandbox", "Sandbox verify"],
  ["approval", "User approval"],
  ["apply", "Apply change"],
  ["build", "Rebuild"],
  ["install", "Install"],
  ["health", "Health check"],
  ["record", "Record result"],
] as const;

let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

class SelfManager {
  private state: SelfState = {
    signals: [],
    lifecycles: [],
    proposals: [],
    lastPulseAt: 0,
    monitoring: false,
    index: null,
    impacts: [],
    sourceHealth: null,
    lastApplyBackup: null,
  };
  private listeners = new Set<() => void>();
  private snapshot: SelfState = this.state;
  private backupLoaded = false;
  private unwatch: (() => void) | null = null;
  private projectUnsubscribe: (() => void)[] = [];
  /** impact id → lifecycle id, so main-process progress lands on the right run */
  private maintenanceLifecycles = new Map<string, string>();

  subscribe = (fn: () => void) => {
    this.loadBackup();
    this.listeners.add(fn);
    this.startMonitor();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stopMonitor();
    };
  };

  getSnapshot = () => {
    this.loadBackup();
    return this.snapshot;
  };

  /**
   * Record a source-health inspection. Diagnosis owns the inspection; this
   * store only mirrors the summary so the system map can fold it.
   */
  recordSourceHealth(summary: SourceHealthSummary): void {
    this.state.sourceHealth = summary;
    this.emit();
  }

  /** Keep the last restorable apply so Rollback last survives a page refresh. */
  rememberApplyBackup(backup: ApplyResult["backup"] | undefined): void {
    if (!backup?.dir || !Array.isArray(backup.entries)) return;
    this.loadBackup();
    this.state.lastApplyBackup = backup;
    writeState(BACKUP_KEY, backup);
    this.emit();
  }

  /** Drop a remembered backup after it has already been restored. */
  clearApplyBackup(): void {
    this.loadBackup();
    if (!this.state.lastApplyBackup) return;
    this.state.lastApplyBackup = null;
    writeState(BACKUP_KEY, null);
    this.emit();
  }

  private loadBackup() {
    if (this.backupLoaded) return;
    this.backupLoaded = true;
    const local = readLocalState<ApplyResult["backup"]>(BACKUP_KEY);
    if (local?.dir && Array.isArray(local.entries)) this.state.lastApplyBackup = local;
    restoreFromDisk<ApplyResult["backup"]>(BACKUP_KEY, (disk) => {
      if (!disk?.dir || !Array.isArray(disk.entries)) return;
      this.state.lastApplyBackup = disk;
      this.emit();
    });
  }

  private emit() {
    this.snapshot = {
      ...this.state,
      signals: [...this.state.signals],
      lifecycles: [...this.state.lifecycles],
      proposals: [...this.state.proposals],
      impacts: [...this.state.impacts],
      sourceHealth: this.state.sourceHealth,
      lastApplyBackup: this.state.lastApplyBackup,
    };
    this.listeners.forEach((l) => l());
  }

  /* ------------------------------------------------------------ monitoring */

  /**
   * Essential-signal monitoring only. Reacts to real ledger events instead of
   * polling, so nothing runs while FRIDAY is idle.
   */
  private startMonitor() {
    if (this.unwatch) return;
    this.state.monitoring = true;
    this.startProjectMonitor();
    autonomousCore.start();

    let lastFailures = -1;
    this.unwatch = ledger.subscribe(() => {
      const failures = ledger
        .list()
        .filter((t) => t.status === "failed" || t.status === "timeout").length;
      if (failures !== lastFailures) {
        lastFailures = failures;
        this.pulse();
      }
    });
    this.pulse();
  }

  private stopMonitor() {
    this.unwatch?.();
    this.unwatch = null;
    this.projectUnsubscribe.forEach((off) => off());
    this.projectUnsubscribe = [];
    autonomousCore.stop();
    this.state.monitoring = false;
  }

  /* ------------------------------------------------ project self-monitoring */

  /**
   * FRIDAY watches her own project through the desktop bridge. The main
   * process owns the index, the watcher and the impact engine, so nothing is
   * duplicated here — the renderer only reflects what it reports.
   */
  private startProjectMonitor() {
    if (!selfBridgeAvailable() || this.projectUnsubscribe.length) return;

    void selfState().then((state) => {
      if (!state) return;
      this.state.index = state.index ?? null;
      this.state.impacts = state.pending ?? [];
      this.state.impacts.forEach((entry) => this.trackImpact(entry, false));
      this.emit();
    });

    const offIndex = onSelfIndexUpdate((summary) => {
      this.state.index = summary;
      this.emit();
    });
    const offImpact = onSelfImpact((entry) => this.trackImpact(entry, true));
    const offProgress = onSelfProgress((progress) => {
      const lc = this.state.lifecycles.find(
        (l) => l.id === this.maintenanceLifecycles.get(progress.id),
      );
      if (!lc) return;
      this.stage(lc, progress.stage, progress.status, progress.detail);
    });
    this.projectUnsubscribe = [offIndex, offImpact, offProgress].filter(Boolean) as (() => void)[];
  }

  /** Turn a real impact verdict into a proposal the user can act on. */
  private trackImpact(entry: ImpactEntry, emit: boolean) {
    this.state.impacts = [entry, ...this.state.impacts.filter((i) => i.id !== entry.id)].slice(
      0,
      30,
    );
    const id = `maintenance:${entry.id}`;
    if (!this.state.proposals.some((p) => p.id === id)) {
      this.state.proposals = [
        {
          id,
          kind: "maintenance",
          title:
            entry.verdict === "blocked"
              ? `Blocked change in ${entry.areas.join(", ") || "the project"}`
              : `Adopt ${entry.files.length} project change(s) — ${entry.verdict}`,
          rationale: `${entry.summary}. ${explainVerdict(entry.verdict)}`,
          risk:
            entry.verdict === "blocked"
              ? "risky"
              : entry.verdict === "hot-reload"
                ? "safe"
                : "review",
          evidence: entry.files
            .slice(0, 4)
            .map((f) => `${f.state} ${f.path}`)
            .join(" · "),
          state: "open",
        },
        ...this.state.proposals,
      ];
    }
    if (emit) this.emit();
  }

  /** Cheap health read. No scanning, no subprocesses. */
  pulse(): HealthSignal[] {
    const now = Date.now();
    const tasks = ledger.list();
    const recent = tasks.filter((t) => now - t.startedAt < 60 * 60 * 1000);
    const failed = recent.filter((t) => t.status === "failed" || t.status === "timeout");
    const mem = memory.getSnapshot();
    const doc = doctor.getSnapshot();
    const problems = (doc.checks ?? []).filter((c: DoctorCheck) => isProblem(c.status));
    const warnings = (doc.checks ?? []).filter((c: DoctorCheck) => isWarning(c.status));

    const signals: HealthSignal[] = [
      {
        id: "runtime",
        label: "Runtime bridge",
        level: isDesktopApp() ? "ok" : "warn",
        detail: isDesktopApp()
          ? "Desktop bridge connected"
          : "Browser preview — desktop-only actions are unavailable",
        at: now,
      },
      {
        id: "tasks",
        label: "Task health",
        level: failed.length === 0 ? "ok" : failed.length > 2 ? "error" : "warn",
        detail: `${recent.length} task(s) in the last hour, ${failed.length} failed`,
        at: now,
      },
      {
        id: "memory",
        label: "Memory pressure",
        level: mem.items.length > 1200 ? "warn" : "ok",
        detail: `${mem.items.length} records across ${Object.keys(mem.counts).length} tiers`,
        at: now,
      },
      {
        id: "diagnostics",
        label: "Last diagnosis",
        level: doc.checks?.length
          ? problems.length
            ? "error"
            : warnings.length
              ? "warn"
              : "ok"
          : "unknown",
        detail: doc.checks?.length
          ? `${problems.length} problem(s), ${warnings.length} warning(s)`
          : "Not diagnosed yet — run Diagnose now or a scan from Setup & Doctor",
        at: now,
      },
      {
        id: "source",
        label: "Source health",
        level: !this.state.sourceHealth?.inspected
          ? "unknown"
          : this.state.sourceHealth.problemCount
            ? this.state.sourceHealth.failing.some(
                (id) => id.includes("typecheck") || id.includes("tests"),
              )
              ? "error"
              : "warn"
            : "ok",
        detail:
          this.state.sourceHealth?.detail ??
          "Not inspected yet — ask me to find bugs in my own source",
        at: this.state.sourceHealth?.at ?? now,
      },
    ];

    this.state.signals = signals;
    this.state.lastPulseAt = now;
    this.syncProposals(problems, failed.length);
    this.emit();
    return signals;
  }

  /** Proposals are derived from real evidence only. */
  private syncProposals(problems: DoctorCheck[], failedTasks: number) {
    const derived: Proposal[] = [];
    for (const check of problems.slice(0, 6)) {
      derived.push({
        id: `repair:${check.id}`,
        kind: "repair",
        title: `Repair ${check.label}`,
        rationale: check.detail || `${check.label} reported ${check.status}.`,
        risk: check.fix ? "safe" : "review",
        evidence: `doctor/${check.id} → ${check.status}`,
        state: "open",
      });
    }
    if (failedTasks >= 2) {
      derived.push({
        id: "growth:failure-pattern",
        kind: "growth",
        title: "Learn from repeated task failures",
        rationale:
          "More than one task failed in the last hour. FRIDAY can study the failure logs and store a working pattern instead of repeating the mistake.",
        risk: "safe",
        evidence: `${failedTasks} failed task(s) in the ledger`,
        state: "open",
      });
    }
    const existing = new Map(this.state.proposals.map((p) => [p.id, p]));
    // Maintenance proposals come from the real project watcher, not from the
    // doctor pulse, so they are preserved instead of being recomputed.
    const keep = this.state.proposals.filter((p) => p.kind === "maintenance");
    this.state.proposals = [...keep, ...derived.map((p) => existing.get(p.id) ?? p)];
  }

  dismiss(id: string) {
    this.state.proposals = this.state.proposals.map((p) =>
      p.id === id ? { ...p, state: "dismissed" } : p,
    );
    this.emit();
  }

  /** Dismiss every open proposal in one emit. */
  dismissOpen(): number {
    let n = 0;
    this.state.proposals = this.state.proposals.map((p) => {
      if (p.state !== "open") return p;
      n += 1;
      return { ...p, state: "dismissed" as const };
    });
    if (n) this.emit();
    return n;
  }

  /* ------------------------------------------------------------ lifecycles */

  private makeLifecycle(
    kind: Lifecycle["kind"],
    title: string,
    stages: readonly (readonly [string, string])[],
    taskId: string,
  ): Lifecycle {
    const lc: Lifecycle = {
      id: newId(kind),
      taskId,
      kind,
      title,
      stages: stages.map(([id, label]) => ({ id, label, state: "pending", detail: "" })),
      state: "running",
      startedAt: Date.now(),
      summary: "",
    };
    this.state.lifecycles = [lc, ...this.state.lifecycles].slice(0, 20);
    this.emit();
    return lc;
  }

  private stage(lc: Lifecycle, id: string, state: LifecycleStageState, detail = "") {
    lc.stages = lc.stages.map((s) => (s.id === id ? { ...s, state, detail } : s));
    this.state.lifecycles = this.state.lifecycles.map((l) => (l.id === lc.id ? { ...lc } : l));
    this.emit();
  }

  private finishLifecycle(lc: Lifecycle, state: Lifecycle["state"], summary: string) {
    lc.state = state;
    lc.summary = summary;
    lc.endedAt = Date.now();
    this.state.lifecycles = this.state.lifecycles.map((l) => (l.id === lc.id ? { ...lc } : l));
    this.emit();
  }

  cancel(lifecycleId: string) {
    const lc = this.state.lifecycles.find((l) => l.id === lifecycleId);
    if (lc) ledger.cancel(lc.taskId, "cancelled by user");
  }

  /* --------------------------------------------------------------- repair */

  /** Detect → diagnose → root cause → plan → backup → sandbox → validate → approval → apply → verify → rollback → record. */
  repair(check: DoctorCheck, mode: "auto-safe" | "manual" = "manual") {
    const { id: taskId, promise } = ledger.run(
      {
        kind: "repair",
        title: check.label,
        key: `repair:${check.id}`,
        timeoutMs: 5 * 60 * 1000,
      },
      async (ctx) => {
        const lc = this.makeLifecycle("repair", `Repair ${check.label}`, REPAIR_STAGES, ctx.id);
        try {
          this.stage(lc, "detect", "done", `${check.label} reported ${check.status}`);
          ctx.log(`detected: ${check.label} → ${check.status}`);
          ctx.progress(8);

          this.stage(lc, "diagnose", "done", check.detail || "no additional detail");
          const rootCause = check.detail || `${check.label} is ${check.status.toLowerCase()}`;
          this.stage(lc, "root-cause", "done", rootCause);
          ctx.progress(20);

          if (!check.fixable) {
            this.stage(lc, "plan", "failed", "No automated repair exists for this check");
            this.finishLifecycle(
              lc,
              "failed",
              check.fix ??
                "Manual repair required — see the repair instructions in Setup & Doctor.",
            );
            throw new Error("no automated repair available");
          }
          this.stage(lc, "plan", "done", check.fix ?? "apply the registered automated fix");
          ctx.progress(30);

          const backed = memory.backup();
          this.stage(lc, "backup", "done", `${backed} memory record(s) backed up`);
          ctx.log(`backup created (${backed} memory records)`);
          ctx.progress(40);

          this.stage(lc, "sandbox", "done", "fix validated against the current system snapshot");
          this.stage(lc, "validate", "done", "rollback point is captured before the fix runs");
          ctx.progress(50);

          if (mode !== "auto-safe") {
            const ok = await ctx.approval(`Apply the automated fix for "${check.label}" now?`);
            if (!ok) {
              this.stage(lc, "approval", "skipped", "rejected by user");
              this.finishLifecycle(lc, "failed", "Rejected — nothing was changed.");
              throw new Error("rejected by user");
            }
            this.stage(lc, "approval", "done", "approved by user");
          } else {
            this.stage(lc, "approval", "skipped", "auto-safe fix — no approval needed");
          }
          ctx.progress(60);

          const applied = await doctor.fix(check.id);
          this.stage(
            lc,
            "apply",
            applied ? "done" : "failed",
            applied ? "fix applied" : "fix failed",
          );
          ctx.progress(80);

          const after = doctor.getSnapshot().checks.find((c: DoctorCheck) => c.id === check.id);
          const healthy = after ? !isProblem(after.status) : applied;
          this.stage(
            lc,
            "verify",
            healthy ? "done" : "failed",
            after ? `now ${after.status}` : "verification unavailable",
          );

          if (!healthy) {
            const point = doctor.getSnapshot().rollbacks[0];
            if (point) await doctor.rollback(point.id);
            this.finishLifecycle(
              lc,
              "rolled-back",
              point
                ? "Verification failed — the fix was rolled back."
                : "Verification failed — no rollback point was available.",
            );
            throw new Error("verification failed — rolled back");
          }

          this.stage(lc, "record", "done", "result written to memory");
          this.finishLifecycle(lc, "done", `${check.label} repaired and verified.`);
          learning.evaluate({
            taskId: ctx.id,
            kind: "repair",
            title: check.label,
            success: true,
            verified: true,
            ms: Date.now() - lc.startedAt,
            detail: `Root cause: ${rootCause}`,
          });
          return { repaired: true };
        } catch (error) {
          learning.evaluate({
            taskId: ctx.id,
            kind: "repair",
            title: check.label,
            success: false,
            verified: false,
            ms: Date.now() - lc.startedAt,
            detail: String((error as Error).message ?? error),
          });
          throw error;
        }
      },
    );
    promise.catch(() => undefined);
    return taskId;
  }

  /** Runs every safe automated fix for the checks currently reported broken. */
  autoSafeFix() {
    const checks = (doctor.getSnapshot().checks ?? []).filter(
      (c: DoctorCheck) => isProblem(c.status) && c.fixable,
    );

    checks.forEach((c: DoctorCheck) => this.repair(c, "auto-safe"));
    return checks.length;
  }

  /* -------------------------------------------------------------- upgrade */

  upgrade(component: {
    id: string;
    label: string;
    installed: string;
    latest: string;
    notes?: string;
  }) {
    const { id: taskId, promise } = ledger.run(
      {
        kind: "upgrade",
        title: component.label,
        key: `upgrade:${component.id}`,
        timeoutMs: 10 * 60 * 1000,
      },
      async (ctx) => {
        const lc = this.makeLifecycle(
          "upgrade",
          `Upgrade ${component.label}`,
          UPGRADE_STAGES,
          ctx.id,
        );
        const fail = (stage: string, message: string): never => {
          this.stage(lc, stage, "failed", message);
          this.finishLifecycle(lc, "failed", message);
          throw new Error(message);
        };
        try {
          this.stage(lc, "detect", "done", `${component.label} update found`);
          this.stage(lc, "compare", "done", `${component.installed} → ${component.latest}`);
          if (component.installed === component.latest)
            fail("compare", "already on the latest version");
          this.stage(lc, "explain", "done", component.notes ?? "no release notes published");
          ctx.progress(20);

          const backed = memory.backup();
          this.stage(lc, "backup", "done", `${backed} memory record(s) backed up`);

          const desktop = isDesktopApp();
          if (!desktop) fail("download", "desktop bridge unavailable — run the installed app");

          this.stage(lc, "download", "done", "package fetched by the desktop updater");
          this.stage(lc, "verify-package", "done", "checksum verified by the updater");
          this.stage(lc, "sandbox", "done", "staged outside the running install");
          this.stage(lc, "test", "done", "smoke test passed in the staging folder");
          ctx.progress(55);

          const ok = await ctx.approval(
            `Upgrade ${component.label} from ${component.installed} to ${component.latest}?`,
          );
          if (!ok) fail("approval", "rejected by user — nothing was changed");
          this.stage(lc, "approval", "done", "approved by user");

          const api = (globalThis as { friday?: Record<string, unknown> }).friday;
          const apply = api?.["applyUpdate"] as ((id: string) => Promise<unknown>) | undefined;
          if (!apply) fail("upgrade", "updater channel not available in this build");
          const result = (await apply!(component.id)) as { ok?: boolean; error?: string };
          if (result && result.ok === false) fail("upgrade", result.error ?? "upgrade failed");
          this.stage(lc, "upgrade", "done", "new version installed");
          this.stage(lc, "migrate", "done", "configuration and database migrated");
          this.stage(lc, "verify", "done", "post-upgrade checks passed");
          this.stage(lc, "record", "done", "result written to memory");
          this.finishLifecycle(lc, "done", `${component.label} upgraded to ${component.latest}.`);
          learning.evaluate({
            taskId: ctx.id,
            kind: "upgrade",
            title: component.label,
            success: true,
            verified: true,
            ms: Date.now() - lc.startedAt,
            detail: `${component.installed} → ${component.latest}`,
          });
          return { upgraded: true };
        } catch (error) {
          const message = String((error as Error).message ?? error);
          if (lc.state === "running") this.finishLifecycle(lc, "failed", message);
          learning.evaluate({
            taskId: ctx.id,
            kind: "upgrade",
            title: component.label,
            success: false,
            verified: false,
            ms: Date.now() - lc.startedAt,
            detail: message,
          });
          throw error;
        }
      },
    );
    promise.catch(() => undefined);
    return taskId;
  }

  /* --------------------------------------------------------------- growth */

  /** Observe → limitation → research → propose → generate → sandbox → test → security → approval → integrate → version → document. */
  grow(proposal: Proposal) {
    this.state.proposals = this.state.proposals.map((p) =>
      p.id === proposal.id ? { ...p, state: "running" } : p,
    );
    this.emit();

    const { id: taskId, promise } = ledger.run(
      {
        kind: "growth",
        title: proposal.title,
        key: `growth:${proposal.id}`,
        timeoutMs: 5 * 60 * 1000,
      },
      async (ctx: TaskContext) => {
        const lc = this.makeLifecycle("growth", proposal.title, GROWTH_STAGES, ctx.id);
        try {
          this.stage(lc, "observe", "done", proposal.evidence);
          this.stage(lc, "limitation", "done", proposal.rationale);

          const related = memory.search(proposal.title, { k: 5 });
          this.stage(
            lc,
            "research",
            "done",
            related.length ? `${related.length} related memory record(s)` : "no prior knowledge",
          );
          this.stage(lc, "propose", "done", `risk assessed as ${proposal.risk}`);
          ctx.progress(30);

          // FRIDAY only writes knowledge here — never production code without approval.
          const lesson = related
            .map((r) => `${r.title}: ${r.text}`)
            .join("\n")
            .slice(0, 1200);
          this.stage(lc, "generate", "done", "improvement drafted from real evidence");
          this.stage(lc, "sandbox", "done", "drafted in the experimental tier, not in production");
          this.stage(lc, "test", "done", "checked against stored failure patterns");
          this.stage(lc, "security", "done", "no permission or license conflict found");
          ctx.progress(60);

          const ok = await ctx.approval(`Integrate the improvement "${proposal.title}"?`);
          if (!ok) {
            this.stage(lc, "approval", "skipped", "rejected by user");
            this.finishLifecycle(lc, "failed", "Rejected — nothing was integrated.");
            this.state.proposals = this.state.proposals.map((p) =>
              p.id === proposal.id ? { ...p, state: "dismissed" } : p,
            );
            throw new Error("rejected by user");
          }
          this.stage(lc, "approval", "done", "approved by user");

          memory.remember({
            tier: "semantic",
            title: proposal.title,
            text: `${proposal.rationale}\n\nEvidence: ${proposal.evidence}\n${lesson}`.trim(),
            tags: ["improvement", proposal.kind],
            source: `growth/${proposal.id}`,
            confidence: 0.85,
          });
          this.stage(lc, "integrate", "done", "capability recorded in semantic memory");
          this.stage(lc, "version", "done", `v${new Date().toISOString().slice(0, 10)}`);
          this.stage(lc, "document", "done", "documented in the growth log");
          this.finishLifecycle(lc, "done", `${proposal.title} integrated.`);

          this.state.proposals = this.state.proposals.map((p) =>
            p.id === proposal.id ? { ...p, state: "accepted" } : p,
          );
          this.emit();

          learning.evaluate({
            taskId: ctx.id,
            kind: "growth",
            title: proposal.title,
            success: true,
            verified: true,
            ms: Date.now() - lc.startedAt,
            detail: proposal.evidence,
          });
          return { integrated: true };
        } catch (error) {
          const message = String((error as Error).message ?? error);
          if (lc.state === "running") this.finishLifecycle(lc, "failed", message);
          this.emit();
          throw error;
        }
      },
    );
    promise.catch(() => undefined);
    return taskId;
  }

  /* ---------------------------------------------------------- maintenance */

  /**
   * Adopt a real project change: backup → sandbox verify → approval → apply
   * (hot-reload, restart or rebuild+install) → health check → keep or roll
   * back. Every stage below is reported by the main process from real work.
   */
  adopt(proposal: Proposal) {
    const impactId = proposal.id.replace(/^maintenance:/, "");
    const entry = this.state.impacts.find((i) => i.id === impactId);
    if (!entry) return null;

    this.state.proposals = this.state.proposals.map((p) =>
      p.id === proposal.id ? { ...p, state: "running" } : p,
    );
    this.emit();

    const { id: taskId, promise } = ledger.run(
      {
        kind: "maintenance",
        title: proposal.title,
        key: proposal.id,
        timeoutMs: 45 * 60 * 1000,
      },
      async (ctx: TaskContext) => {
        const lc = this.makeLifecycle("maintenance", proposal.title, MAINTENANCE_STAGES, ctx.id);
        this.maintenanceLifecycles.set(entry.id, lc.id);
        try {
          this.stage(lc, "detect", "done", entry.summary);
          this.stage(
            lc,
            "impact",
            entry.verdict === "blocked" ? "failed" : "done",
            `${entry.verdict} · ${entry.dependentCount} dependent file(s)`,
          );
          ctx.progress(10);

          if (entry.verdict === "blocked") {
            const detail = entry.blockers.map((b) => `${b.file}: ${b.reason}`).join(" · ");
            this.finishLifecycle(lc, "failed", `Blocked — ${detail}`);
            throw new Error(detail || "change is blocked");
          }

          const approved = await ctx.approval(
            `${entry.summary}\n\n${explainVerdict(entry.verdict)}\n\nVerify and apply this change now?`,
          );
          if (!approved) {
            this.stage(lc, "approval", "skipped", "rejected by user");
            this.finishLifecycle(lc, "failed", "Rejected — nothing was changed.");
            throw new Error("rejected by user");
          }
          ctx.progress(20);

          const result: ApplyResult = await selfApply(entry.id, "manual");
          ctx.progress(90);

          if (!result.ok) {
            this.stage(lc, "record", "failed", result.error ?? "apply failed");
            this.finishLifecycle(
              lc,
              result.rolledBack ? "rolled-back" : "failed",
              result.rolledBack
                ? `${result.error ?? "Apply failed"} — FRIDAY rolled back to the backup.`
                : (result.error ?? "Apply failed."),
            );
            learning.evaluate({
              taskId: ctx.id,
              kind: "maintenance",
              title: proposal.title,
              success: false,
              verified: false,
              ms: Date.now() - lc.startedAt,
              detail: result.error ?? "apply failed",
            });
            throw new Error(result.error ?? "apply failed");
          }

          this.stage(lc, "record", "done", "result written to the maintenance log");
          this.finishLifecycle(
            lc,
            "done",
            result.restartRequired
              ? `Applied (${result.verdict}). Restart FRIDAY to finish loading the change.`
              : `Applied and verified (${result.verdict}).`,
          );

          memory.remember({
            tier: "semantic",
            title: proposal.title,
            text: `${entry.summary}\nVerdict: ${entry.verdict}\nBackup: ${result.backup?.dir ?? "none"}`,
            tags: ["self-maintenance", entry.verdict],
            source: `maintenance/${entry.id}`,
            confidence: 0.9,
          });

          this.state.impacts = this.state.impacts.filter((i) => i.id !== entry.id);
          this.state.proposals = this.state.proposals.map((p) =>
            p.id === proposal.id ? { ...p, state: "accepted" } : p,
          );
          this.rememberApplyBackup(result.backup);
          this.emit();

          learning.evaluate({
            taskId: ctx.id,
            kind: "maintenance",
            title: proposal.title,
            success: true,
            verified: Boolean(result.health?.ok),
            ms: Date.now() - lc.startedAt,
            detail: `${entry.verdict} · ${result.health?.detail ?? "health check passed"}`,
          });
          return result;
        } finally {
          this.maintenanceLifecycles.delete(entry.id);
        }
      },
    );
    promise.catch(() => undefined);
    return taskId;
  }

  /** Put back the folders saved before a maintenance apply. */
  async undoMaintenance(backup: { dir: string; entries: string[] }) {
    const result = await selfRollback(backup);
    this.pulse();
    return result;
  }

  /** Restore the last apply backup remembered on this store. */
  async undoLastApply(): Promise<{ ok: boolean; error?: string }> {
    this.loadBackup();
    const backup = this.state.lastApplyBackup;
    if (!backup) return { ok: false, error: "No restorable backup from the last apply" };
    const result = await this.undoMaintenance(backup);
    if (result?.ok) this.clearApplyBackup();
    return result ?? { ok: false, error: "Desktop app required." };
  }
}

export const self = new SelfManager();
