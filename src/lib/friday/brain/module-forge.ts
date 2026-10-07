/**
 * FRIDAY · module forge
 *
 * Same lifecycle skill-forge / agent-forge / tool-forge already give those
 * types: plan → coder writes a module (manifest + entry) → sandbox verify →
 * owner approval → install. Stages are real steps — nothing is marked done
 * that did not run.
 *
 * This file mirrors agent-forge.ts on purpose. Shared plumbing is not
 * extracted: pulling governance / recordStep / learning out of a working
 * forge would edit a working path for no behaviour change.
 *
 * Lifecycle: draft → verify → install → active → measured.
 * A forged module stays disabled and proposed until the owner approves
 * (governance kind "install" is in ALWAYS_ASK_KINDS).
 */

import { brainKnowledge } from "./knowledge-base";
import { identity } from "./identity";
import { planPipeline, recordStep, type Pipeline } from "./orchestrator";
import { governance, type GovAction, type GovItem } from "../self/governance";
import { learning } from "../self/learning-engine";
import kernelApi from "../kernel-api";
import { isDesktopApp } from "../desktop";

export type ModuleForgeStage =
  "planning" | "writing" | "verifying" | "installing" | "done" | "failed";

export type ModuleForgeRun = {
  id: string;
  goal: string;
  stage: ModuleForgeStage;
  attempts: number;
  pipeline: Pipeline | null;
  moduleId: string | null;
  log: { at: number; text: string; ok: boolean }[];
  error?: string;
};

export type ModulePackWrite = {
  tree: "modules";
  segment: string;
  slug: string;
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  permissions: string[];
  entry: string;
  enabled: false;
  code: string;
  ui?: { page: string; icon?: string };
  selfTest?: { export: string; input: Record<string, unknown> };
};

export type ModuleInstallResult = {
  ok: boolean;
  id?: string;
  path?: string;
  error?: string;
};

export type ModuleSandboxResult = {
  ok: boolean;
  error?: string;
  output?: string;
  mode?: string;
};

export type ModuleForgeHost = {
  complete?: (
    messages: { role: string; content: string }[],
    modelIds?: string[],
  ) => Promise<{ ok?: boolean; text?: string; error?: string } | null>;
  installPack: (pack: ModulePackWrite) => Promise<ModuleInstallResult>;
  sandboxVerify: (pack: ModulePackWrite) => Promise<ModuleSandboxResult>;
  submit?: (action: GovAction) => Promise<GovItem>;
};

export type ModulePackManifest = {
  id: string;
  name: string;
  description: string;
  category: string;
  permissions: string[];
  risk: "safe" | "write" | "exec";
  inputs: string[];
  enabled: boolean;
  origin?: "app" | "workspace";
  keywords?: string[];
  /** False when the pack has no loadable main.py. */
  runnable?: boolean;
  healthy?: boolean;
};

export type ModuleInvokeResult = {
  ok: boolean;
  id?: string;
  value?: unknown;
  error?: string;
  ms?: number;
};

type ModuleBridge = {
  installCapability?: (pack: ModulePackWrite) => Promise<ModuleInstallResult>;
  verifyCapability?: (id: string) => Promise<{
    ok: boolean;
    error?: string;
    mode?: string;
    status?: string;
  }>;
  uninstallCapability?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  listModulePacks?: () => Promise<{ ok?: boolean; modules?: ModulePackManifest[] }>;
  invokeModulePack?: (
    id: string,
    input?: unknown,
    options?: { allowDisabled?: boolean },
  ) => Promise<ModuleInvokeResult>;
};

const DESKTOP_ONLY =
  "Modules live in the FRIDAY workspace — open the desktop app to forge or install them.";

const DEFAULT_MODULE_CODE = `"""FRIDAY module (forged). Dry-run inspect of a folder via fs.read."""
MANIFEST = None


def register(manifest):
    global MANIFEST
    MANIFEST = manifest


async def run(tools, folder="."):
    listing = await tools.execute("fs.read", {"path": folder})
    if not listing.get("ok"):
        return listing
    return {"ok": True, "dryRun": True, "folder": folder, "entries": listing.get("entries", [])}


def self_test(payload=None):
    return {"ok": True, "loaded": True, "name": (MANIFEST or {}).get("name")}
`;

const bridge = (): ModuleBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.friday as unknown as ModuleBridge | undefined);

export const moduleForgeAvailable = (): boolean =>
  Boolean(isDesktopApp() && bridge()?.installCapability && bridge()?.verifyCapability);

function slug(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 4)
      .join("-") || `module-${Date.now().toString(36)}`
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

const FORGE_PROMPT = (goal: string, previousError?: string) =>
  [
    identity.compile(),
    "",
    "You are writing one of your own modules — a mini-feature with a manifest and Python entry.",
    "Return ONLY JSON (no markdown commentary). Required fields:",
    '{"name":"...","slug":"...","description":"...","permissions":["fs.read"],"entry":"main.py","ui":{"page":"...","icon":"..."},"code":"python source"}',
    "permissions must be real kernel tools (fs.read, fs.write, git, shell.cmd). Prefer fs.read when the work is inspect-only.",
    "code must be Python with register(manifest), async def run(tools, ...), and def self_test(payload=None).",
    "run() must call tools.execute for filesystem work. Do not invent a second engine. Dry-run by default.",
    "Do not claim a UI router, PDF converter, FFmpeg, or a social/broker API.",
    "",
    `Goal: ${goal}`,
    previousError
      ? `\nThe previous attempt failed in the sandbox with:\n${previousError}\nFix the Python. Keep register/run/self_test.`
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

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

type ManifestWrite =
  | { generated: true; pack: ModulePackWrite }
  | { generated: false; error: string; terminal?: boolean };

function packFromDraft(data: unknown, goal: string, options: ModuleForgeOptions): ManifestWrite {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { generated: false, error: "the coder model did not return a module manifest object" };
  }
  const rec = data as {
    name?: unknown;
    slug?: unknown;
    description?: unknown;
    permissions?: unknown;
    entry?: unknown;
    code?: unknown;
    ui?: unknown;
  };
  const name = String(rec.name || "").trim();
  if (!name) {
    return { generated: false, error: "the coder model did not return a name" };
  }
  const id = slugId(options.id || String(rec.slug || name || goal));
  const description = String(rec.description || goal).trim() || goal;
  const code = String(rec.code || "").trim() || DEFAULT_MODULE_CODE;
  if (!/\bdef\s+register\s*\(/.test(code) || !/\bdef\s+run\s*\(/.test(code)) {
    return { generated: false, error: "module code must define register() and run()" };
  }
  const uiRaw =
    rec.ui && typeof rec.ui === "object" && !Array.isArray(rec.ui)
      ? (rec.ui as Record<string, unknown>)
      : null;
  const uiPage = String(uiRaw?.["page"] || name).trim();
  const pack: ModulePackWrite = {
    tree: "modules",
    segment:
      options.category &&
      ["ai", "system", "automation", "communication", "developer", "ui", "custom"].includes(
        options.category,
      )
        ? options.category
        : "custom",
    slug: id,
    id,
    name,
    description,
    category: options.category ?? "forged",
    version: "1.0.0",
    author: "friday",
    permissions: asStringList(rec.permissions).length ? asStringList(rec.permissions) : ["fs.read"],
    entry: String(rec.entry || "main.py").trim() || "main.py",
    enabled: false,
    code,
    ui: { page: uiPage, icon: String(uiRaw?.["icon"] || "blocks") },
    ...(/\bdef\s+self_test\s*\(/.test(code)
      ? { selfTest: { export: "self_test", input: {} } }
      : {}),
  };
  return { generated: true, pack };
}

async function writeManifest(
  goal: string,
  pipeline: Pipeline,
  options: ModuleForgeOptions,
  complete: NonNullable<ModuleForgeHost["complete"]>,
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
        error: response?.error || "the coder model did not produce module code",
      };
    }
    return packFromDraft(extractJson(response.text), goal, options);
  } catch (error) {
    return { generated: false, error: String((error as Error)?.message || error) };
  }
}

async function desktopSandboxVerify(
  api: ModuleBridge,
  pack: ModulePackWrite,
): Promise<ModuleSandboxResult> {
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

function resolveHost(options: ModuleForgeOptions): { host: ModuleForgeHost } | { error: string } {
  const injected = options.host ?? {};
  const api = bridge();
  const installPack =
    injected.installPack ??
    (api?.installCapability ? (pack: ModulePackWrite) => api.installCapability!(pack) : undefined);
  const sandboxVerify =
    injected.sandboxVerify ??
    (api?.installCapability && api.verifyCapability
      ? (pack: ModulePackWrite) => desktopSandboxVerify(api, pack)
      : undefined);
  if (!installPack || !sandboxVerify) return { error: DESKTOP_ONLY };
  const complete: NonNullable<ModuleForgeHost["complete"]> =
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

export type ModuleForgeOptions = {
  id?: string;
  category?: string;
  maxAttempts?: number;
  onProgress?: (run: ModuleForgeRun) => void;
  host?: Partial<ModuleForgeHost>;
};

function failLearn(run: ModuleForgeRun, goal: string, detail: string) {
  learning.evaluate({
    taskId: run.id,
    kind: "module-forge",
    title: goal,
    success: false,
    verified: false,
    ms: 0,
    detail,
  });
}

export async function forgeModule(
  goal: string,
  options: ModuleForgeOptions = {},
): Promise<ModuleForgeRun> {
  const run: ModuleForgeRun = {
    id: `module-forge-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    moduleId: null,
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
  let pack: ModulePackWrite | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    run.attempts = attempt;
    run.stage = "writing";
    step(`Writing the module (attempt ${attempt})`);
    const started = Date.now();
    const written = await writeManifest(goal, run.pipeline, options, complete, lastError);
    if (!written.generated) {
      lastError = written.error || "the coder model did not produce a module";
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
    run.error = lastError || "the coder model did not produce a module";
    step(run.error, false);
    failLearn(run, goal, run.error);
    return run;
  }

  run.stage = "installing";
  step("Waiting for your approval before installing");
  const holder: { result: ModuleInstallResult | null } = { result: null };
  const decision = await submit({
    kind: "install",
    title: `New module — ${pack.name}`.slice(0, 80),
    rationale: `Verified in the sandbox via capability-verify. Installs at modules/${pack.segment}/${pack.slug}. Stays disabled until you enable it.`,
    risk: pack.permissions.some((item) => /shell|git|write/i.test(item)) ? "review" : "review",
    evidence: [`forge:${run.id}`, `module:${pack.slug}`, `attempts:${run.attempts}`],
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
    run.error = "You did not approve this module, so nothing was installed.";
    step(run.error, false);
    return run;
  }
  const written = holder.result;
  if (!written?.ok) {
    run.stage = "failed";
    run.error = written?.error ?? "could not write the module";
    step(run.error, false);
    return run;
  }

  run.moduleId = written.id ?? `modules/${pack.segment}/${pack.slug}`;
  run.stage = "done";
  step(`Installed as ${run.moduleId} (disabled until you enable it)`);

  brainKnowledge.remember({
    kind: "knowledge",
    title: `Module — ${pack.name}`,
    body: `${goal}\nInstalled at modules/${pack.segment}/${pack.slug}, sandbox-verified before install. Left disabled.`,
    tags: ["module", "self-written", options.category ?? "forged"],
    source: `forge/${run.id}`,
    provenance: "verified",
    confidence: 0.85,
  });
  learning.evaluate({
    taskId: run.id,
    kind: "module-forge",
    title: goal,
    success: true,
    verified: true,
    ms: 0,
    detail: `installed ${run.moduleId}`,
  });
  return run;
}

const gapDrafts: ModuleForgeRun[] = [];

export function looksLikeModuleGap(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (text.length < 12) return false;
  if (/^(hi|hello|thanks|thank you|ok|okay|what time|who is)\b/i.test(text)) return false;
  if (/\b(create|write|forge|build|make)\s+(me\s+)?(an?\s+)?module\b/i.test(text)) return true;
  if (/\b(new module|module that)\b/i.test(text)) return true;
  return false;
}

export function recentModuleGapDrafts(limit = 10): ModuleForgeRun[] {
  return gapDrafts.slice(0, Math.max(1, limit));
}

export function resetModuleGapDrafts(): void {
  gapDrafts.length = 0;
}

export async function listModulePacks(): Promise<ModulePackManifest[]> {
  const api = bridge();
  if (!api?.listModulePacks) return [];
  const result = await api.listModulePacks();
  const modules = result?.modules ?? [];
  return modules.map((item) => ({
    id: String(item.id || ""),
    name: String(item.name || item.id || "module"),
    description: String(item.description || ""),
    category: String(item.category || "custom"),
    permissions: Array.isArray(item.permissions) ? item.permissions : [],
    risk: item.risk === "write" || item.risk === "exec" ? item.risk : "safe",
    inputs: Array.isArray(item.inputs) ? item.inputs : [],
    enabled: Boolean(item.enabled),
    keywords: Array.isArray(item.keywords) ? item.keywords : [],
    ...(item.origin === "app" || item.origin === "workspace" ? { origin: item.origin } : {}),
    ...(typeof item.runnable === "boolean" ? { runnable: item.runnable } : {}),
    ...(typeof item.healthy === "boolean" ? { healthy: item.healthy } : {}),
  }));
}

export async function invokeModulePack(
  id: string,
  input?: unknown,
  options?: { allowDisabled?: boolean },
): Promise<ModuleInvokeResult> {
  const api = bridge();
  if (!api?.invokeModulePack) return { ok: false, error: DESKTOP_ONLY };
  return api.invokeModulePack(id, input, options);
}

export function fileModuleGapDraft(goal: string): ModuleForgeRun {
  const run: ModuleForgeRun = {
    id: `module-forge-gap-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    moduleId: null,
    log: [
      {
        at: Date.now(),
        text: "Capability gap — filing a module-forge draft. Nothing will be installed until you approve.",
        ok: true,
      },
    ],
  };
  const item = governance.discover({
    id: `gov:module-gap:${slug(goal)}`,
    kind: "install",
    title: `New module draft — ${goal.slice(0, 60)}`,
    rationale:
      "No installed module covered this request. This is a module-forge draft. Sandbox verify and install wait for your approval. I will not self-install.",
    risk: "review",
    evidence: [`gap:${goal.slice(0, 240)}`, `forge:${run.id}`],
  });
  run.log.push({
    at: Date.now(),
    text: `Queued as ${item.id} (${item.stage}). Approval required before install.`,
    ok: true,
  });
  if (!moduleForgeAvailable()) {
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
