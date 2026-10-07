/**
 * FRIDAY · workflow forge and pack runner
 *
 * Same lifecycle skill-forge / plugin-forge already give those types: plan →
 * coder writes a workflow.json with real step refs → sandbox verify (manifest
 * smoke) → owner approval → installPack(). Stages are real steps — nothing is
 * marked done that did not run.
 *
 * A forged workflow stays disabled until the owner enables it.
 * Test / chat walk the declared steps through existing skill/tool/agent/module
 * /connector invoke paths. Write/exec steps stay dry-run unless the owner
 * approved a real run. A missing connector fails honestly.
 */

import { brainKnowledge } from "./knowledge-base";
import { identity } from "./identity";
import { planPipeline, recordStep, type Pipeline } from "./orchestrator";
import { governance, type GovAction, type GovItem } from "../self/governance";
import { learning } from "../self/learning-engine";
import kernelApi from "../kernel-api";
import { isDesktopApp } from "../desktop";
import { listCapabilities } from "../capability-trees";
import { invokeSkill } from "./skill-forge";
import { invokeToolPack } from "./tool-forge";
import { invokeModulePack } from "./module-forge";
import { planAgent, runAgent } from "../agent-runtime";
import {
  connectorTools,
  invokeApprovedConnectorAction,
  listConnectors,
  type ConnectorTool,
} from "../connectors";

export type WorkflowForgeStage =
  "planning" | "writing" | "verifying" | "installing" | "done" | "failed";

export type WorkflowStepKind = "skill" | "tool" | "agent" | "module" | "connector" | "note";

export type WorkflowStep = {
  id: string;
  label: string;
  kind: WorkflowStepKind;
  ref: string;
  risk: "safe" | "write" | "exec";
  /** Absent on every pack shipped before schema 2. The runner then stays sequential. */
  when?: "always" | "previous-ok" | "previous-failed";
  parallel?: string;
  loopMax?: number;
  onError?: "stop" | "continue";
  approvesSelf?: boolean;
  /** What must be true after the step. A playbook step always has one. */
  postcondition?: string;
  /** How a reversible step is undone. A move always has one. */
  undo?: string;
};

export type WorkflowForgeRun = {
  id: string;
  goal: string;
  stage: WorkflowForgeStage;
  attempts: number;
  pipeline: Pipeline | null;
  workflowId: string | null;
  log: { at: number; text: string; ok: boolean }[];
  error?: string;
};

export type WorkflowPackWrite = {
  tree: "workflows";
  segment: string;
  slug: string;
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  permissions: string[];
  risk: "safe" | "write" | "exec";
  schedule: string;
  steps: WorkflowStep[];
  inputs: string[];
  enabled: false;
};

export type WorkflowInstallResult = {
  ok: boolean;
  id?: string;
  path?: string;
  error?: string;
};

export type WorkflowSandboxResult = {
  ok: boolean;
  error?: string;
  output?: string;
  mode?: string;
};

export type WorkflowPackManifest = {
  id: string;
  name: string;
  description: string;
  category: string;
  schedule: string;
  steps: WorkflowStep[];
  risk: "safe" | "write" | "exec";
  enabled: boolean;
  origin?: "app" | "workspace";
};

export type WorkflowStepResult = {
  id: string;
  label: string;
  kind: WorkflowStepKind;
  ref: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
  value?: unknown;
};

export type WorkflowRunResult = {
  ok: boolean;
  id: string;
  name: string;
  steps: WorkflowStepResult[];
  error?: string;
};

export type WorkflowForgeHost = {
  complete?: (
    messages: { role: string; content: string }[],
    modelIds?: string[],
  ) => Promise<{ ok?: boolean; text?: string; error?: string } | null>;
  installPack: (pack: WorkflowPackWrite) => Promise<WorkflowInstallResult>;
  sandboxVerify: (pack: WorkflowPackWrite) => Promise<WorkflowSandboxResult>;
  submit?: (action: GovAction) => Promise<GovItem>;
};

export type WorkflowRunHost = {
  list?: () => Promise<WorkflowPackManifest[]>;
  invokeSkill?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<{ ok?: boolean; error?: string; value?: unknown; ms?: number }>;
  invokeTool?: (
    id: string,
    input?: unknown,
    options?: { allowDisabled?: boolean },
  ) => Promise<{ ok?: boolean; error?: string; value?: unknown; ms?: number }>;
  planAgent?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<{ ok?: boolean; error?: string; value?: unknown }>;
  runAgent?: (
    id: string,
    input?: Record<string, unknown>,
    options?: { allowDisabled?: boolean },
  ) => Promise<{ ok?: boolean; error?: string; value?: unknown }>;
  invokeModule?: (
    id: string,
    input?: unknown,
    options?: { allowDisabled?: boolean },
  ) => Promise<{ ok?: boolean; error?: string; value?: unknown; ms?: number }>;
  listConnectors?: () => Promise<{ id: string; name: string; connected: boolean }[]>;
  connectorTools?: () => ConnectorTool[];
  invokeConnector?: (
    tool: ConnectorTool,
    params?: Record<string, unknown>,
  ) => Promise<{ ok?: boolean; error?: string; value?: unknown }>;
};

type WorkflowBridge = {
  installCapability?: (pack: WorkflowPackWrite) => Promise<WorkflowInstallResult>;
  verifyCapability?: (id: string) => Promise<{
    ok: boolean;
    error?: string;
    mode?: string;
    status?: string;
  }>;
  uninstallCapability?: (id: string) => Promise<{ ok: boolean; error?: string }>;
};

const DESKTOP_ONLY =
  "Workflows live in the FRIDAY workspace — open the desktop app to forge or run them.";

const STEP_KINDS = new Set<WorkflowStepKind>([
  "skill",
  "tool",
  "agent",
  "module",
  "connector",
  "note",
]);

export const BLANK_WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: "inspect",
    label: "Inspect local filenames",
    kind: "note",
    ref: "inspect",
    risk: "safe",
  },
  {
    id: "summarise",
    label: "Summarise findings locally",
    kind: "note",
    ref: "summarise",
    risk: "safe",
  },
  {
    id: "record",
    label: "Keep the plan in a local note — no publish",
    kind: "note",
    ref: "record",
    risk: "safe",
  },
];

export type WorkflowStepCatalogEntry = {
  kind: WorkflowStepKind;
  id: string;
  name: string;
  risk: "safe" | "write" | "exec";
};

const TREE_KIND: Partial<Record<string, WorkflowStepKind>> = {
  skills: "skill",
  tools: "tool",
  agents: "agent",
  modules: "module",
};

const bridge = (): WorkflowBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.friday as unknown as WorkflowBridge | undefined);

export const workflowForgeAvailable = (): boolean =>
  Boolean(isDesktopApp() && bridge()?.installCapability && bridge()?.verifyCapability);

function slug(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 5)
      .join("-") || `workflow-${Date.now().toString(36)}`
  );
}

function slugId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || slug(value)
  );
}

export function normalizeWorkflowSteps(raw: unknown): WorkflowStep[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw.map((item, index) => {
    if (typeof item === "string") {
      const label = String(item).trim() || `step-${index + 1}`;
      return {
        id: `s${index + 1}`,
        label,
        kind: "note" as const,
        ref: label,
        risk: "safe" as const,
      };
    }
    const rec = (item || {}) as Record<string, unknown>;
    const kindRaw = String(rec["kind"] || "");
    const kind = STEP_KINDS.has(kindRaw as WorkflowStepKind)
      ? (kindRaw as WorkflowStepKind)
      : "note";
    const riskRaw = rec["risk"];
    const risk = riskRaw === "write" || riskRaw === "exec" ? riskRaw : ("safe" as const);
    const label = String(rec["label"] || rec["name"] || rec["ref"] || `step-${index + 1}`).trim();
    const whenRaw = rec["when"];
    const when =
      whenRaw === "previous-ok" || whenRaw === "previous-failed" || whenRaw === "always"
        ? whenRaw
        : undefined;
    const loopMax = Number(rec["loopMax"]);
    return {
      id: String(rec["id"] || `s${index + 1}`).trim() || `s${index + 1}`,
      label,
      kind,
      ref: String(rec["ref"] || rec["id"] || label).trim(),
      risk,
      ...(when ? { when } : {}),
      ...(typeof rec["parallel"] === "string" && rec["parallel"]
        ? { parallel: String(rec["parallel"]).slice(0, 40) }
        : {}),
      ...(Number.isFinite(loopMax) && loopMax > 1
        ? { loopMax: Math.min(8, Math.floor(loopMax)) }
        : {}),
      ...(rec["onError"] === "continue" || rec["onError"] === "stop"
        ? { onError: rec["onError"] }
        : {}),
      ...(rec["approvesSelf"] === true ? { approvesSelf: true } : {}),
      ...(typeof rec["postcondition"] === "string" && rec["postcondition"].trim()
        ? { postcondition: String(rec["postcondition"]).trim().slice(0, 240) }
        : {}),
      ...(typeof rec["undo"] === "string" && rec["undo"].trim()
        ? { undo: String(rec["undo"]).trim().slice(0, 240) }
        : {}),
    };
  });
}

const DELETE_STEP = /\b(delete|rmdir|unlink|remove file)\b/i;
const SEND_STEP = /\b(send|submit)\b/i;

/** A daily playbook may move and draft. It does not delete, and it does not send by itself. */
export function checkPlaybook(steps: WorkflowStep[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!steps.length) reasons.push("empty");
  for (const step of steps) {
    const blob = `${step.label} ${step.ref} ${step.postcondition || ""} ${step.undo || ""}`;
    if (!step.postcondition) reasons.push(`${step.id}:postcondition`);
    if (DELETE_STEP.test(blob)) reasons.push(`${step.id}:delete`);
    if (/\bmove\b/i.test(step.label) && !step.undo) reasons.push(`${step.id}:undo`);
    if (SEND_STEP.test(step.label) && (step.risk !== "write" || step.approvesSelf === true)) {
      reasons.push(`${step.id}:approval`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

const FORGE_PROMPT = (goal: string, previousError?: string) =>
  [
    identity.compile(),
    "",
    "You are writing one of your own workflows — a workflow.json pack of sequential steps.",
    "Return ONLY JSON (no markdown commentary). Required fields:",
    '{"name":"...","slug":"...","description":"...","schedule":"on demand","risk":"safe","steps":[{"id":"s1","label":"...","kind":"note","ref":"...","risk":"safe"}]}',
    "kind must be skill, tool, agent, module, connector, or note.",
    "Prefer 6 to 10 steps. Use real FRIDAY capability ids when you know them (skills/custom/..., agents/core/..., tools/filesystem/..., modules/developer/...).",
    "WordPress publish/edit is connector.wordpress.publish / connector.wordpress.edit. Shopify pages are connector.shopify.publish-page / connector.shopify.edit-page. X/Twitter, Instagram, Facebook and LinkedIn posting use those connectors' post actions. Write/exec steps must set risk write or exec.",
    "Write/exec steps must set risk write or exec. Default risk is safe.",
    "",
    `Goal: ${goal}`,
    previousError ? `\nThe previous attempt failed:\n${previousError}\nFix the JSON.` : "",
  ]
    .filter(Boolean)
    .join("\n");

function extractJson(text: string): unknown {
  const trimmed = String(text || "").trim();
  const fenced = /```(?:json|js|javascript)?\s*([\s\S]*?)```/.exec(trimmed);
  const raw = String(fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("the coder model did not return JSON");
  }
}

function fallbackSteps(goal: string): WorkflowStep[] {
  return [
    {
      id: "s1",
      label: `Inspect local files for: ${goal}`.slice(0, 120),
      kind: "note",
      ref: "inspect",
      risk: "safe",
    },
    {
      id: "s2",
      label: "Scan git dirty files (names only)",
      kind: "agent",
      ref: "agents/core/git-dirty-scanner",
      risk: "safe",
    },
    {
      id: "s3",
      label: "Draft a local status line",
      kind: "skill",
      ref: "skills/custom/com-status-update",
      risk: "safe",
    },
    {
      id: "s4",
      label: "Keep the plan in a local note — no publish",
      kind: "note",
      ref: "record",
      risk: "safe",
    },
  ];
}

type ManifestWrite =
  | { generated: true; pack: WorkflowPackWrite }
  | { generated: false; error: string; terminal?: boolean };

function packFromDraft(data: unknown, goal: string, options: WorkflowForgeOptions): ManifestWrite {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { generated: false, error: "the coder model did not return a workflow manifest object" };
  }
  const rec = data as {
    name?: unknown;
    slug?: unknown;
    description?: unknown;
    schedule?: unknown;
    risk?: unknown;
    steps?: unknown;
    permissions?: unknown;
  };
  const name = String(rec.name || "").trim() || goal.slice(0, 60);
  const id = slugId(options.id || String(rec.slug || name || goal));
  const description = String(rec.description || goal).trim() || goal;
  const steps = normalizeWorkflowSteps(rec.steps);
  const used = steps.length >= 3 ? steps : fallbackSteps(goal);
  const risk = used.some((step) => step.risk === "exec")
    ? "exec"
    : used.some((step) => step.risk === "write")
      ? "write"
      : rec.risk === "write" || rec.risk === "exec"
        ? rec.risk
        : "safe";
  const pack: WorkflowPackWrite = {
    tree: "workflows",
    segment: "saved",
    slug: id,
    id,
    name,
    description,
    category: options.category ?? "forged",
    version: "1.0.0",
    author: "friday",
    permissions: Array.isArray(rec.permissions) ? rec.permissions.map(String) : [],
    risk,
    schedule: String(rec.schedule || "on demand").trim() || "on demand",
    steps: used,
    inputs: [],
    enabled: false,
  };
  return { generated: true, pack };
}

async function writeManifest(
  goal: string,
  pipeline: Pipeline,
  options: WorkflowForgeOptions,
  complete: NonNullable<WorkflowForgeHost["complete"]>,
  previousError?: string,
): Promise<ManifestWrite> {
  const coder = pipeline.steps.find((step) => step.role === "coder") ?? pipeline.steps[0];
  const modelIds = coder?.modelId ? [coder.modelId] : [];
  try {
    const response = await complete(
      [{ role: "user", content: FORGE_PROMPT(goal, previousError) }],
      modelIds,
    );
    if (!response?.ok || !response.text) {
      return {
        generated: false,
        error: response?.error || "the coder model did not produce a workflow",
      };
    }
    return packFromDraft(extractJson(response.text), goal, options);
  } catch (error) {
    return { generated: false, error: String((error as Error)?.message || error) };
  }
}

async function desktopSandboxVerify(
  api: WorkflowBridge,
  pack: WorkflowPackWrite,
): Promise<WorkflowSandboxResult> {
  const installed = await api.installCapability?.(pack);
  if (!installed?.ok || !installed.id) {
    return { ok: false, error: installed?.error || "sandbox installPack failed" };
  }
  try {
    const verified = await api.verifyCapability?.(installed.id);
    if (!verified?.ok) {
      return { ok: false, error: verified?.error || verified?.status || "sandbox run failed" };
    }
    return { ok: true, ...(verified.mode ? { mode: verified.mode } : {}) };
  } finally {
    await api.uninstallCapability?.(installed.id);
  }
}

function resolveHost(
  options: WorkflowForgeOptions,
): { host: WorkflowForgeHost } | { error: string } {
  const injected = options.host ?? {};
  const api = bridge();
  const installPack =
    injected.installPack ??
    (api?.installCapability
      ? (pack: WorkflowPackWrite) => api.installCapability!(pack)
      : undefined);
  const sandboxVerify =
    injected.sandboxVerify ??
    (api?.installCapability && api.verifyCapability
      ? (pack: WorkflowPackWrite) => desktopSandboxVerify(api, pack)
      : undefined);
  if (!installPack || !sandboxVerify) return { error: DESKTOP_ONLY };
  const complete: NonNullable<WorkflowForgeHost["complete"]> =
    injected.complete ?? ((messages, modelIds) => kernelApi.chat.complete(messages, modelIds));
  return {
    host: {
      installPack,
      sandboxVerify,
      complete,
      submit: injected.submit ?? ((action) => governance.submit(action)),
    },
  };
}

export type WorkflowForgeOptions = {
  id?: string;
  category?: string;
  maxAttempts?: number;
  onProgress?: (run: WorkflowForgeRun) => void;
  host?: Partial<WorkflowForgeHost>;
};

function failLearn(run: WorkflowForgeRun, goal: string, detail: string) {
  learning.evaluate({
    taskId: run.id,
    kind: "workflow-forge",
    title: goal,
    success: false,
    verified: false,
    ms: 0,
    detail,
  });
}

export async function forgeWorkflow(
  goal: string,
  options: WorkflowForgeOptions = {},
): Promise<WorkflowForgeRun> {
  const run: WorkflowForgeRun = {
    id: `workflow-forge-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    workflowId: null,
    log: [],
  };
  const step = (text: string, ok = true) => {
    run.log.push({ at: Date.now(), text, ok });
    options.onProgress?.({ ...run, log: [...run.log] });
  };

  const resolved = resolveHost(options);
  if ("error" in resolved) {
    run.stage = "failed";
    run.error = resolved.error;
    step(resolved.error, false);
    return run;
  }
  const host = resolved.host;
  const complete = host.complete!;
  const submit = host.submit!;

  run.pipeline = planPipeline({ prompt: goal, needsCode: true });
  step(`Planned with ${run.pipeline.steps.map((s) => `${s.role}:${s.modelLabel}`).join(", ")}`);

  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: string | undefined;
  let pack: WorkflowPackWrite | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    run.attempts = attempt;
    run.stage = "writing";
    step(`Writing the workflow (attempt ${attempt})`);
    const started = Date.now();
    const written = await writeManifest(goal, run.pipeline, options, complete, lastError);
    if (!written.generated) {
      lastError = written.error || "the coder model did not produce a workflow";
      step(lastError, false);
      recordStep({
        taskId: run.id,
        role: "coder",
        modelId: run.pipeline.steps.find((s) => s.role === "coder")?.modelId ?? null,
        ok: false,
        ms: Date.now() - started,
        error: lastError,
      });
      if (written.terminal || attempt === maxAttempts) {
        run.stage = "failed";
        run.error = lastError;
        failLearn(run, goal, lastError);
        return run;
      }
      continue;
    }
    pack = written.pack;

    run.stage = "verifying";
    step("Verifying in the sandbox (capability-verify)");
    const verified = await host.sandboxVerify(pack);
    recordStep({
      taskId: run.id,
      role: "coder",
      modelId: run.pipeline.steps.find((s) => s.role === "coder")?.modelId ?? null,
      ok: Boolean(verified?.ok),
      ms: Date.now() - started,
      ...(verified?.ok ? {} : { error: verified?.error ?? verified?.output ?? "sandbox failed" }),
    });

    if (verified?.ok) {
      step(`Sandbox run passed${verified.mode ? ` (${verified.mode})` : ""}`);
      lastError = undefined;
      break;
    }
    lastError = (verified?.error || verified?.output || "sandbox run failed").slice(-800);
    step(`Sandbox rejected the draft: ${lastError.split("\n").slice(-1)[0]}`, false);
    if (attempt === maxAttempts) {
      run.stage = "failed";
      run.error = lastError;
      failLearn(run, goal, lastError);
      return run;
    }
  }

  if (!pack) {
    run.stage = "failed";
    run.error = lastError || "the coder model did not produce a workflow";
    step(run.error, false);
    failLearn(run, goal, run.error);
    return run;
  }

  run.stage = "installing";
  step("Waiting for your approval before installing");
  const holder: { result: WorkflowInstallResult | null } = { result: null };
  const decision = await submit({
    kind: "install",
    title: `New workflow — ${pack.name}`.slice(0, 80),
    rationale: `Verified in the sandbox via capability-verify. Installs at workflows/${pack.segment}/${pack.slug}. Stays disabled until you enable it.`,
    risk: "review",
    evidence: [`forge:${run.id}`, `workflow:${pack.slug}`, `attempts:${run.attempts}`],
    apply: async () => {
      holder.result = await host.installPack(pack!);
      if (!holder.result?.ok) {
        return { ok: false, detail: holder.result?.error ?? "write failed" };
      }
      return { ok: true, detail: `installed ${holder.result.id || pack!.slug}` };
    },
  });
  if (decision.stage === "rejected") {
    run.stage = "failed";
    run.error = "You did not approve this workflow, so nothing was installed.";
    step(run.error, false);
    return run;
  }
  const written = holder.result;
  if (!written?.ok) {
    run.stage = "failed";
    run.error = written?.error ?? "could not write the workflow";
    step(run.error, false);
    return run;
  }

  run.workflowId = written.id ?? `workflows/${pack.segment}/${pack.slug}`;
  run.stage = "done";
  step(`Installed as ${run.workflowId} (disabled until you enable it)`);

  brainKnowledge.remember({
    kind: "knowledge",
    title: `Workflow — ${pack.name}`,
    body: `${goal}\nInstalled at workflows/${pack.segment}/${pack.slug}, sandbox-verified before install. Left disabled.`,
    tags: ["workflow", "self-written", options.category ?? "forged"],
    source: `forge/${run.id}`,
    provenance: "verified",
    confidence: 0.85,
  });
  learning.evaluate({
    taskId: run.id,
    kind: "workflow-forge",
    title: goal,
    success: true,
    verified: true,
    ms: 0,
    detail: `installed ${run.workflowId}`,
  });
  return run;
}

const gapDrafts: WorkflowForgeRun[] = [];

export function looksLikeWorkflowGap(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (text.length < 12) return false;
  if (/^(hi|hello|thanks|thank you|ok|okay|what time|who is)\b/i.test(text)) return false;
  if (/\b(create|write|forge|build|make)\s+(me\s+)?(an?\s+)?workflow\b/i.test(text)) return true;
  if (/\b(new workflow|workflow that|automation that)\b/i.test(text)) return true;
  return false;
}

export function recentWorkflowGapDrafts(limit = 10): WorkflowForgeRun[] {
  return gapDrafts.slice(0, Math.max(1, limit));
}

export function resetWorkflowGapDrafts(): void {
  gapDrafts.length = 0;
}

export function fileWorkflowGapDraft(goal: string): WorkflowForgeRun {
  const run: WorkflowForgeRun = {
    id: `workflow-forge-gap-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    workflowId: null,
    log: [
      {
        at: Date.now(),
        text: "Capability gap — filing a workflow-forge draft. Nothing will be installed until you approve.",
        ok: true,
      },
    ],
  };
  gapDrafts.unshift(run);
  governance.submit({
    kind: "install",
    title: `Workflow draft — ${goal}`.slice(0, 80),
    rationale:
      "No installed workflow covered this request. This is a workflow-forge draft. Sandbox verify and install wait for your approval. I will not self-install.",
    risk: "review",
    evidence: [`workflow-forge:${run.id}`],
    apply: async () => ({ ok: true, detail: "draft only — forge when you approve" }),
  });
  return run;
}

export async function listWorkflowPacks(): Promise<WorkflowPackManifest[]> {
  const index = await listCapabilities();
  return (index?.items ?? [])
    .filter((item) => item.tree === "workflows")
    .map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description || item.summary || "",
      category: item.category,
      schedule: item.schedule || "on demand",
      steps: normalizeWorkflowSteps(item.steps),
      risk: item.risk,
      enabled: item.enabled,
      origin: item.origin,
    }));
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return "(no output)";
  if (typeof value === "string") return value.slice(0, 400);
  try {
    return JSON.stringify(value).slice(0, 400);
  } catch {
    return String(value).slice(0, 400);
  }
}

async function runOneStep(
  step: WorkflowStep,
  options: {
    allowDisabled?: boolean;
    dryRun?: boolean;
    prompt?: string;
    previous?: WorkflowStepResult | undefined;
  },
  host: WorkflowRunHost,
): Promise<WorkflowStepResult> {
  const base = { id: step.id, label: step.label, kind: step.kind, ref: step.ref };
  if (step.approvesSelf && step.risk === "exec") {
    return { ...base, ok: false, detail: "An exec step cannot approve itself." };
  }
  if (step.kind === "note") {
    return {
      ...base,
      ok: true,
      detail: options.previous
        ? `${step.label} (after: ${preview(options.previous.value ?? options.previous.detail)})`
        : step.label,
    };
  }
  if ((step.risk === "write" || step.risk === "exec") && options.dryRun !== false) {
    return {
      ...base,
      ok: true,
      skipped: true,
      detail: `dry-run — ${step.risk} step “${step.label}” was not executed`,
    };
  }
  const prior = options.previous
    ? `Previous step output:\n${preview(options.previous.value ?? options.previous.detail)}`
    : "";
  const prompt = [options.prompt || step.label, prior].filter(Boolean).join("\n\n");
  try {
    const disabledOpts = options.allowDisabled ? { allowDisabled: true } : {};
    if (step.kind === "skill") {
      const invoke = host.invokeSkill ?? invokeSkill;
      const result = await invoke(step.ref, { prompt }, disabledOpts);
      return {
        ...base,
        ok: Boolean(result?.ok),
        detail: result?.ok ? preview(result.value) : String(result?.error || "skill failed"),
        value: result?.value,
      };
    }
    if (step.kind === "tool") {
      const invoke = host.invokeTool ?? invokeToolPack;
      const result = await invoke(step.ref, { prompt }, disabledOpts);
      return {
        ...base,
        ok: Boolean(result?.ok),
        detail: result?.ok ? preview(result.value) : String(result?.error || "tool failed"),
        value: result?.value,
      };
    }
    if (step.kind === "module") {
      const invoke = host.invokeModule ?? invokeModulePack;
      const result = await invoke(step.ref, { prompt }, disabledOpts);
      return {
        ...base,
        ok: Boolean(result?.ok),
        detail: result?.ok ? preview(result.value) : String(result?.error || "module failed"),
        value: result?.value,
      };
    }
    if (step.kind === "agent") {
      const plan = host.planAgent ?? planAgent;
      const run = host.runAgent ?? runAgent;
      const planned = await plan(step.ref, { prompt }, disabledOpts);
      if (!planned?.ok) {
        return { ...base, ok: false, detail: String(planned?.error || "agent plan failed") };
      }
      const executed = await run(step.ref, { prompt, dryRun: true }, disabledOpts);
      return {
        ...base,
        ok: Boolean(executed?.ok),
        detail: executed?.ok
          ? preview(executed.value ?? planned.value)
          : String(executed?.error || "agent run failed"),
        value: executed?.value ?? planned.value,
      };
    }
    if (step.kind === "connector") {
      const list = host.listConnectors ?? listConnectors;
      const connectors = await list();
      const connector = connectors.find(
        (item) => item.id === step.ref || item.name.toLowerCase() === step.ref.toLowerCase(),
      );
      if (!connector) {
        return { ...base, ok: false, detail: `Unknown connector “${step.ref}”.` };
      }
      if (!connector.connected) {
        return { ...base, ok: false, detail: `${connector.name} is not connected.` };
      }
      const tools = (host.connectorTools ?? connectorTools)();
      const tool =
        tools.find((item) => item.connectorId === connector.id && item.action.risk === "safe") ||
        tools.find((item) => item.connectorId === connector.id);
      if (!tool) {
        return { ...base, ok: false, detail: `${connector.name} has no callable action.` };
      }
      if (tool.action.risk !== "safe" && options.dryRun !== false) {
        return {
          ...base,
          ok: true,
          skipped: true,
          detail: `dry-run — ${connector.name} write/exec was not executed`,
        };
      }
      const invoke = host.invokeConnector ?? invokeApprovedConnectorAction;
      const result = await invoke(tool, {});
      const payload =
        result && typeof result === "object" && "value" in result
          ? (result as { value?: unknown }).value
          : ((result as { data?: unknown; lines?: string[] }).data ??
            (result as { lines?: string[] }).lines);
      return {
        ...base,
        ok: Boolean(result?.ok),
        detail: result?.ok
          ? preview(payload)
          : String(result?.error || `${connector.name} call failed`),
        value: payload,
      };
    }
    return { ...base, ok: false, detail: `Unknown step kind “${step.kind}”.` };
  } catch (error) {
    return { ...base, ok: false, detail: String((error as Error)?.message || error) };
  }
}

function skippedStep(step: WorkflowStep, detail: string): WorkflowStepResult {
  return {
    id: step.id,
    label: step.label,
    kind: step.kind,
    ref: step.ref,
    ok: true,
    skipped: true,
    detail,
  };
}

export async function runWorkflowPack(
  id: string,
  options: {
    allowDisabled?: boolean;
    dryRun?: boolean;
    prompt?: string;
    host?: WorkflowRunHost;
  } = {},
): Promise<WorkflowRunResult> {
  const host = options.host ?? {};
  const list = host.list ?? listWorkflowPacks;
  const packs = await list();
  const pack = packs.find(
    (item) => item.id === id || item.id.endsWith(`/${id}`) || item.name === id,
  );
  if (!pack)
    return { ok: false, id, name: id, steps: [], error: "That workflow is not installed." };
  if (!pack.enabled && !options.allowDisabled) {
    return {
      ok: false,
      id: pack.id,
      name: pack.name,
      steps: [],
      error: "Enable this workflow first, or use Test selected (allowDisabled).",
    };
  }
  if (!pack.steps.length) {
    return {
      ok: false,
      id: pack.id,
      name: pack.name,
      steps: [],
      error: "This workflow declares no steps.",
    };
  }
  const steps: WorkflowStepResult[] = [];
  let previous: WorkflowStepResult | undefined;
  let index = 0;
  while (index < pack.steps.length) {
    const step = pack.steps[index]!;
    if (step.when === "previous-ok" && previous && !previous.ok) {
      steps.push(skippedStep(step, "skipped — the previous step did not succeed"));
      index += 1;
      continue;
    }
    if (step.when === "previous-failed" && (!previous || previous.ok)) {
      steps.push(skippedStep(step, "skipped — the previous step succeeded"));
      index += 1;
      continue;
    }
    if (step.parallel) {
      const group: WorkflowStep[] = [];
      const key = step.parallel;
      while (index < pack.steps.length && pack.steps[index]?.parallel === key) {
        group.push(pack.steps[index]!);
        index += 1;
      }
      const results = await Promise.all(
        group.map((item) => runOneStep(item, { ...options, previous }, host)),
      );
      steps.push(...results);
      previous = results[results.length - 1];
      continue;
    }
    const cap = step.loopMax && step.loopMax > 1 ? step.loopMax : 1;
    let result: WorkflowStepResult | undefined;
    for (let attempt = 0; attempt < cap; attempt += 1) {
      result = await runOneStep(step, { ...options, previous }, host);
      if (result.ok) break;
    }
    if (result && !result.ok && step.onError === "continue") {
      result = { ...result, ok: true, skipped: true, detail: `continued after: ${result.detail}` };
    }
    if (result) {
      steps.push(result);
      previous = result;
    }
    index += 1;
  }
  const ok = steps.every((step) => step.ok);
  return {
    ok,
    id: pack.id,
    name: pack.name,
    steps,
    ...(ok ? {} : { error: String(steps.find((step) => !step.ok)?.detail || "workflow failed") }),
  };
}

export async function listWorkflowStepCatalog(): Promise<WorkflowStepCatalogEntry[]> {
  const note: WorkflowStepCatalogEntry[] = [
    { kind: "note", id: "note", name: "Local note — no publish", risk: "safe" },
  ];
  const index = await listCapabilities().catch(() => null);
  const fromPacks: WorkflowStepCatalogEntry[] = (index?.items ?? [])
    .map((item) => {
      const kind = TREE_KIND[item.tree];
      if (!kind) return null;
      return {
        kind,
        id: item.id,
        name: item.name,
        risk: item.risk,
      } satisfies WorkflowStepCatalogEntry;
    })
    .filter((item): item is WorkflowStepCatalogEntry => Boolean(item));
  const connectors = await listConnectors().catch(() => []);
  const fromConnectors: WorkflowStepCatalogEntry[] = connectors.map((item) => ({
    kind: "connector" as const,
    id: item.id,
    name: item.name,
    risk: "safe" as const,
  }));
  return [...note, ...fromPacks, ...fromConnectors];
}

export type WorkflowDraft = {
  id?: string;
  name: string;
  description: string;
  category: string;
  schedule: string;
  steps: WorkflowStep[];
  risk?: "safe" | "write" | "exec";
};

export function blankWorkflowDraft(name = "New local workflow"): WorkflowDraft {
  return {
    name,
    description: "Owner-built local step chain. Stays disabled until enabled.",
    category: "saved",
    schedule: "on demand",
    steps: BLANK_WORKFLOW_STEPS.map((step) => ({ ...step })),
    risk: "safe",
  };
}

function parseWorkflowId(id: string): { segment: string; slug: string } {
  const parts = String(id || "")
    .split("/")
    .filter(Boolean);
  if (parts[0] === "workflows" && parts.length >= 3) {
    return { segment: parts[1] || "saved", slug: slugId(parts.slice(2).join("-")) };
  }
  return { segment: "saved", slug: slugId(id || "new-workflow") };
}

function resolveSaveHost(options: WorkflowForgeOptions):
  | {
      host: {
        installPack: WorkflowForgeHost["installPack"];
        submit: NonNullable<WorkflowForgeHost["submit"]>;
        sandboxVerify?: WorkflowForgeHost["sandboxVerify"];
      };
    }
  | { error: string } {
  const injected = options.host ?? {};
  const api = bridge();
  const installPack =
    injected.installPack ??
    (api?.installCapability
      ? (pack: WorkflowPackWrite) => api.installCapability!(pack)
      : undefined);
  if (!installPack) return { error: DESKTOP_ONLY };
  return {
    host: {
      installPack,
      submit: injected.submit ?? ((action) => governance.submit(action)),
      ...(injected.sandboxVerify ? { sandboxVerify: injected.sandboxVerify } : {}),
    },
  };
}

/** Visual create/edit — no coder model. Writes workflow.json disabled via installPack. */
export async function saveWorkflowPack(
  draft: WorkflowDraft,
  options: WorkflowForgeOptions = {},
): Promise<WorkflowForgeRun> {
  const run: WorkflowForgeRun = {
    id: `workflow-save-${Date.now().toString(36)}`,
    goal: draft.name || "save workflow",
    stage: "writing",
    attempts: 1,
    pipeline: null,
    workflowId: null,
    log: [],
  };
  const step = (text: string, ok = true) => {
    run.log.push({ at: Date.now(), text, ok });
    options.onProgress?.({ ...run, log: [...run.log] });
  };

  const resolved = resolveSaveHost(options);
  if ("error" in resolved) {
    run.stage = "failed";
    run.error = resolved.error;
    step(resolved.error, false);
    return run;
  }
  const host = resolved.host;
  const name = String(draft.name || "").trim() || "New local workflow";
  const parsed = parseWorkflowId(draft.id || slugId(name));
  const steps = normalizeWorkflowSteps(draft.steps);
  const used = steps.length ? steps : BLANK_WORKFLOW_STEPS.map((item) => ({ ...item }));
  const risk = used.some((item) => item.risk === "exec")
    ? "exec"
    : used.some((item) => item.risk === "write")
      ? "write"
      : draft.risk === "write" || draft.risk === "exec"
        ? draft.risk
        : "safe";
  const pack: WorkflowPackWrite = {
    tree: "workflows",
    segment: parsed.segment,
    slug: parsed.slug,
    id: parsed.slug,
    name,
    description: String(draft.description || name).trim() || name,
    category: String(draft.category || "saved").trim() || "saved",
    version: "1.0.0",
    author: "friday",
    permissions: [],
    risk,
    schedule: String(draft.schedule || "on demand").trim() || "on demand",
    steps: used,
    inputs: [],
    enabled: false,
  };
  step(`Saving ${pack.name} (${used.length} step(s))`);

  if (host.sandboxVerify) {
    run.stage = "verifying";
    step("Verifying in the sandbox (capability-verify)");
    const verified = await host.sandboxVerify(pack);
    if (!verified?.ok) {
      run.stage = "failed";
      run.error = verified?.error || verified?.output || "sandbox run failed";
      step(run.error, false);
      failLearn(run, name, run.error);
      return run;
    }
    step(`Sandbox run passed${verified.mode ? ` (${verified.mode})` : ""}`);
  }

  run.stage = "installing";
  step("Waiting for your approval before installing");
  const holder: { result: WorkflowInstallResult | null } = { result: null };
  const submit = host.submit!;
  const decision = await submit({
    kind: "install",
    title: `Save workflow — ${pack.name}`.slice(0, 80),
    rationale: `Writes workflows/${pack.segment}/${pack.slug}/workflow.json. Stays disabled until you enable it. Shipped app packs are copied into the workspace; the original catalog folder is not deleted.`,
    risk: "review",
    evidence: [`save:${run.id}`, `workflow:${pack.slug}`, `steps:${pack.steps.length}`],
    apply: async () => {
      holder.result = await host.installPack(pack);
      if (!holder.result?.ok) {
        return { ok: false, detail: holder.result?.error ?? "write failed" };
      }
      return { ok: true, detail: `saved ${holder.result.id || pack.slug}` };
    },
  });
  if (decision.stage === "rejected") {
    run.stage = "failed";
    run.error = "You did not approve this workflow, so nothing was saved.";
    step(run.error, false);
    return run;
  }
  const written = holder.result;
  if (!written?.ok) {
    run.stage = "failed";
    run.error = written?.error ?? "could not write the workflow";
    step(run.error, false);
    return run;
  }
  run.workflowId = written.id ?? `workflows/${pack.segment}/${pack.slug}`;
  run.stage = "done";
  step(`Saved as ${run.workflowId} (disabled until you enable it)`);
  learning.evaluate({
    taskId: run.id,
    kind: "workflow-forge",
    title: name,
    success: true,
    verified: Boolean(host.sandboxVerify),
    ms: 0,
    detail: `saved ${run.workflowId}`,
  });
  return run;
}
