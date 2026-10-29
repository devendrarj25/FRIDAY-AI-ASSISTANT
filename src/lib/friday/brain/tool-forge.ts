/**
 * FRIDAY · tool forge
 *
 * Same lifecycle as skill forge: plan → coder model writes run() → sandbox
 * verify → owner approval → install as tool.json + index.cjs. Never installs
 * a silent stub. Reuses chat.complete, governance, and the tool-runtime
 * sandbox — no second writer.
 */

import { identity } from "./identity";
import { planPipeline, recordStep, type Pipeline } from "./orchestrator";
import { governance } from "../self/governance";
import { learning } from "../self/learning-engine";
import kernelApi from "../kernel-api";
import { isDesktopApp } from "../desktop";

export type ToolPackManifest = {
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
  /** False when the pack has no loadable index.cjs / index.js / tool.cjs. */
  runnable?: boolean;
  healthy?: boolean;
};

export type ToolForgeStage =
  "planning" | "writing" | "verifying" | "installing" | "done" | "failed";

export type ToolForgeRun = {
  id: string;
  goal: string;
  stage: ToolForgeStage;
  attempts: number;
  pipeline: Pipeline | null;
  toolId: string | null;
  log: { at: number; text: string; ok: boolean }[];
  error?: string;
};

type ToolBridge = {
  listToolPacks?: () => Promise<{ ok: boolean; tools: ToolPackManifest[] }>;
  writeToolPack?: (pack: Record<string, unknown>) => Promise<{
    ok: boolean;
    id?: string;
    error?: string;
  }>;
  verifyToolPack?: (candidate: {
    code: string;
    sample?: unknown;
    allowNetwork?: boolean;
  }) => Promise<{ ok: boolean; output?: string; value?: unknown; ms?: number }>;
  invokeToolPack?: (
    id: string,
    input?: unknown,
    options?: { allowDisabled?: boolean },
  ) => Promise<{ ok: boolean; value?: unknown; error?: string; ms?: number }>;
};

const DESKTOP_ONLY = "This change needs the FRIDAY desktop app.";

const bridge = (): ToolBridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as ToolBridge | undefined);

function isDraftStub(code: string): boolean {
  return /Healed stub/.test(code) && /healed: true/.test(code);
}

const FORGE_PROMPT = (goal: string, previousError?: string) =>
  [
    identity.compile(),
    "",
    "You are writing one of your own tools for the Tools page.",
    "Return ONLY JavaScript (CommonJS). Define `async function run(input)` and `module.exports = { run }`.",
    "No imports of packages that are not built into Node. No network unless the goal needs it.",
    "Return a plain JSON-serialisable value from run(), including `{ ok: true }` on success.",
    "",
    `Goal: ${goal}`,
    previousError
      ? `\nThe previous attempt failed in the sandbox with:\n${previousError}\nFix it.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

function slug(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 4)
      .join("-") || `tool-${Date.now().toString(36)}`
  );
}

function wordsFromGoal(goal: string): string[] {
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "for",
    "with",
    "that",
    "this",
    "tool",
    "tools",
  ]);
  return [...new Set(goal.toLowerCase().match(/[a-z0-9+#.]{4,}/g) ?? [])]
    .filter((word) => !stop.has(word))
    .slice(0, 12);
}

async function writeCode(
  goal: string,
  pipeline: Pipeline,
  previousError?: string,
): Promise<{ code: string; generated: boolean; error?: string }> {
  const coder = pipeline.steps.find((step) => step.role === "coder") ?? pipeline.steps[0];
  const modelIds = coder?.modelId ? [coder.modelId] : [];
  try {
    const response = await kernelApi.chat.complete(
      [{ role: "user", content: FORGE_PROMPT(goal, previousError) }],
      modelIds,
    );
    if (!response?.ok) {
      return {
        code: "",
        generated: false,
        error: response?.error || "the coder model did not answer",
      };
    }
    const text = String(response.text ?? "").trim();
    const fenced = /```(?:js|javascript|cjs|ts)?\n([\s\S]*?)```/.exec(text);
    let code = String(fenced?.[1] ?? text).trim();
    if (!code || isDraftStub(code) || !/function\s+run|const\s+run\s*=/.test(code)) {
      return {
        code: "",
        generated: false,
        error: "the coder model did not return a run() tool",
      };
    }
    if (!/module\.exports|exports\.run/.test(code)) {
      code = `${code}\nmodule.exports = { run };\n`;
    }
    return { code, generated: true };
  } catch (error) {
    return {
      code: "",
      generated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type ToolForgeOptions = {
  id?: string;
  category?: string;
  permissions?: string[];
  risk?: "safe" | "write" | "exec";
  sample?: Record<string, unknown>;
  maxAttempts?: number;
  onProgress?: (run: ToolForgeRun) => void;
};

export async function forgeTool(
  goal: string,
  options: ToolForgeOptions = {},
): Promise<ToolForgeRun> {
  const api = bridge();
  const run: ToolForgeRun = {
    id: `tool-forge-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    toolId: null,
    log: [],
  };
  const step = (text: string, ok = true) => {
    run.log.push({ at: Date.now(), text, ok });
    options.onProgress?.({ ...run, log: [...run.log] });
  };

  if (!isDesktopApp() || !api?.writeToolPack || !api.verifyToolPack) {
    run.stage = "failed";
    run.error = DESKTOP_ONLY;
    step(DESKTOP_ONLY, false);
    return run;
  }

  run.pipeline = planPipeline({ prompt: goal, needsCode: true });
  step(`Planned with ${run.pipeline.steps.map((s) => `${s.role}:${s.modelLabel}`).join(", ")}`);

  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: string | undefined;
  let code = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    run.attempts = attempt;
    run.stage = "writing";
    step(`Writing the tool (attempt ${attempt})`);
    const started = Date.now();
    const written = await writeCode(goal, run.pipeline, lastError);
    if (!written.generated) {
      lastError = written.error || "the coder model did not produce tool code";
      step(lastError, false);
      recordStep({
        taskId: run.id,
        role: "coder",
        modelId: run.pipeline.steps.find((s) => s.role === "coder")?.modelId ?? null,
        ok: false,
        ms: Date.now() - started,
        error: lastError,
      });
      if (attempt === maxAttempts) {
        run.stage = "failed";
        run.error = lastError;
        learning.evaluate({
          taskId: run.id,
          kind: "tool-forge",
          title: goal,
          success: false,
          verified: false,
          ms: 0,
          detail: lastError,
        });
        return run;
      }
      continue;
    }
    code = written.code;

    run.stage = "verifying";
    step("Verifying in the sandbox");
    const verified = await api.verifyToolPack({
      code,
      sample: options.sample ?? {},
      allowNetwork: (options.permissions ?? []).some((p) => /web|net/i.test(p)),
    });
    recordStep({
      taskId: run.id,
      role: "coder",
      modelId: run.pipeline.steps.find((s) => s.role === "coder")?.modelId ?? null,
      ok: Boolean(verified?.ok),
      ms: Date.now() - started,
      ...(verified?.ok ? {} : { error: verified?.output ?? "sandbox failed" }),
    });

    if (verified?.ok) {
      step(`Sandbox run passed in ${verified.ms ?? 0}ms`);
      break;
    }
    lastError = verified?.output?.slice(-800) ?? "sandbox run failed";
    step(`Sandbox rejected the draft: ${lastError.split("\n").slice(-1)[0]}`, false);
    if (attempt === maxAttempts) {
      run.stage = "failed";
      run.error = lastError;
      learning.evaluate({
        taskId: run.id,
        kind: "tool-forge",
        title: goal,
        success: false,
        verified: false,
        ms: 0,
        detail: lastError,
      });
      return run;
    }
  }

  run.stage = "installing";
  const id = options.id ?? slug(goal);
  const name = goal.slice(0, 60);
  step("Waiting for your approval before installing");
  const holder: { result: { ok: boolean; id?: string; error?: string } | null } = { result: null };
  const decision = await governance.submit({
    kind: "install",
    title: `New tool — ${name}`,
    rationale: `Verified in the sandbox. Installs at tools/${options.category ?? "custom"}/${id}. Stays disabled until you enable it.`,
    risk: (options.risk ?? "safe") === "exec" ? "risky" : "review",
    evidence: [`forge:${run.id}`, `tool:${id}`, `attempts:${run.attempts}`],
    apply: async () => {
      holder.result = await api.writeToolPack!({
        id,
        slug: id,
        name,
        description: goal,
        category: options.category ?? "custom",
        segment: options.category ?? "custom",
        tree: "tools",
        permissions: options.permissions ?? [],
        risk: options.risk ?? "safe",
        inputs: Object.keys(options.sample ?? {}),
        keywords: wordsFromGoal(goal),
        code,
        author: "friday",
        approvalPrompt: `FRIDAY wants to run the new tool “${name}”. Allow this?`,
      });
      if (!holder.result?.ok) {
        return { ok: false, detail: holder.result?.error ?? "write failed" };
      }
      return { ok: true, detail: `installed ${holder.result.id || id}` };
    },
  });
  if (decision.stage === "rejected") {
    run.stage = "failed";
    run.error = "You did not approve this tool, so nothing was installed.";
    step(run.error, false);
    return run;
  }
  const written = holder.result;
  if (!written?.ok) {
    run.stage = "failed";
    run.error = written?.error ?? "could not write the tool";
    step(run.error, false);
    return run;
  }

  run.toolId = written.id ?? `tools/custom/${id}`;
  run.stage = "done";
  step(`Installed as ${run.toolId}`);
  learning.evaluate({
    taskId: run.id,
    kind: "tool-forge",
    title: goal,
    success: true,
    verified: true,
    ms: 0,
    detail: run.toolId,
  });
  return run;
}

export async function listToolPacks(): Promise<ToolPackManifest[]> {
  const api = bridge();
  if (!api?.listToolPacks) return [];
  const result = await api.listToolPacks();
  const tools = result?.tools ?? [];
  return tools.map((item) => ({
    id: String(item.id || ""),
    name: String(item.name || item.id || "tool"),
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

export async function invokeToolPack(
  id: string,
  input?: unknown,
  options?: { allowDisabled?: boolean },
) {
  const api = bridge();
  if (!api?.invokeToolPack) return { ok: false as const, error: DESKTOP_ONLY };
  return api.invokeToolPack(id, input, options);
}
