/**
 * FRIDAY Doctor engine.
 *
 * Owns the diagnostic state for the Setup & Doctor page. Every check comes
 * from the main process (`window.friday.runDiagnostics`) — the renderer never
 * probes the machine itself and never invents a healthy status. In the browser
 * preview the store reports exactly that: the environment cannot be inspected.
 */
import { rerunStartup } from "./startup";
import { recentFailedStages } from "./brain/turn-timing";
import { recentSkillGapDrafts } from "./brain/skill-forge";
import { repairWaveCapability, waveCapabilityChecks } from "./failure-guard";
import { speechDoctorRows } from "./speech-core";
import { toolchainDoctorRows } from "./toolchain-manifest";
import { voiceLayerChecks } from "./voice-doctor";
import { preferences } from "./preferences";

export type DoctorStatus =
  "Ready" | "Running" | "Missing" | "Outdated" | "Error" | "Warning" | "Repairing";

export type RepairKind = "none-needed" | "auto-fixed" | "needs-owner";

export type OwnerGuidance = {
  kind: "needs-owner";
  checkId: string;
  title: string;
  reason: string;
  steps: string[];
  retryable: boolean;
};

export type DoctorCheck = {
  id: string;
  label: string;
  group: string;
  status: DoctorStatus;
  detail: string;
  cause?: string | null;
  fix?: string | null;
  command?: string | null;
  docs?: string | null;
  fixable?: boolean;
  meta?: Record<string, unknown>;
  /** Set locally when a repair changes the outcome. */
  before?: DoctorStatus;
  /** Numbered owner steps when auto-repair is unsafe or already failed. */
  steps?: string[];
  repairKind?: RepairKind;
  /** True after FRIDAY attempted the safe automatic repair for this check. */
  tried?: boolean;
};

export type DoctorLog = {
  id: string;
  at: string;
  level: "info" | "ok" | "warn" | "error";
  line: string;
};

export type RollbackPoint = {
  id: string;
  checkId: string;
  at: number;
  entries: { file: string; backup: string }[];
};

export type DoctorState = {
  checks: DoctorCheck[];
  log: DoctorLog[];
  scanning: boolean;
  mode: "idle" | "quick" | "deep" | "auto";
  repairing: string[];
  lastScanAt: number | null;
  lastDeep: boolean;
  durationMs: number;
  rollbacks: RollbackPoint[];
  desktop: boolean;
};

type DoctorApi = {
  isDesktop: true;
  runDiagnostics?: (o: { deep?: boolean }) => Promise<{
    at: number;
    durationMs: number;
    deep: boolean;
    checks: DoctorCheck[];
  }>;
  applyDiagnosticFix?: (id: string) => Promise<{
    ok: boolean;
    log: string[];
    rollback?: { file: string; backup: string }[];
  }>;
  rollbackDiagnosticFix?: (
    entries: { file: string; backup: string }[],
  ) => Promise<{ ok: boolean; log: string[] }>;
  exportDiagnostics?: (report: string) => Promise<string>;
  onDiagnosticFixProgress?: (
    cb: (event: { id: string; phase: string; log?: string[]; ok?: boolean }) => void,
  ) => () => void;
};

const api = (): DoctorApi | undefined =>
  typeof window !== "undefined" ? (window.friday as unknown as DoctorApi | undefined) : undefined;

const clock = () =>
  new Date().toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

/** Statuses that count as "needs attention". */
export const isProblem = (s: DoctorStatus) => s === "Missing" || s === "Error";
export const isWarning = (s: DoctorStatus) => s === "Warning" || s === "Outdated";
export const isHealthy = (s: DoctorStatus) => s === "Ready" || s === "Running";

/**
 * Concrete owner steps for one check. Diagnostic-provided `steps` win;
 * otherwise FRIDAY spells out cause / fix / command and is honest that she
 * cannot grant a key, driver or Windows permission herself.
 */
export function stepsFor(check: DoctorCheck): string[] {
  if (Array.isArray(check.steps) && check.steps.length) return check.steps;
  const steps: string[] = [];
  if (check.cause) steps.push(`What's going on: ${check.cause}`);
  if (check.detail && check.detail !== check.cause) steps.push(check.detail);
  if (check.fix) steps.push(check.fix);
  if (check.command) steps.push(`If you use a terminal, run: ${check.command}`);
  if (check.docs) steps.push(`More detail: ${check.docs}`);
  if (check.fixable) {
    steps.push(
      "FRIDAY already tried the safe automatic repair and it did not clear this. The remaining steps are yours.",
    );
  } else {
    steps.push(
      "FRIDAY cannot do this for you — it needs a key, driver, account, or Windows permission only you can grant.",
    );
  }
  steps.push(
    "When you've done that, open Setup & Doctor and run a scan (or say “what's wrong”) so FRIDAY re-checks for real.",
  );
  return steps;
}

/**
 * Third doctor outcome: the owner has to act. Null while a safe auto-fix is
 * still available, and null when the check is healthy.
 */
export function guidanceFor(check: DoctorCheck): OwnerGuidance | null {
  if (isHealthy(check.status) || check.status === "Repairing") return null;
  if (check.fixable && !check.tried) return null;
  return {
    kind: "needs-owner",
    checkId: check.id,
    title: check.label,
    reason: (check.cause || check.detail || "This check is not healthy.").trim(),
    steps: stepsFor(check),
    retryable: true,
  };
}

/** The same text chat, voice and the Doctor panel use. */
export function formatGuidance(g: OwnerGuidance): string {
  return [
    g.title,
    g.reason,
    "",
    "What you need to do:",
    ...g.steps.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n");
}

export function enrichCheck(
  check: DoctorCheck,
  triedIds: ReadonlySet<string> = new Set(),
): DoctorCheck {
  const tried = Boolean(check.tried) || triedIds.has(check.id);
  const next: DoctorCheck = tried ? { ...check, tried: true } : { ...check };
  if (isHealthy(next.status)) return { ...next, repairKind: "none-needed", tried: false };
  if (next.fixable && !next.tried) {
    const rest: DoctorCheck = { ...next };
    delete rest.repairKind;
    return rest;
  }
  return { ...next, steps: stepsFor(next), repairKind: "needs-owner" };
}

class DoctorStore {
  private listeners = new Set<() => void>();
  private hydrated = false;
  private inflight: Promise<void> | null = null;
  /** Checks whose safe auto-repair already ran and did not clear the issue. */
  private triedIds = new Set<string>();

  state: DoctorState = {
    checks: [],
    log: [],
    scanning: false,
    mode: "idle",
    repairing: [],
    lastScanAt: null,
    lastDeep: false,
    durationMs: 0,
    rollbacks: [],
    desktop: false,
  };

  private snapshot = this.state;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    this.hydrate();
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    const extra = brainSurfaceChecks();
    const seen = new Set(this.state.checks.map((check) => check.id));
    const added = extra.filter((check) => !seen.has(check.id));
    this.snapshot = { ...this.state, checks: [...this.state.checks, ...added] };
    this.listeners.forEach((l) => l());
  }

  private push(level: DoctorLog["level"], line: string) {
    this.state.log = [{ id: uid("log"), at: clock(), level, line }, ...this.state.log].slice(
      0,
      300,
    );
  }

  log(level: DoctorLog["level"], line: string) {
    this.push(level, line);
    this.emit();
  }

  private hydrate() {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    this.state.desktop = Boolean(api()?.isDesktop);
    this.push(
      "info",
      this.state.desktop
        ? "doctor connected to the FRIDAY main process"
        : "browser preview — the local machine cannot be inspected from here",
    );
    api()?.onDiagnosticFixProgress?.((event) => {
      const phase = String(event.phase || "progress");
      const id = String(event.id || "repair");
      if (phase === "Repairing" && !this.state.repairing.includes(id)) {
        this.state.repairing = [...this.state.repairing, id];
      }
      if (phase === "Done" || phase === "Failed") {
        this.state.repairing = this.state.repairing.filter((row) => row !== id);
      }
      this.push(phase === "Failed" ? "error" : phase === "Done" ? "ok" : "info", `${id}: ${phase}`);
      for (const line of event.log || [])
        this.push(phase === "Failed" ? "warn" : "ok", `${id}: ${line}`);
      this.emit();
    });
    this.emit();
    void this.scan({ deep: false });
  }

  /** Run a scan. Concurrent calls reuse the in-flight run — no duplicate work. */
  async scan({ deep = false }: { deep?: boolean } = {}): Promise<void> {
    if (this.inflight) return this.inflight;
    const desktop = api();
    this.state.scanning = true;
    this.state.mode = deep ? "deep" : "quick";
    this.state.lastDeep = deep;
    this.push("info", `${deep ? "deep" : "quick"} diagnostic started`);
    this.emit();

    this.inflight = (async () => {
      if (!desktop?.runDiagnostics) {
        this.state.checks = [
          {
            id: "runtime",
            label: "Desktop runtime",
            group: "FRIDAY",
            status: "Warning",
            detail: "running in browser preview",
            cause: "System probing needs the packaged FRIDAY desktop app.",
            fix: "Build and install the EXE, then run the doctor there.",
            command: "npm run build:win",
          },
        ];
        this.state.durationMs = 0;
        this.push("warn", "no real system data available in the browser preview");
      } else {
        try {
          const result = await desktop.runDiagnostics({ deep });
          const previous = new Map(this.state.checks.map((c) => [c.id, c.status]));
          this.state.checks = result.checks.map((c) => ({
            ...c,
            ...(previous.has(c.id) && previous.get(c.id) !== c.status
              ? { before: previous.get(c.id) as DoctorStatus }
              : {}),
          }));
          this.state.durationMs = result.durationMs;
          const bad = result.checks.filter((c) => isProblem(c.status)).length;
          const warn = result.checks.filter((c) => isWarning(c.status)).length;
          this.push(
            bad ? "error" : warn ? "warn" : "ok",
            `scan finished in ${result.durationMs} ms — ${result.checks.length} checks · ${bad} problem(s) · ${warn} warning(s)`,
          );
          // A deep scan also re-runs the verified startup flow, so services
          // that died since boot are restarted and re-probed for real.
          if (deep) {
            const startup = await rerunStartup();
            if (startup) {
              this.push(
                startup.ready ? (startup.warnings.length ? "warn" : "ok") : "error",
                `startup flow re-verified — ${startup.state}${
                  startup.services.length
                    ? ` · ${startup.services.map((s) => `${s.name}: ${s.state}`).join(", ")}`
                    : ""
                }${startup.blockers.length ? ` · ${startup.blockers.join("; ")}` : ""}`,
              );
            }
          }
        } catch (err) {
          this.push("error", `diagnostic failed: ${(err as Error).message}`);
        }
      }
      // Cross-mode routing sync is a renderer-side truth: it compares what a
      // typed chat turn and an Auto Mode voice turn would really route to,
      // right now, from the same shared stores.
      this.state.checks = [
        ...this.state.checks,
        await this.crossModeCheck(),
        ...waveCapabilityChecks({ toggles: preferences.getSnapshot().toggles }),
        ...voiceLayerChecks(),
      ].map((check) => {
        const enriched = enrichCheck(check, this.triedIds);
        if (enriched.repairKind === "none-needed") this.triedIds.delete(check.id);
        return enriched;
      });
      this.state.lastScanAt = Date.now();
      this.state.scanning = false;
      this.state.mode = "idle";
      this.emit();
    })().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }

  /**
   * Real check: do chat, voice and Auto Mode still route through the same
   * model selection and the same connected-provider state? Drift is reported
   * exactly as measured; only drift that a re-read of the single source of
   * truth can clear is marked fixable.
   */
  private async crossModeCheck(): Promise<DoctorCheck> {
    try {
      const { inspectCrossModeSync } = await import("./cross-mode-sync");
      const sync = inspectCrossModeSync();
      const repairable = sync.drifts.some((d) => d.repairable);
      return {
        id: "cross-mode-sync",
        label: "Chat / voice / auto routing sync",
        group: "FRIDAY",
        status: sync.ok ? "Ready" : repairable ? "Warning" : "Error",
        detail: sync.detail,
        cause: sync.ok
          ? null
          : "one surface is reading a different model/provider state than the others",
        fix: sync.ok
          ? null
          : repairable
            ? "re-read the model registry (single source of truth) and re-measure"
            : "no safe automatic repair — reconcile the pinned models / route mode in the Models page",
        fixable: !sync.ok && repairable,
        meta: {
          chatModelIds: sync.chatModelIds,
          voiceModelIds: sync.voiceModelIds,
          routeMode: sync.routeMode,
          pinned: sync.pinned,
          drifts: sync.drifts,
        },
      };
    } catch (error) {
      return {
        id: "cross-mode-sync",
        label: "Chat / voice / auto routing sync",
        group: "FRIDAY",
        status: "Error",
        detail: `routing sync could not be measured: ${(error as Error).message}`,
        cause: "the routing stores could not be read from this build",
        fix: "run the doctor inside the FRIDAY desktop app",
        fixable: false,
      };
    }
  }

  /** Repair one check. Safe by design: risky repairs back files up first. */
  async fix(id: string): Promise<boolean> {
    if (this.state.repairing.includes(id)) return false;
    const desktop = api();
    const check = this.state.checks.find((c) => c.id === id);
    // The routing-sync repair is renderer-owned (it re-reads the shared
    // stores), so it works in the same way with or without the desktop fixer.
    if (id === "cross-mode-sync" && check) return this.repairCrossMode(check);
    if (id === "sense:watching" || id === "watch:learn" || id === "playbook:daily") {
      return this.repairWave(id);
    }
    if (!desktop?.applyDiagnosticFix || !check) {
      this.log("error", `no repair available for "${id}" outside the desktop app`);
      return false;
    }
    const before = check.status;
    this.state.repairing = [...this.state.repairing, id];
    check.status = "Repairing";
    this.push("info", `repairing ${check.label}…`);
    this.emit();

    let ok = false;
    try {
      const result = await desktop.applyDiagnosticFix(id);
      ok = result.ok;
      (result.log || []).forEach((line) =>
        this.push(ok ? "ok" : "warn", `${check.label}: ${line}`),
      );
      if (result.rollback?.length) {
        this.state.rollbacks = [
          { id: uid("rb"), checkId: id, at: Date.now(), entries: result.rollback },
          ...this.state.rollbacks,
        ].slice(0, 20);
        this.push("info", `${check.label}: rollback point saved`);
      }
      if (!ok && result.rollback?.length) {
        await this.rollback(this.state.rollbacks[0]!.id);
        this.push("warn", `${check.label}: repair failed — changes rolled back`);
      }
    } catch (err) {
      this.push("error", `${check.label}: ${(err as Error).message}`);
    }

    this.state.repairing = this.state.repairing.filter((x) => x !== id);
    check.before = before;
    if (ok) this.triedIds.delete(id);
    else this.triedIds.add(id);
    this.emit();
    await this.scan({ deep: false });
    const after = this.state.checks.find((c) => c.id === id);
    if (after) after.before = before;
    this.push(ok ? "ok" : "error", `${check.label}: ${before} → ${after?.status ?? "unknown"}`);
    if (ok) {
      if (after) after.repairKind = "auto-fixed";
    } else if (after) {
      const guidance = guidanceFor({ ...after, tried: true });
      if (guidance) {
        this.push(
          "warn",
          `${after.label}: automatic repair could not finish — here is what you need to do`,
        );
        guidance.steps.forEach((step, index) => this.push("info", `${index + 1}. ${step}`));
      }
    }
    this.emit();
    return ok;
  }

  /** Renderer repair for a sense, a recording, or the daily pack. No desktop probe. */
  private repairWave(id: string): boolean {
    const result = repairWaveCapability(id);
    if (!result.ok) {
      this.triedIds.add(id);
      this.push("warn", result.reason);
      this.emit();
      return false;
    }
    if (Object.keys(result.patch).length) {
      for (const [key, value] of Object.entries(result.patch)) preferences.setToggle(key, value);
    }
    const existing =
      this.state.checks.find((check) => check.id === id) ??
      this.snapshot.checks.find((check) => check.id === id);
    if (!existing) {
      this.push("error", `no repair available for "${id}"`);
      this.emit();
      return false;
    }
    const updated: DoctorCheck = {
      ...existing,
      status: "Ready",
      repairKind: "auto-fixed",
      detail: result.reason,
      fixable: false,
    };
    this.state.checks = this.state.checks.some((check) => check.id === id)
      ? this.state.checks.map((check) => (check.id === id ? updated : check))
      : [...this.state.checks, updated];
    this.triedIds.delete(id);
    this.push("ok", result.reason);
    this.emit();
    return true;
  }

  /** Force both surfaces back onto the single source of truth, then verify. */
  private async repairCrossMode(check: DoctorCheck): Promise<boolean> {
    const before = check.status;
    this.state.repairing = [...this.state.repairing, check.id];
    check.status = "Repairing";
    this.push("info", `repairing ${check.label}…`);
    this.emit();
    let ok = false;
    try {
      const { resyncModes } = await import("./cross-mode-sync");
      const result = await resyncModes();
      ok = result.ok;
      result.log.forEach((line) => this.push(ok ? "ok" : "warn", `${check.label}: ${line}`));
    } catch (error) {
      this.push("error", `${check.label}: ${(error as Error).message}`);
    }
    this.state.repairing = this.state.repairing.filter((x) => x !== check.id);
    if (ok) this.triedIds.delete(check.id);
    else this.triedIds.add(check.id);
    const measured = await this.crossModeCheck();
    const enriched = enrichCheck({ ...measured, before }, this.triedIds);
    this.state.checks = this.state.checks.map((c) => (c.id === check.id ? enriched : c));
    this.push(ok ? "ok" : "error", `${check.label}: ${before} → ${measured.status}`);
    if (!ok) {
      const guidance = guidanceFor(enriched);
      if (guidance) {
        this.push(
          "warn",
          `${enriched.label}: automatic repair could not finish — here is what you need to do`,
        );
        guidance.steps.forEach((step, index) => this.push("info", `${index + 1}. ${step}`));
      }
    }
    this.emit();
    return ok;
  }

  /** Repair every check that has a safe automated repair. */
  async fixAllSafe(): Promise<number> {
    const targets = this.state.checks.filter(
      (c) => c.fixable && !isHealthy(c.status) && !this.state.repairing.includes(c.id),
    );
    if (!targets.length) {
      this.log("info", "nothing to repair — no safe automated fixes are pending");
      return 0;
    }
    this.log("info", `safe auto fix — ${targets.length} repair(s) queued`);
    let fixed = 0;
    for (const t of targets) {
      // Sequential on purpose: repairs touch the same services/files.

      if (await this.fix(t.id)) fixed += 1;
    }
    this.log(fixed ? "ok" : "warn", `safe auto fix finished — ${fixed}/${targets.length} repaired`);
    this.announceOwnerGuidance();
    return fixed;
  }

  async fixSelected(ids: string[]): Promise<number> {
    let fixed = 0;
    for (const id of ids) {
      if (await this.fix(id)) fixed += 1;
    }
    return fixed;
  }

  async rollback(rollbackId: string): Promise<boolean> {
    const point = this.state.rollbacks.find((r) => r.id === rollbackId);
    const desktop = api();
    if (!point || !desktop?.rollbackDiagnosticFix) return false;
    const result = await desktop.rollbackDiagnosticFix(point.entries);
    (result.log || []).forEach((line) => this.push(result.ok ? "ok" : "error", line));
    this.state.rollbacks = this.state.rollbacks.filter((r) => r.id !== rollbackId);
    this.emit();
    return result.ok;
  }

  /** Auto diagnose: deep scan, then repair everything that is safe. */
  async autoDiagnose(): Promise<number> {
    this.state.mode = "auto";
    this.emit();
    await this.scan({ deep: true });
    return this.fixAllSafe();
  }

  /** Issues the owner must handle — the third outcome after auto-fix. */
  pendingOwnerGuidance(): OwnerGuidance[] {
    return this.state.checks
      .map((check) => guidanceFor(check))
      .filter((g): g is OwnerGuidance => Boolean(g));
  }

  private announceOwnerGuidance() {
    const pending = this.pendingOwnerGuidance();
    if (!pending.length) return;
    this.log("warn", `${pending.length} issue(s) need you — FRIDAY cannot safely auto-repair them`);
    for (const g of pending) {
      this.log("info", `${g.title}: ${g.reason}`);
      g.steps.forEach((step, index) => this.log("info", `${index + 1}. ${step}`));
    }
  }

  report(): string {
    const lines: string[] = [
      "# FRIDAY diagnostic report",
      "",
      `generated: ${new Date().toISOString()}`,
      `mode: ${this.state.desktop ? "desktop" : "browser preview"}`,
      `checks: ${this.state.checks.length} · duration: ${this.state.durationMs} ms`,
      "",
    ];
    const groups = [...new Set(this.state.checks.map((c) => c.group))];
    groups.forEach((group) => {
      lines.push(`## ${group}`, "");
      this.state.checks
        .filter((c) => c.group === group)
        .forEach((c) => {
          lines.push(`- [${c.status}] ${c.label} — ${c.detail}`);
          if (c.cause) lines.push(`    cause: ${c.cause}`);
          if (c.repairKind) lines.push(`    repair: ${c.repairKind}`);
          if (c.fix) lines.push(`    fix: ${c.fix}`);
          if (c.command) lines.push(`    command: ${c.command}`);
          (c.steps || []).forEach((step, index) => lines.push(`    ${index + 1}. ${step}`));
        });
      lines.push("");
    });
    lines.push("## Log", "");
    this.state.log.slice(0, 120).forEach((l) => lines.push(`${l.at} [${l.level}] ${l.line}`));
    return lines.join("\n");
  }

  clearLog(): void {
    this.state.log = [];
    this.push("info", "repair log cleared — checks and rollback points stay");
    this.emit();
  }

  async exportReport(): Promise<string | null> {
    const text = this.report();
    const desktop = api();
    if (desktop?.exportDiagnostics) {
      const file = await desktop.exportDiagnostics(text);
      this.log("ok", `report exported to ${file}`);
      return file;
    }
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `friday-diagnostics-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    this.log("ok", "report downloaded");
    return null;
  }
}

/** Brain surfaces that already hold real state — folded into Doctor, never invented. */
function brainSurfaceChecks(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  try {
    const failed = recentFailedStages(8);
    if (failed.length) {
      checks.push({
        id: "brain:turn-stages",
        label: "Chat turn stages",
        group: "Brain",
        status: "Warning",
        detail: failed
          .slice(0, 3)
          .map((row) => `${row.runId}/${row.stage}: ${row.extra ?? "failed"} (${row.ms}ms)`)
          .join("; "),
        cause: "A recorded chat stage timed out or failed.",
        fix: "Ask FRIDAY to propose a fix. Approval is required before any code change.",
        fixable: false,
      });
    }
  } catch {
    /* store may not be ready */
  }
  try {
    const drafts = recentSkillGapDrafts(8);
    if (drafts.length) {
      checks.push({
        id: "brain:skill-forge",
        label: "Skill-forge drafts",
        group: "Brain",
        status: "Ready",
        detail: `${drafts.length} draft(s) queued; none installed without owner approval.`,
        fixable: false,
      });
    }
  } catch {
    /* store may not be ready */
  }
  checks.push(...optionalDiagramChecks());
  checks.push(...desktopUiaChecks());
  checks.push(...localLlamaChecks());
  checks.push(...waveCapabilityChecks({ toggles: preferences.getSnapshot().toggles }));
  checks.push(...voiceLayerChecks());
  checks.push(...speechDoctorRows());
  checks.push(...toolchainDoctorRows());
  return checks;
}

/** Windows CPU pack for the local engine. The pin is in Install Manager. */
export function localLlamaChecks(): DoctorCheck[] {
  return [
    {
      id: "local:llama-cpp",
      label: "llama.cpp CPU pack",
      group: "Models",
      status: "Missing",
      detail:
        "Optional Windows CPU zip. Install Manager checks the pinned hash. CUDA and DirectML builds are not this pack. A live install was not checked here.",
      fix: "Install llama.cpp from Install Manager.",
      fixable: false,
    },
  ];
}

/** UI Automation helper. The tree normalizer does not need it. The live walker does. */
export function desktopUiaChecks(): DoctorCheck[] {
  return [
    {
      id: "desktop:uia",
      label: "UI Automation helper",
      group: "Desktop",
      status: "Missing",
      detail:
        "Optional Windows package. A fixture tree is normalized without it. Live window walking needs comtypes from Install Manager.",
      fix: "Install comtypes from Install Manager.",
      fixable: false,
    },
  ];
}

/** Optional diagram compilers. Core drawing does not need them. */
export function optionalDiagramChecks(): DoctorCheck[] {
  return [
    {
      id: "diagram:graphviz",
      label: "Graphviz compiler",
      group: "Diagrams",
      status: "Missing",
      detail:
        "Optional. The canvas draws with the bundled library. Install Manager can add the Windows compiler.",
      fix: "Install Graphviz from Install Manager.",
      fixable: false,
    },
    {
      id: "diagram:d2",
      label: "D2 compiler",
      group: "Diagrams",
      status: "Missing",
      detail: "Optional. D2 text export works without the compiler.",
      fix: "Install D2 from Install Manager.",
      fixable: false,
    },
  ];
}

export const doctor = new DoctorStore();

/**
 * Direct Setup & Doctor control from chat/voice. Does not steal
 * “what's wrong” / “diagnose yourself” — those stay inspectSelf.
 */
export function handleDoctorCommand(text: string): string | null {
  const message = text.trim().toLowerCase();
  if (
    /^(run (a )?(quick )?doctor( scan)?|quick doctor|scan now|scan the (system|machine))\b/.test(
      message,
    )
  ) {
    void doctor.scan({ deep: false });
    return "Quick Doctor scan started. Watch Setup & Doctor for live checks.";
  }
  if (/^(deep doctor|run (a )?deep doctor( scan)?)\b/.test(message)) {
    void doctor.scan({ deep: true });
    return "Deep Doctor scan started, including the startup flow.";
  }
  if (/^(auto diagnose|fix all safe( issues)?|safe auto fix)\b/.test(message)) {
    void doctor.autoDiagnose();
    return "Auto Diagnose started — deep scan, then every safe repair.";
  }
  if (/^(doctor (status|report)|what did the doctor find)\b/.test(message)) {
    const snap = doctor.getSnapshot();
    const problems = snap.checks.filter((check) => isProblem(check.status)).length;
    const warnings = snap.checks.filter((check) => isWarning(check.status)).length;
    if (!snap.checks.length) return "No Doctor scan has run yet. Say “quick doctor” to start one.";
    return [
      `Doctor ${snap.scanning ? "scanning" : "idle"} · ${snap.checks.length} checks · ${problems} problem(s) · ${warnings} warning(s)`,
      snap.desktop ? "live system" : "browser preview",
      ...snap.checks
        .filter((check) => isProblem(check.status) || isWarning(check.status))
        .slice(0, 8)
        .map((check) => `[${check.status}] ${check.label} — ${check.detail}`),
    ].join("\n");
  }
  if (/^(refresh( the)? doctor|re-?check( the doctor)?)\b/.test(message)) {
    const deep = doctor.getSnapshot().lastDeep;
    void doctor.scan({ deep });
    return `Refreshing the last ${deep ? "deep" : "quick"} Doctor scan.`;
  }
  if (/^(copy (the )?doctor( report)?|show (the )?doctor report)\b/.test(message)) {
    return doctor.report();
  }
  if (/^roll ?back (the )?(last )?(doctor |repair)/.test(message)) {
    const id = doctor.getSnapshot().rollbacks[0]?.id;
    if (!id) return "No Doctor rollback points are stored.";
    void doctor.rollback(id);
    return "Rolling back the last Doctor repair.";
  }
  return null;
}
