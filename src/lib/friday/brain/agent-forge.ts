/**
 * FRIDAY · agent forge
 *
 * Same lifecycle skill-forge already gives skills: plan → coder model writes
 * a manifest → sandbox verify → owner approval → install. Stages are real
 * steps — nothing is marked done that did not run.
 *
 * This file mirrors skill-forge.ts / tool-forge.ts on purpose. Shared
 * plumbing is not extracted: pulling governance / recordStep / learning out
 * of skill-forge.ts would edit a working path for no behaviour change.
 * Agent forge never writes skill code; it reuses installed skills only.
 *
 * Lifecycle: draft → verify → install → active → measured.
 * A forged agent stays disabled and proposed until the owner approves
 * (governance kind "install" is in ALWAYS_ASK_KINDS).
 */

import { brainKnowledge } from "./knowledge-base";
import { identity } from "./identity";
import { planPipeline, recordStep, type Pipeline } from "./orchestrator";
import { governance, type GovAction, type GovItem } from "../self/governance";
import { learning } from "../self/learning-engine";
import kernelApi from "../kernel-api";
import { isDesktopApp } from "../desktop";
import { listSkills } from "./skill-forge";
import { listWorkflowPacks } from "./workflow-forge";

export type AgentForgeStage =
  "planning" | "writing" | "verifying" | "installing" | "done" | "failed";

export type AgentForgeRun = {
  id: string;
  goal: string;
  stage: AgentForgeStage;
  attempts: number;
  pipeline: Pipeline | null;
  agentId: string | null;
  log: { at: number; text: string; ok: boolean }[];
  error?: string;
};

export type InstalledSkillRef = { id: string; name: string };
export type InstalledWorkflowRef = { id: string; name: string };

/**
 * Pack shape `installPack()` already writes for the agents tree.
 * `enabled` is always false here — capability-verify / the owner flip it.
 */
export type AgentPackWrite = {
  tree: "agents";
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
  tags: string[];
  enabled: false;
  role: string;
  skills: string[];
  workflows: string[];
  goal: string;
  manifest: { role: string; skills: string[]; goal: string; workflows: string[] };
};

export type AgentInstallResult = {
  ok: boolean;
  id?: string;
  path?: string;
  error?: string;
};

export type AgentSandboxResult = {
  ok: boolean;
  error?: string;
  output?: string;
  mode?: string;
};

/**
 * Optional stand-ins for the desktop marketplace writer / Prompt 2 verifier.
 * Tests inject Node `capabilities.installPack` + `capability-verify.cjs`.
 * Production uses `window.friday.installCapability` (the same writer).
 */
export type AgentForgeHost = {
  complete?: (
    messages: { role: string; content: string }[],
    modelIds?: string[],
  ) => Promise<{ ok?: boolean; text?: string; error?: string } | null>;
  listInstalledSkills?: () => Promise<InstalledSkillRef[]>;
  listInstalledWorkflows?: () => Promise<InstalledWorkflowRef[]>;
  installPack: (pack: AgentPackWrite) => Promise<AgentInstallResult>;
  sandboxVerify: (pack: AgentPackWrite) => Promise<AgentSandboxResult>;
  submit?: (action: GovAction) => Promise<GovItem>;
};

type AgentBridge = {
  installCapability?: (pack: AgentPackWrite) => Promise<AgentInstallResult>;
  verifyCapability?: (id: string) => Promise<{
    ok: boolean;
    error?: string;
    mode?: string;
    status?: string;
  }>;
  uninstallCapability?: (id: string) => Promise<{ ok: boolean; error?: string }>;
};

const DESKTOP_ONLY =
  "Agents live in the FRIDAY workspace — open the desktop app to forge or install them.";

const bridge = (): AgentBridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as AgentBridge | undefined);

export const agentForgeAvailable = (): boolean =>
  Boolean(isDesktopApp() && bridge()?.installCapability && bridge()?.verifyCapability);

function slug(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 4)
      .join("-") || `agent-${Date.now().toString(36)}`
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

async function defaultListSkills(): Promise<InstalledSkillRef[]> {
  const skills = await listSkills();
  return skills
    .filter((item) => item?.id)
    .map((item) => ({ id: item.id, name: item.name || item.id }));
}

async function defaultListWorkflows(): Promise<InstalledWorkflowRef[]> {
  const packs = await listWorkflowPacks();
  return packs
    .filter((item) => item?.id)
    .map((item) => ({ id: item.id, name: item.name || item.id }));
}

const FORGE_PROMPT = (
  goal: string,
  skills: InstalledSkillRef[],
  workflows: InstalledWorkflowRef[],
  previousError?: string,
) =>
  [
    identity.compile(),
    "",
    "You are writing one of your own agents — a manifest only, not skill code.",
    "Return ONLY JSON (no markdown commentary). Required fields:",
    '{"name":"...","slug":"...","description":"...","role":"...","skills":["id"],"workflows":[],"permissions":[],"risk":"safe"}',
    "risk must be one of: safe, write, exec.",
    "skills[] must be ids from the installed list below. Reuse those skills; do not invent new ones.",
    "workflows[] is optional. If present, every id must be from the installed workflow list. Do not invent workflow JSON.",
    "Do not write JavaScript, skill.mjs, or a run() function. An agent is a role + skills + optional workflows + permissions.",
    "If the goal needs a skill that is not in the installed list, return ONLY:",
    '{"ok":false,"missingSkills":["id"]}',
    "",
    "Installed skills:",
    ...skills.map((item) => `- ${item.id} — ${item.name}`),
    "",
    workflows.length
      ? [
          "Installed workflows (optional):",
          ...workflows.map((item) => `- ${item.id} — ${item.name}`),
        ].join("\n")
      : "No installed workflows. Omit workflows or use [].",
    "",
    `Goal: ${goal}`,
    previousError
      ? `\nThe previous attempt failed in the sandbox with:\n${previousError}\nFix the manifest. Still do not invent skills or workflows.`
      : "",
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

function asRisk(value: unknown): "safe" | "write" | "exec" {
  return value === "write" || value === "exec" ? value : "safe";
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

type ManifestWrite =
  | { generated: true; pack: AgentPackWrite }
  | { generated: false; error: string; terminal?: boolean };

function packFromDraft(
  data: unknown,
  goal: string,
  installed: Set<string>,
  installedWorkflows: Set<string>,
  options: AgentForgeOptions,
): ManifestWrite {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { generated: false, error: "the coder model did not return an agent manifest object" };
  }
  const rec = data as {
    ok?: unknown;
    missingSkills?: unknown;
    name?: unknown;
    role?: unknown;
    skills?: unknown;
    workflows?: unknown;
    slug?: unknown;
    description?: unknown;
    permissions?: unknown;
    risk?: unknown;
  };
  if (rec.ok === false) {
    const missing = asStringList(rec.missingSkills);
    return {
      generated: false,
      terminal: true,
      error: missing.length
        ? `needed skill(s) not installed: ${missing.join(", ")}`
        : "the coder model reported a missing skill and stopped",
    };
  }
  const name = String(rec.name || "").trim();
  const role = String(rec.role || "").trim();
  const skills = Array.isArray(rec.skills) ? asStringList(rec.skills) : null;
  if (!name || !role || !skills) {
    return { generated: false, error: "the coder model did not return name, role, and skills[]" };
  }
  if (!skills.length) {
    return { generated: false, error: "the agent must reuse at least one installed skill" };
  }
  const unknown = [...new Set(skills.filter((id) => !installed.has(id)))];
  if (unknown.length) {
    return {
      generated: false,
      terminal: true,
      error: `needed skill(s) not installed: ${unknown.join(", ")}`,
    };
  }
  const requestedWorkflows = Array.isArray(rec.workflows) ? asStringList(rec.workflows) : [];
  const workflows = requestedWorkflows.filter((id) => installedWorkflows.has(id));
  const id = slugId(options.id || String(rec.slug || name || goal));
  const description = String(rec.description || goal).trim() || goal;
  const pack: AgentPackWrite = {
    tree: "agents",
    segment: "installed",
    slug: id,
    id,
    name,
    description,
    category: options.category ?? "forged",
    version: "1.0.0",
    author: "friday",
    permissions: asStringList(rec.permissions),
    risk: options.risk ?? asRisk(rec.risk),
    tags: ["forged", "agent"],
    enabled: false,
    role,
    skills,
    workflows,
    goal,
    manifest: { role, skills, goal, workflows },
  };
  return { generated: true, pack };
}

async function writeManifest(
  goal: string,
  pipeline: Pipeline,
  skills: InstalledSkillRef[],
  workflows: InstalledWorkflowRef[],
  options: AgentForgeOptions,
  complete: NonNullable<AgentForgeHost["complete"]>,
  previousError?: string,
): Promise<ManifestWrite> {
  const coder = pipeline.steps.find((step) => step.role === "coder") ?? pipeline.steps[0];
  const modelIds = coder?.modelId ? [coder.modelId] : [];
  const installed = new Set(skills.map((item) => item.id));
  const installedWorkflows = new Set(workflows.map((item) => item.id));
  try {
    const response = await complete(
      [{ role: "user", content: FORGE_PROMPT(goal, skills, workflows, previousError) }],
      modelIds,
    );
    if (!response?.ok) {
      return {
        generated: false,
        error: response?.error || "the coder model did not answer",
      };
    }
    const text = String(response.text ?? "").trim();
    if (!text) {
      return { generated: false, error: "the coder model did not return an agent manifest" };
    }
    return packFromDraft(extractJson(text), goal, installed, installedWorkflows, options);
  } catch (error) {
    return {
      generated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function desktopSandboxVerify(
  api: AgentBridge,
  pack: AgentPackWrite,
): Promise<AgentSandboxResult> {
  const installed = await api.installCapability?.(pack);
  if (!installed?.ok || !installed.id) {
    return { ok: false, error: installed?.error || "sandbox installPack failed" };
  }
  try {
    const verified = await api.verifyCapability?.(installed.id);
    if (!verified?.ok) {
      return {
        ok: false,
        error: verified?.error || verified?.status || "sandbox run failed",
      };
    }
    return {
      ok: true,
      ...(verified.mode ? { mode: verified.mode } : {}),
    };
  } finally {
    await api.uninstallCapability?.(installed.id);
  }
}

function resolveHost(options: AgentForgeOptions): { host: AgentForgeHost } | { error: string } {
  const injected = options.host ?? {};
  const api = bridge();
  const installPack =
    injected.installPack ??
    (api?.installCapability ? (pack: AgentPackWrite) => api.installCapability!(pack) : undefined);
  const sandboxVerify =
    injected.sandboxVerify ??
    (api?.installCapability && api.verifyCapability
      ? (pack: AgentPackWrite) => desktopSandboxVerify(api, pack)
      : undefined);
  if (!installPack || !sandboxVerify) return { error: DESKTOP_ONLY };
  const complete: NonNullable<AgentForgeHost["complete"]> =
    injected.complete ?? ((messages, modelIds) => kernelApi.chat.complete(messages, modelIds));
  return {
    host: {
      installPack,
      sandboxVerify,
      complete,
      listInstalledSkills: injected.listInstalledSkills ?? defaultListSkills,
      listInstalledWorkflows: injected.listInstalledWorkflows ?? defaultListWorkflows,
      submit: injected.submit ?? ((action) => governance.submit(action)),
    },
  };
}

export type AgentForgeOptions = {
  id?: string;
  category?: string;
  risk?: "safe" | "write" | "exec";
  maxAttempts?: number;
  onProgress?: (run: AgentForgeRun) => void;
  /** Test / Node stand-ins. Production leaves this unset and uses the desktop writer. */
  host?: Partial<AgentForgeHost>;
};

function failLearn(run: AgentForgeRun, goal: string, detail: string) {
  learning.evaluate({
    taskId: run.id,
    kind: "agent-forge",
    title: goal,
    success: false,
    verified: false,
    ms: 0,
    detail,
  });
}

/** Create a new agent for a goal — plan, write a manifest, verify, install disabled. */
export async function forgeAgent(
  goal: string,
  options: AgentForgeOptions = {},
): Promise<AgentForgeRun> {
  const run: AgentForgeRun = {
    id: `agent-forge-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    agentId: null,
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
  const listInstalled = host.listInstalledSkills!;
  const listWorkflows = host.listInstalledWorkflows!;
  const submit = host.submit!;

  run.pipeline = planPipeline({ prompt: goal, needsCode: true });
  step(`Planned with ${run.pipeline.steps.map((s) => `${s.role}:${s.modelLabel}`).join(", ")}`);

  const installedSkills = await listInstalled();
  if (!installedSkills.length) {
    run.stage = "failed";
    run.error = "no installed skills to reuse — agent forge will not invent skill code";
    step(run.error, false);
    failLearn(run, goal, run.error);
    return run;
  }
  const installedWorkflows = await listWorkflows().catch(() => []);
  step(
    `Reusing ${installedSkills.length} installed skill(s)${
      installedWorkflows.length ? ` and ${installedWorkflows.length} workflow(s)` : ""
    }`,
  );

  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: string | undefined;
  let pack: AgentPackWrite | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    run.attempts = attempt;
    run.stage = "writing";
    step(`Writing the agent (attempt ${attempt})`);
    const started = Date.now();
    const written = await writeManifest(
      goal,
      run.pipeline,
      installedSkills,
      installedWorkflows,
      options,
      complete,
      lastError,
    );
    if (!written.generated) {
      lastError = written.error || "the coder model did not produce an agent manifest";
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
    run.error = lastError || "the coder model did not produce an agent manifest";
    step(run.error, false);
    failLearn(run, goal, run.error);
    return run;
  }

  run.stage = "installing";
  step("Waiting for your approval before installing");
  const holder: { result: AgentInstallResult | null } = { result: null };
  const decision = await submit({
    kind: "install",
    title: `New agent — ${pack.name}`.slice(0, 80),
    rationale: `Verified in the sandbox via capability-verify. Installs at agents/installed/${pack.slug}. Stays disabled until you enable it.`,
    risk: pack.risk === "exec" ? "risky" : "review",
    evidence: [
      `forge:${run.id}`,
      `agent:${pack.slug}`,
      `attempts:${run.attempts}`,
      `skills:${pack.skills.join(",")}`,
      ...(pack.workflows.length ? [`workflows:${pack.workflows.join(",")}`] : []),
    ],
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
    run.error = "You did not approve this agent, so nothing was installed.";
    step(run.error, false);
    return run;
  }
  const written = holder.result;
  if (!written?.ok) {
    run.stage = "failed";
    run.error = written?.error ?? "could not write the agent";
    step(run.error, false);
    return run;
  }

  run.agentId = written.id ?? `agents/installed/${pack.slug}`;
  run.stage = "done";
  step(`Installed as ${run.agentId} (disabled until you enable it)`);

  brainKnowledge.remember({
    kind: "knowledge",
    title: `Agent — ${pack.name}`,
    body: `${goal}\nInstalled at agents/installed/${pack.slug}, sandbox-verified before install. Left disabled.`,
    tags: ["agent", "self-written", options.category ?? "forged"],
    source: `forge/${run.id}`,
    provenance: "verified",
    confidence: 0.85,
  });
  learning.evaluate({
    taskId: run.id,
    kind: "agent-forge",
    title: goal,
    success: true,
    verified: true,
    ms: 0,
    detail: `installed ${run.agentId}`,
  });
  return run;
}

const gapDrafts: AgentForgeRun[] = [];

/**
 * Conservative: only when the owner is clearly asking for a new agent,
 * not ordinary chat or a skill-forge request.
 */
export function looksLikeAgentGap(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (text.length < 12) return false;
  if (/^(hi|hello|thanks|thank you|ok|okay|what time|who is)\b/i.test(text)) return false;
  if (/\b(create|write|forge|build|make)\s+(me\s+)?(an?\s+)?agent\b/i.test(text)) return true;
  if (/\b(new agent|agent that)\b/i.test(text)) return true;
  return false;
}

export function recentAgentGapDrafts(limit = 10): AgentForgeRun[] {
  return gapDrafts.slice(0, Math.max(1, limit));
}

export function resetAgentGapDrafts(): void {
  gapDrafts.length = 0;
}

/**
 * File an agent-forge draft through the existing governance "install"
 * lifecycle. Nothing is written here — `forgeAgent()` still does sandbox
 * verify + owner approval when the desktop writer is present.
 */
export function fileAgentGapDraft(goal: string): AgentForgeRun {
  const run: AgentForgeRun = {
    id: `agent-forge-gap-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    agentId: null,
    log: [
      {
        at: Date.now(),
        text: "Capability gap — filing an agent-forge draft. Nothing will be installed until you approve.",
        ok: true,
      },
    ],
  };
  const item = governance.discover({
    id: `gov:agent-gap:${slug(goal)}`,
    kind: "install",
    title: `New agent draft — ${goal.slice(0, 60)}`,
    rationale:
      "No installed agent covered this request. This is an agent-forge draft. Sandbox verify and install wait for your approval. I will not self-install.",
    risk: "review",
    evidence: [`gap:${goal.slice(0, 240)}`, `forge:${run.id}`],
  });
  run.log.push({
    at: Date.now(),
    text: `Queued as ${item.id} (${item.stage}). Approval required before install.`,
    ok: true,
  });
  if (!agentForgeAvailable()) {
    run.error = DESKTOP_ONLY;
    run.log.push({
      at: Date.now(),
      text: `${DESKTOP_ONLY} Draft stays queued.`,
      ok: false,
    });
  }
  gapDrafts.unshift(run);
  if (gapDrafts.length > 40) gapDrafts.length = 40;
  return run;
}
