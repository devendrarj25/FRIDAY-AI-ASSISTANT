/**
 * FRIDAY · autonomous core worker
 *
 * The background half of FRIDAY's brain: it watches her own health and her own
 * project, researches what it does not know (only from allowed sources) and
 * files every possible improvement into the governance queue.
 *
 * It never applies anything itself — it discovers, analyses and proposes; the
 * approval gate in `governance.ts` decides what actually happens. The loop is
 * idle-driven and cheap: one timer, respecting the owner's `idleCycleMinutes`,
 * skipped while FRIDAY is busy. Health / project / research still wait for
 * autonomy to be on; enabled agents are planned on the same timer in Manual
 * idle and Auto Mode, and still only apply through the approval queue.
 *
 * Observe → understand → plan → authorize → act → monitor → verify → recover
 * → learn. "Act" here means filing a proposal; destructive/system actions
 * never skip governance.
 */

export const AUTONOMY_LOOP = [
  "observe",
  "understand",
  "plan",
  "authorize",
  "act",
  "monitor",
  "verify",
  "recover",
  "learn",
] as const;

import { doctor, isProblem, type DoctorCheck } from "../doctor-engine";
import { browserAvailable, webSearch } from "../browser-engine";
import { autonomy } from "./autonomy";
import { governance, type GovRisk } from "./governance";
import { ledger } from "./task-ledger";
import { selfBridgeAvailable, selfHealth } from "./maintenance-bridge";
import { desktopAgentHost, reviewEnabledAgents, type AgentSchedulerHost } from "./agent-scheduler";
import { dispatchPluginHook } from "../plugin-hooks";

export type CoreCycle = {
  at: number;
  discovered: number;
  researched: number;
  note: string;
};

export type CoreState = {
  running: boolean;
  cycles: CoreCycle[];
  lastCycleAt: number;
  health: { id: string; label: string; ok: boolean; detail: string }[];
};

const MAX_CYCLES = 20;

class AutonomousCore {
  private state: CoreState = { running: false, cycles: [], lastCycleAt: 0, health: [] };
  private snapshot: CoreState = this.state;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private agentHost: AgentSchedulerHost | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = {
      ...this.state,
      cycles: [...this.state.cycles],
      health: [...this.state.health],
    };
    this.listeners.forEach((l) => l());
  }

  start(): void {
    if (this.timer || typeof window === "undefined") return;
    this.state.running = true;
    const minutes = Math.max(5, autonomy.getSnapshot().idleCycleMinutes);
    this.timer = setInterval(() => void this.cycle(), minutes * 60_000);
    this.emit();
    // First pass shortly after boot, once the UI has settled.
    setTimeout(() => void this.cycle(), 8_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state.running = false;
    this.emit();
  }

  /** Tests inject a host so plan()/run() can run without Electron IPC. */
  setAgentHost(host: AgentSchedulerHost | null): void {
    this.agentHost = host;
  }

  /** One idle pass: enabled agents → (when autonomy is on) health → project → research. */
  async cycle(): Promise<CoreCycle | null> {
    const settings = autonomy.getSnapshot();
    if (this.busy) return null;
    const active = ledger.list().filter((t) => t.status === "running").length;
    if (active >= settings.maxConcurrentTasks) return null;

    this.busy = true;
    let discovered = 0;
    let researched = 0;
    try {
      // Same timer in Manual idle and Auto Mode. Agents always plan; they never
      // apply without the existing governance approval path.
      discovered += await this.checkAgents();
      if (settings.autonomyEnabled) {
        discovered += await this.checkHealth();
        discovered += await this.reviewProject();
        researched = await this.research(settings.researchDepth);
      }
    } finally {
      this.busy = false;
    }

    const cycle: CoreCycle = {
      at: Date.now(),
      discovered,
      researched,
      note: discovered
        ? `${discovered} improvement(s) queued for approval`
        : settings.autonomyEnabled
          ? "no new work — FRIDAY is healthy"
          : "idle agent pass — no actionable plans",
    };
    this.state.cycles = [cycle, ...this.state.cycles].slice(0, MAX_CYCLES);
    this.state.lastCycleAt = cycle.at;
    this.emit();
    dispatchPluginHook("on-idle", {
      at: cycle.at,
      discovered: cycle.discovered,
      researched: cycle.researched,
      note: cycle.note,
    });
    return cycle;
  }

  /* -------------------------------------------------------------- agents */

  /** Plan enabled agents on this idle tick; file actionable work for approval. */
  async checkAgents(): Promise<number> {
    return reviewEnabledAgents(this.agentHost ?? desktopAgentHost());
  }

  /* -------------------------------------------------------------- health */

  /** Continuous health: core, models, runtimes, database, bridge. */
  async checkHealth(): Promise<number> {
    const checks: CoreState["health"] = [];
    const doc = doctor.getSnapshot();
    const problems = (doc.checks ?? []).filter((c: DoctorCheck) => isProblem(c.status));

    checks.push({
      id: "diagnostics",
      label: "Environment",
      ok: problems.length === 0,
      detail: doc.checks?.length
        ? `${problems.length} problem(s) across ${doc.checks.length} checks`
        : "not diagnosed yet",
    });

    if (selfBridgeAvailable()) {
      const health = await selfHealth();
      checks.push({
        id: "core",
        label: "Core runtime",
        ok: Boolean(health?.ok),
        detail: health?.detail ?? "no response from the desktop core",
      });
    }

    const failures = ledger
      .list()
      .filter(
        (t) =>
          Date.now() - t.startedAt < 3_600_000 && (t.status === "failed" || t.status === "timeout"),
      );
    checks.push({
      id: "tasks",
      label: "Task health",
      ok: failures.length < 2,
      detail: `${failures.length} failed task(s) in the last hour`,
    });

    this.state.health = checks;
    this.emit();

    let queued = 0;
    for (const check of problems.slice(0, 5)) {
      queued += this.propose({
        id: `gov:repair:${check.id}`,
        kind: "repair",
        title: `Repair ${check.label}`,
        rationale: check.detail || `${check.label} reported ${check.status}.`,
        risk: check.fixable ? "safe" : "review",
        evidence: [`doctor/${check.id} → ${check.status}`, check.fix ?? ""].filter(Boolean),
      });
    }
    if (failures.length >= 2) {
      queued += this.propose({
        id: `gov:learn:${new Date().toISOString().slice(0, 10)}`,
        kind: "code-change",
        title: "Study repeated task failures and store a working pattern",
        rationale:
          "Several tasks failed in the last hour. FRIDAY can read the failure logs, reproduce them in the sandbox and propose a fix instead of repeating the mistake.",
        risk: "safe",
        evidence: failures.slice(0, 4).map((f) => `${f.kind}: ${f.title} — ${f.error ?? f.status}`),
      });
    }
    return queued;
  }

  /* ------------------------------------------------------------- project */

  /** Reads FRIDAY's own architecture index, sandbox verify cache, and AUDIT.md. */
  async reviewProject(): Promise<number> {
    const { inspectSourceHealth, proposeSourceFix } = await import("../brain/self-diagnosis");
    const problems = await inspectSourceHealth({ verify: false });
    let queued = 0;
    for (const problem of problems) {
      queued += proposeSourceFix(problem).queued ? 1 : 0;
    }
    return queued;
  }

  /* ------------------------------------------------------------ research */

  /**
   * Looks up what FRIDAY is missing. Searching is read-only, but every result
   * she wants to *use* is filed as an approval-gated item first.
   */
  async research(depth: number): Promise<number> {
    const settings = autonomy.getSnapshot();
    if (!settings.researchEnabled || !browserAvailable()) return 0;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;

    const topics = this.researchTopics().slice(0, Math.max(1, depth));
    let count = 0;
    for (const topic of topics) {
      const response = await webSearch(topic.query, 5);
      if (!response.ok) continue;
      const allowed = response.results.filter((r) => autonomy.allowsSource(r.url));
      if (!allowed.length) continue;
      count += 1;
      this.propose({
        id: `gov:research:${topic.id}`,
        kind: "research",
        title: `Learn: ${topic.title}`,
        rationale: `${topic.reason} FRIDAY found ${allowed.length} allowed source(s) and can read them, extract the steps and propose the change.`,
        risk: "review",
        evidence: allowed.slice(0, 3).map((r) => `${r.title} — ${r.url}`),
      });
    }
    return count;
  }

  private researchTopics(): { id: string; query: string; title: string; reason: string }[] {
    const doc = doctor.getSnapshot();
    const problems = (doc.checks ?? []).filter((c: DoctorCheck) => isProblem(c.status));
    return problems.slice(0, 4).map((check) => ({
      id: check.id,
      query: `${check.label} ${check.status} windows fix ${check.cause ?? ""}`.trim(),
      title: check.label,
      reason: `${check.label} is ${check.status}: ${check.detail || "no local fix known yet"}.`,
    }));
  }

  /* ----------------------------------------------------------- proposals */

  private propose(input: {
    id: string;
    kind: Parameters<typeof governance.discover>[0]["kind"];
    title: string;
    rationale: string;
    risk: GovRisk;
    evidence: string[];
  }): number {
    const before = governance.get(input.id);
    if (before) return 0;
    governance.discover(input);
    return 1;
  }

  /** Tests and self-knowledge: this worker never applies, only proposes. */
  appliesDirectly(): boolean {
    return false;
  }
}

export const autonomousCore = new AutonomousCore();
