/**
 * FRIDAY · self-diagnosis
 *
 * The part of the brain that understands what is wrong with FRIDAY herself
 * and with the machine she runs on — and can say it out loud in her own words.
 *
 * Every problem reported here comes from a real store that already holds real
 * state (Setup & Doctor checks, the unified system map, the capability
 * registry, the model registry, the architecture index, sandbox verify, and
 * lint already tracked in AUDIT.md). Nothing is simulated: when a store has no
 * data yet, that is reported as "not inspected yet", never as healthy.
 *
 * Each detected problem is matched against FRIDAY's built-in expertise so the
 * report carries an actual fix, not just a red dot. Code fixes are never
 * applied from here — they are filed through the existing approval-gated
 * self-improvement pipeline.
 */

import { doctor, isProblem, isWarning, guidanceFor } from "../doctor-engine";
import { systemMap } from "../system-map";
import { capabilityRegistry } from "./capability-registry";
import { recentFailedStages, recentStageOutcomes } from "./turn-timing";
import { dependentsOf } from "./knowledge-graph";
import { recentSkillGapDrafts } from "./skill-forge";
import { modelRegistry } from "./model-registry";
import { searchExpertise, type ExpertiseEntry } from "./expertise";
import {
  readSource,
  selfBridgeAvailable,
  selfIndex,
  selfVerify,
  type IndexSummary,
  type VerifyResult,
} from "../self/maintenance-bridge";
import { governance } from "../self/governance";
import { runIntelligenceBenchmark } from "../self/intelligence-benchmark";
import { self } from "../self/self-manager";
import { devPipeline } from "../self/dev-pipeline";

export type SelfProblemSeverity = "critical" | "warning" | "info";

export type SelfProblem = {
  id: string;
  severity: SelfProblemSeverity;
  /** Which part of FRIDAY or the PC this concerns. */
  area: string;
  title: string;
  detail: string;
  /** Fix text taken from the source itself when it provides one. */
  fix?: string;
  /** Matching built-in knowledge, when FRIDAY recognises the problem. */
  knowledge?: ExpertiseEntry;
  /** Numbered owner steps from Doctor when auto-repair is not available. */
  steps?: string[];
};

export type CausalStageId =
  | "observe"
  | "collect-evidence"
  | "dependency-analysis"
  | "hypotheses"
  | "test-hypotheses"
  | "root-cause"
  | "impact"
  | "repair-options"
  | "safest-option"
  | "verify";

export type CausalHypothesis = {
  id: string;
  claim: string;
  tested: boolean;
  supported: boolean;
  evidence: string[];
  missing: string[];
};

export type CausalAnalysis = {
  at: number;
  stages: { id: CausalStageId; detail: string }[];
  hypotheses: CausalHypothesis[];
  rootCause: string | null;
  inconclusive: boolean;
  reason: string;
  impact: string[];
  repairOptions: { label: string; risk: "ask" }[];
  safest: string;
  verified: boolean;
};

export type SelfReport = {
  at: number;
  /** True when nothing needs attention right now. */
  healthy: boolean;
  /** False when no subsystem has been inspected yet (fresh boot / browser). */
  inspected: boolean;
  problems: SelfProblem[];
  /** Short factual lines about what is currently up. */
  facts: string[];
  /** Evidence-only causal pass for FRIDAY's own failures. */
  causal?: CausalAnalysis;
};

/** Last source-health inspection. Cheap for the sync `inspectSelf()` path. */
export type SourceHealthCache = {
  at: number;
  inspected: boolean;
  problems: SelfProblem[];
  fact: string;
  failing: string[];
};

export type SourceHealthSources = {
  index?: () => Promise<IndexSummary | null>;
  verify?: (areas?: string[]) => Promise<VerifyResult>;
  readText?: (relative: string) => Promise<string | null>;
};

export type SourceHealthOptions = {
  /**
   * Run the live sandbox verify (typecheck / lint / tests). Default is false
   * so a diagnosis never nests inside `npm test`. Pass true from the desktop
   * "find bugs in my source" path when a fresh sandbox run is wanted.
   */
  verify?: boolean;
  sources?: SourceHealthSources;
};

const AUDIT_FILE = "AUDIT.md";
const INDEX_FILE = "database/architecture-index.json";

/** Map entries the dedicated source-health check already covers. */
const SOURCE_MAP_IDS = new Set(["development/source-health", "development/index"]);

const inTestRunner = () =>
  typeof process !== "undefined" &&
  Boolean(process.env?.["VITEST"] || process.env?.["VITEST_WORKER_ID"]);

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const stripMd = (value: string) =>
  value.replace(/\*\*/g, "").replace(/`+/g, "").replace(/\s+/g, " ").trim();

let cachedSource: SourceHealthCache | null = null;
/** Last sandbox verify that actually produced checks (live run or pipeline). */
let lastVerify: VerifyResult | null = null;

/** Last source-health inspection, or null when it has never run. */
export const lastSourceHealth = (): SourceHealthCache | null => cachedSource;

const APPROVAL_NOTE =
  "I will not rewrite my own source. Any code change is filed as a self-improvement proposal and waits for your approval.";

const knowledgeFor = (query: string): ExpertiseEntry | undefined => searchExpertise(query, 1)[0];

/* ---------------------------------------------------------- source health */

function problemFromVerifyCheck(check: {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}): SelfProblem {
  const id = check.id.toLowerCase();
  const isType = id.includes("type");
  const isTest = id.includes("test");
  const isLint = id.includes("lint") || /eslint|prettier/i.test(`${check.label} ${check.detail}`);
  const title = `${check.label} failed`;
  const detail = stripMd(check.detail || `${check.label} reported a failure.`);
  const knowledge = knowledgeFor(`${check.label} ${check.detail}`);
  const steps = isType
    ? [
        "Run `npm run typecheck` and read the first real error (file, line, TS code).",
        "Fix that error — do not silence it, and do not touch unrelated files.",
        "Ask me to propose the patch as a self-improvement run. I sandbox-verify before you approve, and I never apply it on my own.",
      ]
    : isTest
      ? [
          "Run `npm test` and read the first failing assertion.",
          "Fix the production code or the test that no longer matches real behaviour.",
          "Ask me to propose the patch as a self-improvement run. I sandbox-verify before you approve, and I never apply it on my own.",
        ]
      : isLint
        ? [
            "Run `npm run lint` to list the current prettier/ESLint findings.",
            "Fix only files that belong to this change — do not mass-reformat `scripts/release-engine.cjs`.",
            "Ask me to propose the patch as a self-improvement run. I never apply a formatting sweep on my own.",
          ]
        : [
            "Read the sandbox check output and the file it names.",
            "Prepare a focused fix in the workspace.",
            "Ask me to run a self-improvement pass so the change goes through impact scan, sandbox verify, and your approval.",
          ];
  return {
    id: `source:verify:${check.id}`,
    severity: isType || isTest ? "critical" : "warning",
    area: "source",
    title,
    detail,
    fix: `${check.label} failed in the sandbox verify that self-improvement already uses. ${APPROVAL_NOTE}`,
    ...(knowledge ? { knowledge } : {}),
    steps,
  };
}

/**
 * Cooling-down models from the live overlay — real router cooldowns, never guessed.
 * They stay listed so diagnosis can name them; routing already skips them.
 */
export function problemsFromCoolingModels(
  records: { name: string; coolingDown?: boolean; healthCategory?: string | null }[],
): SelfProblem[] {
  const cooling = records.filter((record) => record.coolingDown);
  if (!cooling.length) return [];
  return [
    {
      id: "models:cooldown",
      severity: "warning",
      area: "models",
      title: `${cooling.length} model(s) in cooldown`,
      detail: cooling
        .slice(0, 4)
        .map(
          (record) => `${record.name}${record.healthCategory ? ` (${record.healthCategory})` : ""}`,
        )
        .join(", "),
      fix: "I will skip them and use another reachable model. Wait out the cooldown, or check the provider key / quota.",
    },
  ];
}

/**
 * Turn unresolved imports from the live architecture index into SelfProblems.
 * This is a fold of the existing index — not a second static analyser.
 */
export function problemsFromArchitectureIndex(
  index: IndexSummary | null | undefined,
): SelfProblem[] {
  const broken = index?.broken ?? [];
  if (!broken.length) return [];
  const sample = broken.slice(0, 8);
  const extra = broken.length > sample.length ? ` (+${broken.length - sample.length} more)` : "";
  const knowledge = knowledgeFor("unresolved import module not found");
  return [
    {
      id: "source:imports",
      severity: broken.length > 5 ? "critical" : "warning",
      area: "source",
      title: `${broken.length} unresolved import${broken.length === 1 ? "" : "s"}`,
      detail: `${sample.map((item) => `${item.file} → ${item.specifier}`).join("; ")}${extra}`,
      fix: `Correct the specifier or add the missing module. ${APPROVAL_NOTE}`,
      ...(knowledge ? { knowledge } : {}),
      steps: [
        "Open the listed file and make the import resolve (path, alias, or missing package).",
        "Re-index from Self-Management so the architecture index drops the broken edge.",
        "Ask me to propose the patch as a self-improvement run — I will sandbox-verify, then wait for your approval.",
      ],
    },
  ];
}

/**
 * Turn sandbox verify checks (typecheck / lint / tests / kernel) into
 * SelfProblems. Checks that passed are facts, not problems.
 */
export function problemsFromVerifyResult(verify: VerifyResult | null | undefined): SelfProblem[] {
  const checks = verify?.checks ?? [];
  return checks.filter((check) => !check.ok).map(problemFromVerifyCheck);
}

type AuditRow = { check: string; command: string; result: string };

/** Parse the verification-run table already maintained in AUDIT.md. */
export function parseAuditVerificationRows(text: string): AuditRow[] {
  const rows: AuditRow[] = [];
  if (!text) return rows;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const check = match[1].trim();
    if (/^check$/i.test(check) || /^-{2,}/.test(check)) continue;
    rows.push({ check, command: match[2].trim(), result: stripMd(match[3]) });
  }
  return rows;
}

const auditRowFailed = (result: string): boolean => {
  const lower = result.toLowerCase();
  if (!lower) return false;
  const positiveErrors = /(?:[1-9]\d*)\s+(prettier\s+)?errors?\b/.test(lower);
  const zeroErrors = /\b0\s+(prettier\s+)?errors?\b/.test(lower);
  if (
    (/\b(clean|passed|in sync|published|verified|success)\b/.test(lower) || zeroErrors) &&
    !positiveErrors
  ) {
    return false;
  }
  return positiveErrors || /\b(fail(?:ed|ure)?)\b/.test(lower);
};

/**
 * Lint / type / test findings already recorded in AUDIT.md — the project's
 * own tracked list, not a new analyser. Only the first Lint / Types / Tests
 * verification row counts (the dated table in §1). Later working-log tables
 * must not revive a cleared finding. Live sandbox verify, when it actually
 * ran a check, wins over a stale AUDIT row for the same check.
 */
export function problemsFromAuditText(
  text: string | null | undefined,
  liveIds: ReadonlySet<string> = new Set(),
): SelfProblem[] {
  if (!text) return [];
  const problems: SelfProblem[] = [];
  const seen = new Set<string>();
  for (const row of parseAuditVerificationRows(text)) {
    const key = row.check.toLowerCase();
    const isLint = key === "lint" || /eslint|prettier/.test(key);
    const isTypes = key === "types" || key === "typecheck";
    const isTests = key === "tests" || key === "test suite";
    if (!isLint && !isTypes && !isTests) continue;
    const liveId = isLint ? "lint" : isTypes ? "typecheck" : "tests";
    if (seen.has(liveId)) continue;
    seen.add(liveId);
    if (!auditRowFailed(row.result)) continue;
    if (liveIds.has(liveId)) continue;
    const knowledge = knowledgeFor(`${row.check} ${row.result} ${row.command}`);
    const title = isLint
      ? "Lint errors tracked in AUDIT.md"
      : isTypes
        ? "Typecheck failure tracked in AUDIT.md"
        : "Test failure tracked in AUDIT.md";
    const steps = isLint
      ? [
          `Run \`${row.command}\` to list the current prettier/ESLint findings.`,
          "Fix only files that belong to this change — do not mass-reformat `scripts/release-engine.cjs`.",
          "Ask me to propose the patch as a self-improvement run. I never apply a formatting sweep on my own.",
        ]
      : isTypes
        ? [
            `Run \`${row.command}\` and read the first real error.`,
            "Fix that error without silencing it or touching unrelated files.",
            "Ask me to propose the patch as a self-improvement run. I sandbox-verify, then wait for your approval.",
          ]
        : [
            `Run \`${row.command}\` and read the first failing assertion.`,
            "Fix the production code or the test that no longer matches real behaviour.",
            "Ask me to propose the patch as a self-improvement run. I sandbox-verify, then wait for your approval.",
          ];
    problems.push({
      id: `source:audit:${liveId}`,
      severity: isLint ? "warning" : "critical",
      area: "source",
      title,
      detail: `${row.command} — ${row.result}`,
      fix: isLint
        ? `AUDIT.md currently records lint failures (${row.result}). ${APPROVAL_NOTE}`
        : `AUDIT.md currently records a failing ${row.check} check. ${APPROVAL_NOTE}`,
      ...(knowledge ? { knowledge } : {}),
      steps,
    });
  }
  return problems;
}

function summarizeIndex(raw: unknown): IndexSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as {
    at?: number;
    root?: string;
    totals?: { files?: number; edges?: number; broken?: number };
    areas?: Record<string, number>;
    entryPoints?: string[];
    broken?: { file?: string; specifier?: string }[];
    externals?: unknown;
  };
  const broken = Array.isArray(value.broken)
    ? value.broken
        .filter(
          (item) => item && typeof item.file === "string" && typeof item.specifier === "string",
        )
        .map((item) => ({ file: String(item.file), specifier: String(item.specifier) }))
    : [];
  return {
    at: typeof value.at === "number" ? value.at : Date.now(),
    root: typeof value.root === "string" ? value.root : "",
    totals: {
      files: value.totals?.files ?? 0,
      edges: value.totals?.edges ?? 0,
      broken: value.totals?.broken ?? broken.length,
    },
    areas: value.areas ?? {},
    entryPoints: Array.isArray(value.entryPoints) ? value.entryPoints : [],
    broken,
    externals:
      typeof value.externals === "number"
        ? value.externals
        : Array.isArray(value.externals)
          ? value.externals.length
          : 0,
  };
}

async function defaultReadText(relative: string): Promise<string | null> {
  const bridged = await readSource(relative);
  if (bridged.ok) return bridged.text;
  return null;
}

function verifyFromPipeline(): VerifyResult | null {
  try {
    const run = devPipeline.getSnapshot().runs.find((item) => item.candidate?.checks?.length);
    if (!run?.candidate?.checks.length) return null;
    return { ok: run.candidate.ok, checks: run.candidate.checks };
  } catch {
    return null;
  }
}

function indexFromSelf(): IndexSummary | null {
  try {
    return self.getSnapshot().index ?? null;
  } catch {
    return null;
  }
}

function rememberSourceHealth(problems: SelfProblem[], inspected: boolean, extras: string[]): void {
  const failing = problems.map((problem) => problem.id);
  const fact =
    extras[0] ??
    (inspected
      ? problems.length
        ? `${problems.length} source-health finding(s).`
        : "Source health inspected — no source findings."
      : "Source health not inspected yet.");
  cachedSource = { at: Date.now(), inspected, problems, fact, failing };
  try {
    self.recordSourceHealth({
      at: cachedSource.at,
      inspected,
      problemCount: problems.length,
      detail: fact,
      failing,
    });
  } catch {
    /* self-manager is optional for unit folds */
  }
}

/**
 * Dedicated source-health inspection.
 *
 * Reuses the architecture index (self-maintenance) and the sandbox verify
 * already used by self-improvement. Does not invent a second static analyser.
 * Never writes files.
 */
export async function inspectSourceHealth(
  options: SourceHealthOptions = {},
): Promise<SelfProblem[]> {
  const sources = options.sources ?? {};
  const wantLiveVerify = Boolean(options.verify) && !inTestRunner();

  const index = await (async () => {
    if (sources.index) return sources.index();
    const live = await selfIndex(false);
    if (live) return live;
    const cached = indexFromSelf();
    if (cached) return cached;
    const raw = await (sources.readText ?? defaultReadText)(INDEX_FILE);
    if (!raw) return null;
    try {
      return summarizeIndex(JSON.parse(raw));
    } catch {
      return null;
    }
  })();

  let verify: VerifyResult | null;
  if (sources.verify) {
    verify = await sources.verify([]);
  } else if (wantLiveVerify && selfBridgeAvailable()) {
    verify = await selfVerify([]);
  } else {
    verify = lastVerify ?? verifyFromPipeline();
  }
  if (verify?.checks.length) lastVerify = verify;

  const auditText = await (sources.readText ?? defaultReadText)(AUDIT_FILE);

  const liveIds = new Set(
    (verify?.checks ?? []).filter((check) => !check.ok).map((check) => check.id.toLowerCase()),
  );

  const problems = [
    ...problemsFromArchitectureIndex(index),
    ...problemsFromVerifyResult(verify),
    ...problemsFromAuditText(auditText, liveIds),
  ];

  const facts: string[] = [];
  if (index) {
    facts.push(
      `Architecture index: ${index.totals.files} files · ${index.totals.broken} broken import(s).`,
    );
  }
  if (verify?.checks.length) {
    const failed = verify.checks.filter((check) => !check.ok).length;
    facts.push(
      `Sandbox verify: ${verify.checks.length - failed}/${verify.checks.length} check(s) passed.`,
    );
  }
  if (auditText) facts.push("AUDIT.md verification table was read.");
  const inspected = Boolean(index || (verify && verify.checks.length) || auditText);
  rememberSourceHealth(problems, inspected, facts);
  return problems;
}

export type SourceFixProposal = {
  id: string;
  stage: string;
  queued: boolean;
};

/**
 * File a source-health finding as a code-change proposal. Discovery never
 * writes files — `code-change` is always-ask, and apply only happens later
 * through the existing self-improvement / governance gate.
 */
export function proposeSourceFix(problem: SelfProblem): SourceFixProposal {
  const id = `gov:source:${problem.id}`;
  const existing = governance.get(id);
  if (existing) return { id: existing.id, stage: existing.stage, queued: false };
  const item = governance.discover({
    id,
    kind: "code-change",
    title: `Fix: ${problem.title}`,
    rationale: [problem.detail, problem.fix, ...(problem.steps ?? [])].filter(Boolean).join(" "),
    risk: problem.severity === "critical" ? "risky" : "review",
    evidence: [problem.id, problem.area, problem.detail],
  });
  return { id: item.id, stage: item.stage, queued: true };
}

/**
 * Root-cause pass for FRIDAY's own failures. Never guesses: one evidenced
 * finding can be named; competing unrelated findings stay inconclusive.
 * Repair is always an always-ask governance proposal — never auto-applied.
 */
export function analyzeOwnFailure(input: {
  problems: SelfProblem[];
  facts?: string[];
}): CausalAnalysis {
  const problems = input.problems ?? [];
  const stages: CausalAnalysis["stages"] = [];
  stages.push({
    id: "observe",
    detail: `${problems.length} finding(s) from live self-diagnosis stores`,
  });

  const evidence: string[] = [];
  for (const problem of problems) {
    if (problem.detail.trim()) evidence.push(`${problem.id}: ${problem.detail}`);
  }
  const failed = safe(() => recentFailedStages(8), []);
  for (const row of failed) {
    evidence.push(
      `stage ${row.stage}: ${row.extra ?? (row.timedOut ? "timed out" : "failed")} (${row.ms}ms)`,
    );
  }
  stages.push({
    id: "collect-evidence",
    detail: evidence.length ? `${evidence.length} evidence line(s)` : "no evidence collected",
  });

  const impact: string[] = [];
  const areas = [...new Set(problems.map((problem) => problem.area).filter(Boolean))];
  for (const area of areas) {
    try {
      for (const hop of dependentsOf(area)) {
        impact.push(`${hop.from} depends-on ${hop.to}`);
      }
    } catch {
      /* graph is optional */
    }
  }
  stages.push({
    id: "dependency-analysis",
    detail: impact.length ? impact.join("; ") : "no stored dependency edges for these areas",
  });

  const hypotheses: CausalHypothesis[] = problems.map((problem) => {
    const hasDetail = Boolean(problem.detail.trim());
    return {
      id: `h:${problem.id}`,
      claim: problem.title,
      tested: true,
      supported: hasDetail,
      evidence: hasDetail ? [problem.detail] : [],
      missing: hasDetail ? [] : ["no store detail — will not guess a cause"],
    };
  });
  stages.push({
    id: "hypotheses",
    detail: `${hypotheses.length} hypothes${hypotheses.length === 1 ? "is" : "es"} from findings`,
  });

  const supported = hypotheses.filter((item) => item.supported);
  stages.push({
    id: "test-hypotheses",
    detail: `${supported.length}/${hypotheses.length} supported by store evidence`,
  });

  let rootCause: string | null = null;
  let inconclusive = true;
  let reason = "no evidenced failure to explain";
  const areasOf = (items: CausalHypothesis[]) =>
    new Set(
      items
        .map((item) => problems.find((problem) => `h:${problem.id}` === item.id)?.area)
        .filter(Boolean),
    );

  if (supported.length === 1) {
    rootCause = supported[0]!.claim;
    inconclusive = false;
    reason = "single finding with store evidence";
  } else if (supported.length > 1 && areasOf(supported).size === 1) {
    const ranked = problems
      .filter((problem) => supported.some((item) => item.id === `h:${problem.id}`))
      .sort((a, b) => {
        const order: Record<SelfProblemSeverity, number> = { critical: 0, warning: 1, info: 2 };
        return order[a.severity] - order[b.severity];
      });
    rootCause = ranked[0]?.title ?? null;
    inconclusive = !rootCause;
    reason = rootCause
      ? "multiple findings in one area; naming the most severe evidenced one"
      : "findings in one area but none could be named";
  } else if (supported.length > 1) {
    reason =
      "multiple independent findings in different areas — will not pick a single root cause without more evidence";
  }

  stages.push({
    id: "root-cause",
    detail: inconclusive ? `inconclusive: ${reason}` : `evidenced: ${rootCause}`,
  });
  stages.push({
    id: "impact",
    detail: impact.length ? impact.join("; ") : "no dependents recorded",
  });

  const repairOptions = problems
    .map((problem) => problem.fix)
    .filter((fix): fix is string => Boolean(fix))
    .filter((fix, index, all) => all.indexOf(fix) === index)
    .map((label) => ({ label, risk: "ask" as const }));
  stages.push({
    id: "repair-options",
    detail: repairOptions.length
      ? `${repairOptions.length} owner-facing option(s)`
      : "no stored fix text",
  });

  const safest =
    "File a proposal through the existing governance gate (always-ask). Do not auto-apply.";
  stages.push({ id: "safest-option", detail: safest });

  const verified = evidence.length > 0 || problems.length === 0;
  stages.push({
    id: "verify",
    detail: verified
      ? "analysis used only live store evidence"
      : "no evidence — analysis stays inconclusive",
  });

  return {
    at: Date.now(),
    stages,
    hypotheses,
    rootCause,
    inconclusive,
    reason,
    impact,
    repairOptions,
    safest,
    verified,
  };
}

/** Inspects every real source and returns FRIDAY's current self-assessment. */
export function inspectSelf(): SelfReport {
  const problems: SelfProblem[] = [];
  const facts: string[] = [];
  let inspected = false;
  const sourceInspected = Boolean(cachedSource?.inspected);

  // 1. Setup & Doctor — the machine-level truth.
  const doc = safe(() => doctor.getSnapshot(), null);
  if (doc && doc.checks.length) {
    inspected = true;
    for (const check of doc.checks) {
      if (!isProblem(check.status) && !isWarning(check.status)) continue;
      const query = `${check.label} ${check.detail} ${check.cause ?? ""}`;
      const guidance = guidanceFor(check);
      const knowledge = searchExpertise(query, 1)[0];
      const steps = guidance?.steps ?? check.steps ?? knowledge?.steps;
      problems.push({
        id: `doctor:${check.id}`,
        severity: isProblem(check.status) ? "critical" : "warning",
        area: check.group || "environment",
        title: `${check.label} — ${check.status}`,
        detail: check.detail || check.cause || "No detail reported.",
        ...(guidance?.reason && !check.fix
          ? { fix: guidance.reason }
          : check.fix
            ? { fix: check.fix }
            : {}),
        ...(knowledge ? { knowledge } : {}),
        ...(steps?.length ? { steps } : {}),
      });
    }
    const ready = doc.checks.filter((c) => c.status === "Ready" || c.status === "Running").length;
    facts.push(`${ready}/${doc.checks.length} environment checks healthy.`);
  }

  // 2. Unified system map — FRIDAY's own subsystems.
  const map = safe(() => systemMap.getSnapshot(), null);
  if (map && map.entries.length) {
    inspected = true;
    for (const entry of map.entries) {
      if (entry.status !== "missing" && entry.status !== "degraded") continue;
      // Dedicated source-health check owns these — skip the generic map fold.
      if (sourceInspected && SOURCE_MAP_IDS.has(entry.id)) continue;
      if (entry.id === "development/source-health") continue;
      const query = `${entry.label} ${entry.detail}`;
      problems.push({
        id: `map:${entry.id}`,
        severity: entry.status === "missing" ? "critical" : "warning",
        area: entry.group,
        title: `${entry.label} is ${entry.status}`,
        detail: entry.detail || "No detail reported.",
        ...(searchExpertise(query, 1)[0] ? { knowledge: searchExpertise(query, 1)[0]! } : {}),
      });
    }
    facts.push(`FRIDAY v${map.version} (${map.build}) on ${map.platform}.`);
  }

  // 3. Models — being mute is a real problem worth naming first.
  const models = safe(() => modelRegistry.available(), []);
  if (models.length === 0) {
    problems.push({
      id: "models:none",
      severity: "warning",
      area: "models",
      title: "No model is reachable",
      detail:
        "I can still handle everything my own brain covers, but anything open-ended needs a model.",
      fix: "Install Ollama and pull a local model, or add a free provider key in Models → Providers.",
      ...(searchExpertise("connect model provider ollama", 1)[0]
        ? { knowledge: searchExpertise("connect model provider ollama", 1)[0]! }
        : {}),
    });
  } else {
    facts.push(`${models.length} model(s) routable right now.`);
  }

  const coolingProblems = problemsFromCoolingModels(safe(() => modelRegistry.list(), []));
  if (coolingProblems.length) {
    inspected = true;
    problems.push(...coolingProblems);
  }

  // 4. Capabilities — tools/skills that are installed but offline.
  const caps = safe(() => capabilityRegistry.getSnapshot(), null);
  if (caps && caps.resources.length) {
    inspected = true;
    const offline = caps.resources.filter((r) => r.health === "offline");
    if (offline.length) {
      problems.push({
        id: "capabilities:offline",
        severity: "info",
        area: "capabilities",
        title: `${offline.length} capability/capabilities are offline`,
        detail: offline
          .slice(0, 5)
          .map((r) => `${r.name} (${r.type})`)
          .join(", "),
        fix: "Re-verify them in Friday Hub, or reinstall the pack that owns them.",
      });
    }
    facts.push(`${caps.availableCount}/${caps.resources.length} capabilities available.`);
  }

  // 5. Source health — architecture index, sandbox verify, AUDIT.md tracking.
  if (cachedSource?.inspected) {
    inspected = true;
    problems.push(...cachedSource.problems);
    if (cachedSource.fact) facts.push(cachedSource.fact);
  }

  // 6. Recent chat-stage failures (turn-timing / withDeadline) — real outcomes only.
  const failedStages = safe(() => recentFailedStages(8), []);
  if (failedStages.length) {
    inspected = true;
    problems.push({
      id: "brain:turn-stages",
      severity: "warning",
      area: "brain",
      title: `${failedStages.length} recent chat stage(s) failed or timed out`,
      detail: failedStages
        .slice(0, 4)
        .map((row) => `${row.runId}/${row.stage}: ${row.extra ?? "failed"} (${row.ms}ms)`)
        .join("; "),
      fix: "I will not guess a silent fix. Ask me to propose a change — it waits for your approval.",
    });
    facts.push(`Turn stages: ${failedStages.length} recorded failure(s).`);
  } else {
    const seen = safe(() => recentStageOutcomes(1), []);
    if (seen.length) facts.push("Turn stages: no recorded failures in the recent buffer.");
  }

  // 7. Skill-forge gap drafts — queued, never self-installed.
  const drafts = safe(() => recentSkillGapDrafts(8), []);
  if (drafts.length) {
    inspected = true;
    facts.push(
      `Skill-forge drafts: ${drafts.length} queued (install still requires owner approval).`,
    );
  }

  // 8. New surfaces from the one capability registry (interact / forge / charts).
  if (caps && caps.resources.length) {
    const extras = caps.resources.filter((resource) =>
      ["web-interact", "skill-forge", "stage-chart"].includes(resource.ref),
    );
    if (extras.length) {
      facts.push(`Upgrade surfaces: ${extras.map((resource) => resource.ref).join(", ")}.`);
    }
  }

  const order: Record<SelfProblemSeverity, number> = { critical: 0, warning: 1, info: 2 };
  problems.sort((a, b) => order[a.severity] - order[b.severity]);

  const causal = analyzeOwnFailure({ problems, facts });

  facts.push(
    typeof runIntelligenceBenchmark === "function"
      ? "Intelligence-fabric benchmark is loaded (not executed on inspect — it mutates stores)."
      : "Intelligence-fabric benchmark is missing.",
  );

  return {
    at: Date.now(),
    healthy: problems.length === 0,
    inspected,
    problems,
    facts,
    causal,
  };
}

/**
 * Async full inspection: refresh source health (cheap path — no nested
 * sandbox test run) then fold every real store.
 */
export async function inspectSelfComplete(options: SourceHealthOptions = {}): Promise<SelfReport> {
  await inspectSourceHealth({ verify: false, ...options });
  return inspectSelf();
}

/** How FRIDAY says the report out loud. Honest when she hasn't looked yet. */
export function describeSelfReport(report: SelfReport): string {
  const lines: string[] = [];

  if (!report.inspected) {
    lines.push(
      "I haven't inspected the machine in this session yet — open Setup & Doctor and run a scan, and I'll report on real checks instead of guessing.",
    );
  }

  if (report.problems.length === 0) {
    lines.push(
      report.inspected
        ? "Nothing is flagged on my side right now."
        : "Nothing flagged from what I can see so far.",
    );
  } else {
    const critical = report.problems.filter((p) => p.severity === "critical").length;
    const warnings = report.problems.filter((p) => p.severity === "warning").length;
    lines.push(
      `I'm tracking ${report.problems.length} issue${report.problems.length === 1 ? "" : "s"}` +
        `${critical ? `, ${critical} critical` : ""}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}:`,
    );
    for (const problem of report.problems.slice(0, 5)) {
      lines.push(`• [${problem.severity}] ${problem.title} — ${problem.detail}`);
      if (problem.steps?.length) {
        lines.push("  What you need to do:");
        problem.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
      } else {
        const fix = problem.fix ?? problem.knowledge?.steps?.[0];
        if (fix) lines.push(`  Fix: ${fix}`);
      }
      if (problem.knowledge?.source) lines.push(`  Source: ${problem.knowledge.source}`);
    }
    if (report.problems.length > 5) {
      lines.push(`…and ${report.problems.length - 5} more in Setup & Doctor.`);
    }
  }

  if (report.facts.length) lines.push("", report.facts.join(" "));
  if (report.causal) {
    if (report.causal.inconclusive) {
      lines.push(`Causal analysis: inconclusive — ${report.causal.reason}`);
    } else if (report.causal.rootCause) {
      lines.push(`Root cause (evidenced): ${report.causal.rootCause}`);
    }
  }
  return lines.join("\n");
}

export type RecoveryKind =
  | "retry"
  | "fallback"
  | "switch-model"
  | "switch-capability"
  | "research"
  | "replan"
  | "ask"
  | "stop";

export type RecoveryChoice = {
  kind: RecoveryKind;
  reason: string;
};

/**
 * Choose a recovery from existing signals. Never blindly retries a dangerous
 * action. Not a second recovery engine — callers still go through governance.
 */
export function chooseRecovery(input: {
  failure: string;
  dangerous?: boolean;
  attempts?: number;
  modelAvailable?: boolean;
  capabilityAvailable?: boolean;
  stale?: boolean;
  contradicted?: boolean;
  incomplete?: boolean;
  timeout?: boolean;
}): RecoveryChoice {
  const attempts = input.attempts ?? 0;
  if (input.dangerous) {
    return {
      kind: "stop",
      reason: "destructive/system action failed — stop and ask; never blind-retry",
    };
  }
  if (input.contradicted) {
    return { kind: "ask", reason: "contradictory evidence — owner must decide, not auto-resolve" };
  }
  if (input.stale) {
    return { kind: "research", reason: "information looks stale — research rather than reuse" };
  }
  if (input.modelAvailable === false) {
    return { kind: "switch-model", reason: "current model unavailable — switch specialist" };
  }
  if (input.capabilityAvailable === false) {
    return {
      kind: "switch-capability",
      reason: "capability unavailable — use another existing path",
    };
  }
  if (input.incomplete || input.timeout) {
    return { kind: "replan", reason: "execution incomplete — replan remaining work" };
  }
  if (attempts >= 2) {
    return { kind: "fallback", reason: "already retried — fall back instead of looping" };
  }
  if (/\b(timeout|temporar|429|unavailable)\b/i.test(input.failure) && attempts < 2) {
    return { kind: "retry", reason: "transient failure — one bounded retry" };
  }
  return { kind: "fallback", reason: "failure detected — use a safer existing path" };
}
