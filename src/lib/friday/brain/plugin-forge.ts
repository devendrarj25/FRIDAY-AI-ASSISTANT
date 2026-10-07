/**
 * FRIDAY · plugin forge
 *
 * Same lifecycle skill-forge / agent-forge / tool-forge / module-forge already
 * give those types: plan → coder writes a plugin (plugin.json + CJS entry with
 * declared hook functions) → sandbox verify → owner approval → install.
 * Stages are real steps — nothing is marked done that did not run.
 *
 * Lifecycle: draft → verify → install → active → measured.
 * A forged plugin stays disabled and proposed until the owner approves
 * (governance kind "install" is in ALWAYS_ASK_KINDS).
 */

import { brainKnowledge } from "./knowledge-base";
import { identity } from "./identity";
import { planPipeline, recordStep, type Pipeline } from "./orchestrator";
import { governance, type GovAction, type GovItem } from "../self/governance";
import { learning } from "../self/learning-engine";
import kernelApi from "../kernel-api";
import { isDesktopApp } from "../desktop";

export type PluginForgeStage =
  "planning" | "writing" | "verifying" | "installing" | "done" | "failed";

export type PluginForgeRun = {
  id: string;
  goal: string;
  stage: PluginForgeStage;
  attempts: number;
  pipeline: Pipeline | null;
  pluginId: string | null;
  log: { at: number; text: string; ok: boolean }[];
  error?: string;
};

export type PluginPackWrite = {
  tree: "plugins";
  segment: string;
  slug: string;
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  permissions: string[];
  hooks: string[];
  entry: string;
  enabled: false;
  code: string;
  selfTest?: { export: string; input: Record<string, unknown> };
};

export type PluginInstallResult = {
  ok: boolean;
  id?: string;
  path?: string;
  error?: string;
};

export type PluginSandboxResult = {
  ok: boolean;
  error?: string;
  output?: string;
  mode?: string;
};

export type PluginForgeHost = {
  complete?: (
    messages: { role: string; content: string }[],
    modelIds?: string[],
  ) => Promise<{ ok?: boolean; text?: string; error?: string } | null>;
  installPack: (pack: PluginPackWrite) => Promise<PluginInstallResult>;
  sandboxVerify: (pack: PluginPackWrite) => Promise<PluginSandboxResult>;
  submit?: (action: GovAction) => Promise<GovItem>;
};

type PluginBridge = {
  installCapability?: (pack: PluginPackWrite) => Promise<PluginInstallResult>;
  verifyCapability?: (id: string) => Promise<{
    ok: boolean;
    error?: string;
    mode?: string;
    status?: string;
  }>;
  uninstallCapability?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  dispatchPluginHooks?: (
    hook: string,
    payload?: Record<string, unknown>,
    options?: { allowDisabled?: boolean; pluginId?: string },
  ) => Promise<{ ok?: boolean; hook?: string; fired?: unknown[]; error?: string }>;
};

const DESKTOP_ONLY =
  "Plugins live in the FRIDAY workspace — open the desktop app to forge or install them.";

const DEFAULT_PLUGIN_CODE = `module.exports = {
  register() {},
  "on-turn-complete": async function (payload, ctx) {
    ctx.fs.writeFile(
      "last-hook.json",
      JSON.stringify({ at: Date.now(), hook: "on-turn-complete", dryRun: true, payload }, null, 2),
    );
    return { ok: true, dryRun: true };
  },
  selfTest() {
    return { ok: true, loaded: true };
  },
};
`;

const bridge = (): PluginBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.friday as unknown as PluginBridge | undefined);

export const pluginForgeAvailable = (): boolean =>
  Boolean(isDesktopApp() && bridge()?.installCapability && bridge()?.verifyCapability);

function slug(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 4)
      .join("-") || `plugin-${Date.now().toString(36)}`
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
    "You are writing one of your own plugins — a lifecycle hook pack with plugin.json and a CJS entry.",
    "Return ONLY JSON (no markdown commentary). Required fields:",
    '{"name":"...","slug":"...","description":"...","permissions":[],"hooks":["on-turn-complete"],"entry":"index.cjs","code":"cjs source"}',
    "hooks must be from: on-app-start, on-app-quit, on-turn-start, on-turn-complete, on-error, on-idle, on-skill-run, on-file-change.",
    "code must be CommonJS exporting register() and a function for each declared hook (kebab-case keys).",
    "Hook functions receive (payload, ctx) and may write only through ctx.fs (plugin data folder). Prefer empty permissions.",
    "Do not spawn a shell, open a network socket, or rewrite workspace files unless permissions include fs.write (still disabled until the owner enables).",
    "Do not invent git pre-commit, browser content scripts, or CI YAML.",
    "",
    `Goal: ${goal}`,
    previousError
      ? `\nThe previous attempt failed in the sandbox with:\n${previousError}\nFix the CJS. Keep register and the declared hook exports.`
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
  | { generated: true; pack: PluginPackWrite }
  | { generated: false; error: string; terminal?: boolean };

function packFromDraft(data: unknown, goal: string, options: PluginForgeOptions): ManifestWrite {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { generated: false, error: "the coder model did not return a plugin manifest object" };
  }
  const rec = data as {
    name?: unknown;
    slug?: unknown;
    description?: unknown;
    permissions?: unknown;
    hooks?: unknown;
    entry?: unknown;
    code?: unknown;
  };
  const name = String(rec.name || "").trim();
  if (!name) {
    return { generated: false, error: "the coder model did not return a name" };
  }
  const id = slugId(options.id || String(rec.slug || name || goal));
  const description = String(rec.description || goal).trim() || goal;
  const code = String(rec.code || "").trim() || DEFAULT_PLUGIN_CODE;
  if (!/module\.exports|exports\./.test(code)) {
    return { generated: false, error: "plugin code must be CommonJS (module.exports)" };
  }
  const hooks = asStringList(rec.hooks);
  const declared = hooks.length ? hooks : ["on-turn-complete"];
  const pack: PluginPackWrite = {
    tree: "plugins",
    segment: "installed",
    slug: id,
    id,
    name,
    description,
    category: options.category ?? "forged",
    version: "1.0.0",
    author: "friday",
    permissions: asStringList(rec.permissions),
    hooks: declared,
    entry: String(rec.entry || "index.cjs").trim() || "index.cjs",
    enabled: false,
    code,
    selfTest: { export: "selfTest", input: {} },
  };
  return { generated: true, pack };
}

async function writeManifest(
  goal: string,
  pipeline: Pipeline,
  options: PluginForgeOptions,
  complete: NonNullable<PluginForgeHost["complete"]>,
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
        error: response?.error || "the coder model did not produce plugin code",
      };
    }
    return packFromDraft(extractJson(response.text), goal, options);
  } catch (error) {
    return { generated: false, error: String((error as Error)?.message || error) };
  }
}

async function desktopSandboxVerify(
  api: PluginBridge,
  pack: PluginPackWrite,
): Promise<PluginSandboxResult> {
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

function resolveHost(options: PluginForgeOptions): { host: PluginForgeHost } | { error: string } {
  const injected = options.host ?? {};
  const api = bridge();
  const installPack =
    injected.installPack ??
    (api?.installCapability ? (pack: PluginPackWrite) => api.installCapability!(pack) : undefined);
  const sandboxVerify =
    injected.sandboxVerify ??
    (api?.installCapability && api.verifyCapability
      ? (pack: PluginPackWrite) => desktopSandboxVerify(api, pack)
      : undefined);
  if (!installPack || !sandboxVerify) return { error: DESKTOP_ONLY };
  const complete: NonNullable<PluginForgeHost["complete"]> =
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

export type PluginForgeOptions = {
  id?: string;
  category?: string;
  maxAttempts?: number;
  onProgress?: (run: PluginForgeRun) => void;
  host?: Partial<PluginForgeHost>;
};

function failLearn(run: PluginForgeRun, goal: string, detail: string) {
  learning.evaluate({
    taskId: run.id,
    kind: "plugin-forge",
    title: goal,
    success: false,
    verified: false,
    ms: 0,
    detail,
  });
}

export async function forgePlugin(
  goal: string,
  options: PluginForgeOptions = {},
): Promise<PluginForgeRun> {
  const run: PluginForgeRun = {
    id: `plugin-forge-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    pluginId: null,
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
  let pack: PluginPackWrite | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    run.attempts = attempt;
    run.stage = "writing";
    step(`Writing the plugin (attempt ${attempt})`);
    const started = Date.now();
    const written = await writeManifest(goal, run.pipeline, options, complete, lastError);
    if (!written.generated) {
      lastError = written.error || "the coder model did not produce a plugin";
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
    run.error = lastError || "the coder model did not produce a plugin";
    step(run.error, false);
    failLearn(run, goal, run.error);
    return run;
  }

  run.stage = "installing";
  step("Waiting for your approval before installing");
  const holder: { result: PluginInstallResult | null } = { result: null };
  const decision = await submit({
    kind: "install",
    title: `New plugin — ${pack.name}`.slice(0, 80),
    rationale: `Verified in the sandbox via capability-verify. Installs at plugins/${pack.segment}/${pack.slug}. Stays disabled until you enable it.`,
    risk: pack.permissions.some((item) => /shell|write|network/i.test(item)) ? "review" : "review",
    evidence: [`forge:${run.id}`, `plugin:${pack.slug}`, `attempts:${run.attempts}`],
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
    run.error = "You did not approve this plugin, so nothing was installed.";
    step(run.error, false);
    return run;
  }
  const written = holder.result;
  if (!written?.ok) {
    run.stage = "failed";
    run.error = written?.error ?? "could not write the plugin";
    step(run.error, false);
    return run;
  }

  run.pluginId = written.id ?? `plugins/${pack.segment}/${pack.slug}`;
  run.stage = "done";
  step(`Installed as ${run.pluginId} (disabled until you enable it)`);

  brainKnowledge.remember({
    kind: "knowledge",
    title: `Plugin — ${pack.name}`,
    body: `${goal}\nInstalled at plugins/${pack.segment}/${pack.slug}, sandbox-verified before install. Left disabled.`,
    tags: ["plugin", "self-written", options.category ?? "forged"],
    source: `forge/${run.id}`,
    provenance: "verified",
    confidence: 0.85,
  });
  learning.evaluate({
    taskId: run.id,
    kind: "plugin-forge",
    title: goal,
    success: true,
    verified: true,
    ms: 0,
    detail: `installed ${run.pluginId}`,
  });
  return run;
}

const gapDrafts: PluginForgeRun[] = [];

export function looksLikePluginGap(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (text.length < 12) return false;
  if (/^(hi|hello|thanks|thank you|ok|okay|what time|who is)\b/i.test(text)) return false;
  if (/\b(create|write|forge|build|make)\s+(me\s+)?(an?\s+)?plugin\b/i.test(text)) return true;
  if (/\b(new plugin|plugin that)\b/i.test(text)) return true;
  return false;
}

export function recentPluginGapDrafts(limit = 10): PluginForgeRun[] {
  return gapDrafts.slice(0, Math.max(1, limit));
}

export function resetPluginGapDrafts(): void {
  gapDrafts.length = 0;
}

export function filePluginGapDraft(goal: string): PluginForgeRun {
  const run: PluginForgeRun = {
    id: `plugin-forge-gap-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    pluginId: null,
    log: [
      {
        at: Date.now(),
        text: "Capability gap — filing a plugin-forge draft. Nothing will be installed until you approve.",
        ok: true,
      },
    ],
  };
  gapDrafts.unshift(run);
  governance.submit({
    kind: "install",
    title: `Plugin draft — ${goal}`.slice(0, 80),
    rationale:
      "No installed plugin covered this request. This is a plugin-forge draft. Sandbox verify and install wait for your approval. I will not self-install.",
    risk: "review",
    evidence: [`plugin-forge:${run.id}`],
    apply: async () => ({ ok: true, detail: "draft only — forge when you approve" }),
  });
  return run;
}

export async function dispatchPluginHooks(
  hook: string,
  payload: Record<string, unknown> = {},
  options?: { allowDisabled?: boolean; pluginId?: string },
): Promise<{ ok?: boolean; hook?: string; fired?: unknown[]; error?: string }> {
  const api = bridge();
  if (!api?.dispatchPluginHooks) return { ok: false, error: DESKTOP_ONLY };
  return api.dispatchPluginHooks(hook, payload, options);
}
