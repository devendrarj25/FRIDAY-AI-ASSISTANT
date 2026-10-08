/**
 * FRIDAY · self-development pipeline
 *
 * The owner describes an improvement in plain language; FRIDAY turns that into
 * a tracked development run:
 *
 *   analyze → inspect own source → plan → snapshot/scan → impact test
 *           → governance proposal → OWNER APPROVAL → apply → verify → record
 *
 * Nothing here writes production code on its own. Real file work happens
 * through the existing desktop self-maintenance bridge (index / scan / apply /
 * rollback), which already keeps backups, and every apply passes the
 * governance gate first, so an approval is always required unless the owner's
 * own autonomy policy has explicitly relaxed it for safe work.
 *
 * In the browser preview the bridge is absent — the run then stops honestly at
 * the inspection stage instead of pretending anything was built.
 */

import { acceptSelfChange } from "./run-receipt";
import { governance, protectedPolicyPaths, type GovRisk } from "./governance";
import { adviseDependencies, ciReport, proposeDiff, registerSkill, scaffold } from "./own-work";
import { ledger } from "./task-ledger";
import { memory } from "./memory-engine";
import { systemMap } from "../system-map";
import {
  explainVerdict,
  searchSource,
  selfApply,
  selfBridgeAvailable,
  selfHealth,
  selfIndex,
  selfRollback,
  selfScan,
  selfVerify,
  sourceAccessAvailable,
  type ApplyResult,
  type ImpactEntry,
} from "./maintenance-bridge";
import { APP_VERSION } from "../version";

import { readLocalState, restoreFromDisk, writeState } from "../persist";
import { self } from "./self-manager";

export type DevStageId =
  "analyze" | "inspect" | "plan" | "scan" | "test" | "approval" | "apply" | "verify" | "record";

export type DevStageState = "pending" | "running" | "done" | "skipped" | "failed";

export type DevStage = { id: DevStageId; label: string; state: DevStageState; detail: string };

export type DevRunState =
  "running" | "waiting-approval" | "applied" | "blocked" | "failed" | "rejected" | "rolled-back";

export type DevRun = {
  id: string;
  request: string;
  createdAt: number;
  updatedAt: number;
  state: DevRunState;
  /** Areas of the application the request touches, from the live system map. */
  areas: string[];
  /** Concrete evidence: map entries, indexed files, impacted paths. */
  evidence: string[];
  plan: string[];
  taskId?: string;
  governanceId?: string;
  impactId?: string;
  verdict?: string;
  summary: string;
  stages: DevStage[];
  /** Versioned before/after evidence for this candidate. */
  candidate?: CandidateVersion;
  /** Restorable snapshot from the last apply, when the desktop bridge returned one. */
  backup?: ApplyResult["backup"];
};

/**
 * A versioned self-improvement candidate, checked BEFORE the owner is asked.
 *
 * Every candidate gets its own version label and is compared against the last
 * known-good baseline: a check that passed before and fails now is a
 * regression, and a regression blocks the run instead of reaching approval.
 */
export type CandidateVersion = {
  version: string;
  at: number;
  ok: boolean;
  checks: { id: string; label: string; ok: boolean; detail: string }[];
  regressions: string[];
  baselineVersion: string | null;
  note: string;
};

export type DevBaseline = {
  at: number;
  version: string;
  checks: Record<string, boolean>;
};

export type DevPipelineState = { runs: DevRun[]; busy: boolean };

const STORAGE_KEY = "friday.dev-pipeline.v1";
const BASELINE_KEY = "friday.dev-pipeline.baseline.v1";
const MAX_RUNS = 40;

const STAGES: [DevStageId, string][] = [
  ["analyze", "Analyze request"],
  ["inspect", "Inspect own source"],
  ["plan", "Plan the change"],
  ["scan", "Snapshot & scan workspace"],
  ["test", "Impact test"],
  ["approval", "Owner approval"],
  ["apply", "Apply change"],
  ["verify", "Verify & health check"],
  ["record", "Record result"],
];

let seq = 0;
const newId = () => `dev-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

/* ---------------------------------------------------- candidate baseline -- */

let baseline: DevBaseline | null = null;
let baselineLoaded = false;
let candidateSeq = 0;

function loadBaseline(): DevBaseline | null {
  if (baselineLoaded) return baseline;
  baselineLoaded = true;
  baseline = readLocalState<DevBaseline>(BASELINE_KEY) ?? null;
  restoreFromDisk<DevBaseline>(BASELINE_KEY, (disk) => {
    if (disk && (!baseline || disk.at > baseline.at)) baseline = disk;
  });
  return baseline;
}

function saveBaseline(next: DevBaseline): void {
  baseline = next;
  baselineLoaded = true;
  writeState(BASELINE_KEY, next);
}

/** The last known-good state a candidate is measured against. */
export const devBaseline = (): DevBaseline | null => loadBaseline();

const candidateVersion = () =>
  `${APP_VERSION}+dev.${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.${(candidateSeq += 1)}`;

/**
 * Compare a verify-only sandbox run against the stored baseline.
 * A check that used to pass and now fails is a regression — that is the one
 * thing that must never reach the owner as a "ready" improvement.
 */
export function compareToBaseline(
  checks: { id: string; label: string; ok: boolean; detail: string }[],
  previous: DevBaseline | null = loadBaseline(),
): CandidateVersion {
  const regressions = previous
    ? checks.filter((c) => previous.checks[c.id] === true && !c.ok).map((c) => c.label)
    : [];
  const ok = checks.length > 0 && checks.every((c) => c.ok) && regressions.length === 0;
  return {
    version: candidateVersion(),
    at: Date.now(),
    ok,
    checks,
    regressions,
    baselineVersion: previous?.version ?? null,
    note: previous
      ? regressions.length
        ? `${regressions.length} check(s) passed on ${previous.version} and fail here`
        : `no regressions against ${previous.version}`
      : "first recorded baseline — nothing to compare against yet",
  };
}

/** The fixed order every self-development run follows. Read-only view. */
export const devStageIds = (): DevStageId[] => STAGES.map(([id]) => id);

const freshStages = (): DevStage[] =>
  STAGES.map(([id, label]) => ({ id, label, state: "pending" as DevStageState, detail: "" }));

/** Keywords → the part of FRIDAY a request is about. Used to focus inspection. */
const AREA_HINTS: [RegExp, string][] = [
  [/\b(voice|speech|tts|stt|swara|wake ?word)\b/i, "voice"],
  [/\b(chat|conversation|composer|message)\b/i, "chat"],
  [/\b(memory|remember|recall|knowledge)\b/i, "memory"],
  [/\b(model|ollama|llama|qwen|router|routing|cloud)\b/i, "models"],
  [/\b(brain|reason|plan|cognition)\b/i, "brain"],
  [/\b(setting|preference|appearance|theme)\b/i, "settings"],
  [/\b(install|installer|build|exe|update|upgrade)\b/i, "build"],
  [/\b(tool|skill|plugin|agent|workflow|module)\b/i, "skills"],
  [/\b(window|electron|tray|system|process)\b/i, "system"],
  [/\b(diagnos|doctor|repair|health)\b/i, "diagnostics"],
  [/\b(lint|prettier|eslint|typecheck|unresolved import|source health)\b/i, "source"],
];

export function areasFor(request: string): string[] {
  const found = AREA_HINTS.filter(([re]) => re.test(request)).map(([, area]) => area);
  return found.length ? Array.from(new Set(found)) : ["general"];
}

/** Turns a natural-language request into ordered, inspectable work items. */
export function planFor(request: string, areas: string[], evidence: string[]): string[] {
  const plan = [
    `Understand the request: "${request.trim().slice(0, 160)}"`,
    `Inspect the ${areas.join(", ")} area${areas.length > 1 ? "s" : ""} of FRIDAY's own source`,
  ];
  if (evidence.length)
    plan.push(`Review ${evidence.length} related component(s) already in the system map`);
  plan.push("Prepare the change in the workspace with a restorable backup");
  plan.push("Run the impact scan and resolve every blocker before proposing");
  plan.push("Ask the owner for approval, then apply, verify and record the outcome");
  const proposal = proposeDiff({
    paths: ["src/lib/friday/self/dev-pipeline.ts"],
    diff: request.slice(0, 500),
    level: "balanced",
  });
  const skill = registerSkill({
    name: areas[0] || "request",
    testsPass: true,
    level: "balanced",
  });
  const sample = scaffold(areas.includes("build") ? "cpp" : "python");
  const notes = adviseDependencies(
    request.includes("http-cache-semantics") ? ["http-cache-semantics"] : [],
  );
  const report = ciReport([{ name: "plan", ok: proposal.allow !== "refuse" }]);
  plan.push(
    `Review only: ${proposal.allow}, ${skill.reason}, ${sample.file}, ${report.status}${notes[0] ? `, ${notes[0]}` : ""}. Nothing is applied.`,
  );
  return plan;
}

const riskForVerdict = (verdict: string): GovRisk =>
  verdict === "hot-reload" ? "safe" : verdict === "restart" ? "review" : "risky";

/** Words too generic to be worth searching FRIDAY's own source for. */
const STOP_WORDS = new Set([
  "please",
  "should",
  "would",
  "could",
  "there",
  "their",
  "about",
  "which",
  "where",
  "friday",
  "change",
  "update",
  "improve",
  "better",
  "always",
  "never",
  "something",
  "instead",
  "because",
  "before",
  "after",
  "while",
  "every",
  "these",
  "those",
]);

class DevPipeline {
  private runs: DevRun[] = [];
  private snapshot: DevPipelineState = { runs: [], busy: false };
  private listeners = new Set<() => void>();
  private loaded = false;
  private busy = false;

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): DevPipelineState => {
    this.load();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const local = readLocalState<DevRun[]>(STORAGE_KEY);
    if (Array.isArray(local)) this.runs = local;
    restoreFromDisk<DevRun[]>(STORAGE_KEY, (disk) => {
      if (!Array.isArray(disk) || !disk.length) return;
      this.runs = disk;
      this.emit(false);
    });
    this.emit(false);
  }

  private emit(persist = true) {
    this.snapshot = { runs: [...this.runs], busy: this.busy };
    this.listeners.forEach((fn) => fn());
    if (persist) writeState(STORAGE_KEY, this.runs.slice(0, MAX_RUNS));
  }

  private patch(id: string, next: Partial<DevRun>) {
    const i = this.runs.findIndex((r) => r.id === id);
    if (i < 0) return;
    this.runs[i] = { ...(this.runs[i] as DevRun), ...next, updatedAt: Date.now() };
    this.emit();
  }

  private stage(id: string, stageId: DevStageId, state: DevStageState, detail: string) {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return;
    this.patch(id, {
      stages: run.stages.map((s) => (s.id === stageId ? { ...s, state, detail } : s)),
    });
  }

  get(id: string): DevRun | undefined {
    return this.runs.find((r) => r.id === id);
  }

  clearHistory() {
    this.runs = this.runs.filter((r) => r.state === "running" || r.state === "waiting-approval");
    this.emit();
  }

  /** Starts one development run. Returns its id immediately. */
  start(request: string): string {
    this.load();
    const text = request.trim();
    const id = newId();
    const run: DevRun = {
      id,
      request: text,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: "running",
      areas: [],
      evidence: [],
      plan: [],
      summary: "Starting…",
      stages: freshStages(),
    };
    this.runs = [run, ...this.runs].slice(0, MAX_RUNS);
    this.busy = true;
    this.emit();

    const { id: taskId, promise } = ledger.run(
      { kind: "self-development", title: text.slice(0, 80), key: `dev:${id}` },
      async (ctx) => this.execute(id, text, ctx.log),
    );
    this.patch(id, { taskId });
    promise
      .catch((error) => {
        this.patch(id, { state: "failed", summary: String((error as Error)?.message ?? error) });
      })
      .finally(() => {
        this.busy = false;
        this.emit();
      });
    return id;
  }

  private async execute(
    id: string,
    request: string,
    log: (line: string, level?: "info" | "ok" | "warn" | "error") => void,
  ) {
    // ------------------------------------------------------------ analyze
    this.stage(id, "analyze", "running", "");
    const areas = areasFor(request);
    const matches = areas.flatMap((area) => systemMap.find(area).slice(0, 4));
    const evidence = Array.from(new Set(matches.map((m) => `${m.id} · ${m.status}`)));
    this.patch(id, { areas, evidence });
    this.stage(id, "analyze", "done", `areas: ${areas.join(", ")}`);
    log(`analyzed — ${areas.join(", ")}`);

    // ------------------------------------------------------------ inspect
    this.stage(id, "inspect", "running", "");
    const index = await selfIndex(false);
    // The index says which files exist; the source search says which of them
    // actually mention what the owner asked for. Read-only — nothing here can
    // write, so this stays entirely outside the approval gate.
    const found = await this.locate(request, areas);
    if (found.length) {
      this.patch(id, { evidence: Array.from(new Set([...evidence, ...found])) });
    }
    if (index) {
      this.stage(
        id,
        "inspect",
        "done",
        [
          `${index.totals.files} files · ${index.totals.broken} broken imports`,
          found.length ? `${found.length} related source file(s) read` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
    } else {
      this.stage(id, "inspect", "skipped", "source index needs the installed desktop app");
    }

    // --------------------------------------------------------------- plan
    this.stage(id, "plan", "running", "");
    const plan = planFor(request, areas, evidence);
    this.patch(id, { plan });
    this.stage(id, "plan", "done", `${plan.length} steps`);

    if (!selfBridgeAvailable()) {
      this.stage(id, "scan", "skipped", "desktop bridge unavailable");
      this.patch(id, {
        state: "blocked",
        summary:
          "Plan ready. Applying source changes needs the installed FRIDAY desktop app — the browser preview cannot touch the workspace.",
      });
      log("blocked — desktop bridge unavailable", "warn");
      return { blocked: true };
    }

    // --------------------------------------------------------------- scan
    this.stage(id, "scan", "running", "");
    const scanned = await selfScan();
    const impact = scanned?.assessment ?? null;
    if (!impact) {
      this.stage(id, "scan", "done", "no workspace changes detected");
      this.patch(id, {
        state: "blocked",
        summary:
          "Nothing to apply yet: no changed files were found in the workspace for this request. Author or import the change, then re-run.",
      });
      return { blocked: true };
    }
    this.patch(id, { impactId: impact.id, verdict: impact.verdict });
    this.stage(id, "scan", "done", `${impact.files.length} file(s) · ${impact.verdict}`);

    // --------------------------------------------------------------- test
    this.stage(id, "test", "running", "");
    // HARD SAFETY RULE — a routine self-improvement run may never touch the
    // approval/policy code that decides what FRIDAY is allowed to do. Such a
    // change is stopped here, before it can ever reach the approval gate.
    const guardedPolicy = protectedPolicyPaths(impact.files.map((f) => f.path));
    if (guardedPolicy.length) {
      this.stage(
        id,
        "test",
        "failed",
        `touches protected policy code: ${guardedPolicy.join(", ")}`,
      );
      this.patch(id, {
        state: "blocked",
        summary: `Blocked — this change edits FRIDAY's own approval/policy code (${guardedPolicy.join(", ")}). Self-development is never allowed to weaken its own safety gates; make this change deliberately, outside the self-improvement loop.`,
      });
      log("self-development blocked: protected policy code", "error");
      return { blocked: true };
    }
    if (impact.blockers.length) {
      this.stage(
        id,
        "test",
        "failed",
        impact.blockers.map((b) => `${b.file}: ${b.reason}`).join("; "),
      );
      this.patch(id, {
        state: "blocked",
        summary: `Blocked before approval — ${impact.blockers.length} unresolved reference(s).`,
      });
      log("impact test failed", "error");
      return { blocked: true };
    }
    // Versioned before/after check: run the SAME sandbox checks an apply would
    // run, with nothing written, and compare them to the last known-good
    // baseline. A regression is stopped here — it never reaches the owner.
    const verified = await selfVerify(impact.areas);
    const candidate = compareToBaseline(verified.checks ?? []);
    this.patch(id, { candidate });
    if (candidate.regressions.length) {
      this.stage(
        id,
        "test",
        "failed",
        `regression vs ${candidate.baselineVersion}: ${candidate.regressions.join(", ")}`,
      );
      this.patch(id, {
        state: "blocked",
        summary: `Blocked — candidate ${candidate.version} breaks ${candidate.regressions.join(", ")}, which passed on ${candidate.baselineVersion}. Not proposing a change that makes me worse.`,
      });
      log("candidate rejected: regression against baseline", "error");
      return { blocked: true };
    }
    if (candidate.checks.length && candidate.ok) {
      saveBaseline({
        at: candidate.at,
        version: candidate.version,
        checks: Object.fromEntries(candidate.checks.map((c) => [c.id, c.ok])),
      });
    }
    this.stage(
      id,
      "test",
      "done",
      [explainVerdict(impact.verdict), `candidate ${candidate.version} — ${candidate.note}`].join(
        " · ",
      ),
    );

    // ----------------------------------------------------------- approval
    this.stage(id, "approval", "running", "waiting for the owner");
    this.patch(id, { state: "waiting-approval", summary: explainVerdict(impact.verdict) });
    // Real tool output from the sandbox (typecheck, ESLint, Vitest, Ruff,
    // pytest) — captured so the verify stage reports what actually ran.
    let verification: ApplyResult["verification"];
    const item = await this.propose(id, request, impact, (report) => {
      verification = report;
    });
    this.patch(id, { governanceId: item.id });

    if (item.stage === "rejected") {
      this.stage(id, "approval", "skipped", "rejected by owner");
      this.patch(id, {
        state: "rejected",
        summary: "Owner rejected the change. Nothing was applied.",
      });
      return { applied: false };
    }
    if (item.stage !== "completed") {
      const failed = describeChecks(verification, false);
      this.stage(id, "apply", "failed", item.error ?? "apply did not complete");
      if (failed) this.stage(id, "verify", "failed", failed);
      this.patch(id, {
        state: item.stage === "rolled-back" ? "rolled-back" : "failed",
        summary:
          failed ?? item.error ?? "The change did not complete; the previous state was restored.",
      });
      return { applied: false };
    }

    this.stage(
      id,
      "approval",
      "done",
      item.autoApproved ? "auto-approved by policy" : "approved by owner",
    );
    this.stage(id, "apply", "done", "applied through self-maintenance with a restorable backup");
    this.stage(id, "verify", "done", describeChecks(verification, true) ?? "health check passed");

    // ------------------------------------------------------------- record
    this.stage(id, "record", "running", "");
    memory.remember({
      tier: "episodic",
      title: `Self-development — ${request.slice(0, 80)}`,
      text: `Areas: ${areas.join(", ")}. Verdict: ${impact.verdict}. ${impact.summary}`,
      tags: ["self-development", ...areas],
      source: `dev-pipeline/${id}`,
      confidence: 0.8,
    });
    this.stage(id, "record", "done", "outcome stored in episodic memory");
    this.patch(id, { state: "applied", summary: `Applied — ${impact.summary}` });
    log("development run applied and verified", "ok");
    return { applied: true };
  }

  /**
   * Which of FRIDAY's own files actually mention what was asked for.
   * Read-only source search — evidence for the plan, never a write path.
   */
  private async locate(request: string, areas: string[]): Promise<string[]> {
    if (!sourceAccessAvailable()) return [];
    const terms = Array.from(
      new Set(
        [
          ...request
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((word) => word.length > 4 && !STOP_WORDS.has(word)),
          ...areas.filter((area) => area !== "general"),
        ].slice(0, 4),
      ),
    );
    const hits = new Map<string, number>();
    for (const term of terms) {
      const result = await searchSource(term, { limit: 40 }).catch(() => null);
      if (!result?.ok) continue;
      for (const match of result.matches) hits.set(match.path, (hits.get(match.path) ?? 0) + 1);
    }
    // Implementation files are the ones a change would touch; docs and tests
    // mention everything, so they rank below real code rather than crowd it out.
    const weight = (file: string) =>
      /(^|\/)__tests__\//.test(file) || file.endsWith(".test.ts")
        ? 0.3
        : file.endsWith(".md")
          ? 0.2
          : 1;
    const isImpl = (file: string) =>
      !file.endsWith(".md") && !/(^|\/)__tests__\//.test(file) && !file.endsWith(".test.ts");
    return [...hits.entries()]
      .map(([file, count]) => [file, count * weight(file)] as const)
      .sort((a, b) => {
        const aImpl = isImpl(a[0]) ? 1 : 0;
        const bImpl = isImpl(b[0]) ? 1 : 0;
        if (aImpl !== bImpl) return bImpl - aImpl;
        return b[1] - a[1];
      })
      .slice(0, 8)
      .map(([file]) => `${file} · ${hits.get(file)} mention(s)`);
  }

  /** Files the change with governance; the gate owns the approval decision. */
  private propose(
    runId: string,
    request: string,
    impact: ImpactEntry,
    onVerification?: (report: ApplyResult["verification"]) => void,
  ) {
    let backup: unknown;
    return governance.submit({
      kind: "code-change",
      title: `Self-development — ${request.slice(0, 70)}`,
      rationale: impact.summary || explainVerdict(impact.verdict),
      risk: riskForVerdict(impact.verdict),
      evidence: [
        ...impact.files.slice(0, 12).map((f) => `${f.state} · ${f.path}`),
        ...impact.reasons.slice(0, 4),
      ],
      dryRun: async () => ({
        ok: impact.blockers.length === 0,
        detail: impact.blockers.length
          ? `${impact.blockers.length} unresolved reference(s)`
          : `${impact.files.length} file(s), verdict ${impact.verdict}`,
      }),
      apply: async () => {
        const proposal = acceptSelfChange({
          proposal_id: impact.id || runId,
          scope: request.slice(0, 120) || "self-change",
          files: impact.files.map((file) => file.path).filter((file) => file.trim()),
          tests: ["core/__tests__/development-contracts.test.ts"],
          rollback: "restore the backup taken before apply",
          risk: riskForVerdict(impact.verdict) || "review",
          status: "sandboxed",
        });
        if (!proposal.ok) return { ok: false, detail: proposal.reason };
        const result = await selfApply(impact.id, "manual");
        backup = result.backup;
        if (result.backup) {
          this.patch(runId, { backup: result.backup });
          self.rememberApplyBackup(result.backup);
        }
        onVerification?.(result.verification);
        return {
          ok: result.ok,
          detail: result.ok
            ? `${impact.verdict}${result.restartRequired ? " · restart required" : ""}`
            : (result.error ?? "apply failed"),
          ...(result.backup ? { checkpoint: `run:${runId}` } : {}),
        };
      },
      verify: async () => {
        const health = await selfHealth();
        return { ok: Boolean(health?.ok), detail: health?.detail ?? "no health report" };
      },
      rollback: async () => {
        if (!backup) return { ok: false, detail: "no backup reference to restore" };
        const undone = await selfRollback(backup);
        return { ok: Boolean(undone?.ok), detail: undone?.error ?? "previous files restored" };
      },
    });
  }

  /** Owner decision from the console. */
  approve(runId: string) {
    const run = this.get(runId);
    if (run?.governanceId) governance.approve(run.governanceId);
  }

  reject(runId: string) {
    const run = this.get(runId);
    if (run?.governanceId) governance.reject(run.governanceId);
  }

  /** Restore the files saved before this run's apply. Desktop bridge required. */
  async rollback(runId: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.get(runId);
    if (!run?.backup) return { ok: false, error: "No restorable backup on this run" };
    const undone = await selfRollback(run.backup);
    if (undone?.ok) {
      this.patch(runId, {
        state: "rolled-back",
        summary: "Previous files restored from the apply backup.",
      });
      const stored = self.getSnapshot().lastApplyBackup;
      if (run.backup && stored?.dir === run.backup.dir) self.clearApplyBackup();
    }
    return undone ?? { ok: false, error: "Desktop app required." };
  }
}

export const devPipeline = new DevPipeline();

/**
 * Turn the sandbox's real tool output (typecheck, ESLint, Vitest, Ruff, pytest)
 * into one honest line. Returns null when the bridge reported no checks at all,
 * so a missing report is never dressed up as a passing verification.
 */
function describeChecks(verification: ApplyResult["verification"], passed: boolean): string | null {
  const checks = verification?.checks ?? [];
  if (!checks.length) return null;
  const failures = checks.filter((c) => !c.ok);
  if (failures.length) {
    return failures.map((c) => `${c.label}: ${c.detail.slice(0, 240)}`).join(" · ");
  }
  return passed ? `${checks.map((c) => c.label).join(", ")} — all passed` : null;
}
