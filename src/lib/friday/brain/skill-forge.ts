/**
 * FRIDAY · skill forge
 *
 * How FRIDAY grows. A goal comes in, she plans it with her own brain, asks the
 * best available model to write the skill, verifies the code in her sandbox,
 * and only then installs it. Every stage is a real step — nothing is marked
 * done that did not run.
 *
 * Lifecycle: draft → verify → install → active → measured → improved → retired.
 */

import { brainKnowledge } from "./knowledge-base";
import { identity } from "./identity";
import { planPipeline, recordStep, type Pipeline } from "./orchestrator";
import { governance } from "../self/governance";
import { learning } from "../self/learning-engine";
import { experiences, findRecentSubTask } from "../self/task-ledger";
import kernelApi from "../kernel-api";
import { connectorTools, invokeApprovedConnectorAction } from "../connectors";
import { isOwnerWorkSkill, OWNER_WORK_SKILLS, runOwnerWorkSkill } from "../owner-work";

export type SkillManifest = {
  id: string;
  name: string;
  summary: string;
  category: string;
  capabilities: string[];
  risk: "safe" | "write" | "exec";
  inputs: string[];
  version: number;
  author: string;
  enabled: boolean;
  builtin: boolean;
  runs: number;
  failures: number;
  dir?: string | null;
};

export type ForgeStage = "planning" | "writing" | "verifying" | "installing" | "done" | "failed";

export type ForgeRun = {
  id: string;
  goal: string;
  stage: ForgeStage;
  attempts: number;
  pipeline: Pipeline | null;
  skillId: string | null;
  log: { at: number; text: string; ok: boolean }[];
  error?: string;
};

type SkillWriteResult = { ok: boolean; skill?: SkillManifest; error?: string };

type SkillsBridge = {
  listSkills?: () => Promise<{ ok: boolean; skills: SkillManifest[] }>;
  readSkill?: (
    id: string,
  ) => Promise<{ ok: boolean; skill?: SkillManifest; code?: string; error?: string }>;
  writeSkill?: (skill: Record<string, unknown>) => Promise<SkillWriteResult>;
  removeSkill?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  rollbackSkill?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  setSkillEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  verifySkill?: (candidate: { code: string; sample?: unknown; allowNetwork?: boolean }) => Promise<{
    ok: boolean;
    output?: string;
    value?: unknown;
    ms?: number;
  }>;
  invokeSkill?: (
    id: string,
    input?: unknown,
    options?: { allowDisabled?: boolean },
  ) => Promise<{ ok: boolean; value?: unknown; error?: string; ms?: number }>;
};

const bridge = (): SkillsBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.friday as unknown as SkillsBridge | undefined);

export const skillsAvailable = (): boolean => Boolean(bridge()?.listSkills);

const DESKTOP_ONLY =
  "Skills live in the FRIDAY workspace — open the desktop app to create or run them.";

/* --------------------------------------------------------------- registry */

export async function listSkills(): Promise<SkillManifest[]> {
  const local = OWNER_WORK_SKILLS;
  const api = bridge();
  if (!api?.listSkills) return [...local];
  try {
    const response = await api.listSkills();
    const remote = response?.skills ?? [];
    const seen = new Set(local.map((item) => item.id));
    return [...local, ...remote.filter((item) => item?.id && !seen.has(item.id))];
  } catch {
    return [...local];
  }
}

export async function readSkill(id: string) {
  const api = bridge();
  if (!api?.readSkill) return { ok: false as const, error: DESKTOP_ONLY };
  return api.readSkill(id);
}

export async function setSkillEnabled(id: string, enabled: boolean) {
  const api = bridge();
  if (!api?.setSkillEnabled) return { ok: false as const, error: DESKTOP_ONLY };
  return api.setSkillEnabled(id, enabled);
}

export async function removeSkill(id: string) {
  const api = bridge();
  if (!api?.removeSkill) return { ok: false as const, error: DESKTOP_ONLY };
  return api.removeSkill(id);
}

export async function rollbackSkill(id: string) {
  const api = bridge();
  if (!api?.rollbackSkill) return { ok: false as const, error: DESKTOP_ONLY };
  return api.rollbackSkill(id);
}

/** Run a skill and feed the outcome back into learning. */
export async function invokeSkill(
  id: string,
  input: Record<string, unknown> = {},
  options: { allowDisabled?: boolean } = {},
) {
  const started = Date.now();
  const wantsDocument =
    id === "tender.read" &&
    Boolean(input["path"] || input["url"] || input["bytes"] || input["filename"]);
  if (isOwnerWorkSkill(id) && !wantsDocument) {
    const result = await runOwnerWorkSkill(id, input);
    learning.evaluate({
      taskId: `skill-${id}-${started.toString(36)}`,
      kind: "skill",
      title: id,
      success: Boolean(result?.ok),
      verified: Boolean(result?.ok),
      ms: result?.ms ?? Date.now() - started,
      ...("error" in result && result.error ? { detail: String(result.error) } : {}),
    });
    return result;
  }
  const api = bridge();
  if (!api?.invokeSkill) return { ok: false as const, error: DESKTOP_ONLY };
  const result = await api.invokeSkill(id, input, options);
  learning.evaluate({
    taskId: `skill-${id}-${started.toString(36)}`,
    kind: "skill",
    title: id,
    success: Boolean(result?.ok),
    verified: Boolean(result?.ok),
    ms: result?.ms ?? Date.now() - started,
    ...(result?.error ? { detail: result.error } : {}),
  });
  return result;
}

/* ------------------------------------------------------------------ forge */

function isDraftStub(code: string): boolean {
  return /FRIDAY skill draft/.test(code) && /return \{ ok: true, goal:/.test(code);
}

const FORGE_PROMPT = (goal: string, previousError?: string) =>
  [
    identity.compile(),
    "",
    "You are writing one of your own skills.",
    "Return ONLY JavaScript (ESM). Define and export `async function run(input)`.",
    "No imports of packages that are not built into Node. No network unless the goal needs it.",
    "Return a plain JSON-serialisable value from run().",
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
      .join("-") || `skill-${Date.now().toString(36)}`
  );
}

function extractSkillCode(text: string): string {
  const trimmed = String(text ?? "").trim();
  const fenced = /```(?:js|javascript|ts)?\n([\s\S]*?)```/.exec(trimmed);
  const code = String(fenced?.[1] ?? trimmed).trim();
  if (!code || isDraftStub(code) || !/function\s+run|const\s+run\s*=/.test(code)) return "";
  return code;
}

/** Ask the routed coder model for skill code. Never installs a silent stub. */
export async function writeCode(
  goal: string,
  pipeline: Pipeline,
  previousError?: string,
): Promise<{ code: string; generated: boolean; error?: string }> {
  const coder = pipeline.steps.find((step) => step.role === "coder") ?? pipeline.steps[0];
  if (coder?.reused) {
    const hit = findRecentSubTask("coder", goal);
    const reused = hit ? extractSkillCode(String(hit.result ?? "")) : "";
    if (reused) return { code: reused, generated: true };
  }
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
    const code = extractSkillCode(String(response.text ?? ""));
    if (!code) {
      return {
        code: "",
        generated: false,
        error: "the coder model did not return a run() skill",
      };
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

export type ForgeOptions = {
  id?: string;
  category?: string;
  capabilities?: string[];
  risk?: "safe" | "write" | "exec";
  sample?: Record<string, unknown>;
  maxAttempts?: number;
  onProgress?: (run: ForgeRun) => void;
  /**
   * Owner's destination choice. Empty/absent = keep it in FRIDAY only.
   * A repo ("owner/name" or its URL) means: install locally AND push the skill
   * there — both under the ONE governance approval below, never a second gate.
   */
  publishTo?: string;
  publishBranch?: string;
};

/** Push one forged skill to GitHub through the connector's write action. */
async function pushSkillToGithub(
  repo: string,
  id: string,
  goal: string,
  code: string,
  branch?: string,
): Promise<{ ok: boolean; detail: string }> {
  const tool = connectorTools().find((entry) => entry.tool === "connector.github.put-file");
  if (!tool) return { ok: false, detail: "the GitHub connector has no write action" };
  if (!tool.connected) return { ok: false, detail: "GitHub is not connected" };
  const result = await invokeApprovedConnectorAction(tool, {
    repo,
    path: `skills/${id}/skill.mjs`,
    content: code,
    message: `FRIDAY: add skill ${id} — ${goal.slice(0, 60)}`,
    ...(branch ? { branch } : {}),
  });
  return {
    ok: Boolean(result.ok),
    detail: result.ok
      ? (result.lines?.[0] ?? `pushed to ${repo}`)
      : (result.error ?? "push failed"),
  };
}

/** Create a new skill for a goal — plan, write, verify in the sandbox, install. */
export async function forgeSkill(goal: string, options: ForgeOptions = {}): Promise<ForgeRun> {
  const api = bridge();
  const run: ForgeRun = {
    id: `forge-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    skillId: null,
    log: [],
  };
  const step = (text: string, ok = true) => {
    run.log.push({ at: Date.now(), text, ok });
    options.onProgress?.({ ...run, log: [...run.log] });
  };

  if (!api?.writeSkill || !api.verifySkill) {
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
    step(`Writing the skill (attempt ${attempt})`);
    const started = Date.now();
    const written = await writeCode(goal, run.pipeline, lastError);
    if (!written.generated) {
      lastError = written.error || "the coder model did not produce skill code";
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
          kind: "skill-forge",
          title: goal,
          success: false,
          verified: false,
          ms: 0,
          detail: lastError,
        });
        return run;
      }
      const failedId = run.pipeline.steps.find((s) => s.role === "coder")?.modelId ?? undefined;
      run.pipeline = planPipeline({
        prompt: goal,
        needsCode: true,
        ...(failedId ? { excludeModelIds: [failedId] } : {}),
      });
      const nextCoder = run.pipeline.steps.find((s) => s.role === "coder");
      if (nextCoder?.modelId && nextCoder.modelId !== failedId) {
        step(`switching coder to ${nextCoder.modelLabel} after the previous model failed`);
      } else {
        step("no alternate coder — retrying the same model");
      }
      continue;
    }
    code = written.code;

    run.stage = "verifying";
    step("Verifying in the sandbox");
    const verified = await api.verifySkill({
      code,
      sample: options.sample ?? {},
      allowNetwork: (options.capabilities ?? []).includes("web.access"),
    });
    recordStep({
      taskId: run.id,
      role: "coder",
      modelId: run.pipeline.steps.find((s) => s.role === "coder")?.modelId ?? null,
      ok: Boolean(verified?.ok),
      ms: Date.now() - started,
      prompt: goal,
      ...(verified?.ok ? { answer: code } : { error: verified?.output ?? "sandbox failed" }),
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
        kind: "skill-forge",
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
  // A skill FRIDAY wrote herself only lands after the owner says yes
  // (governance "skill" kind is in ALWAYS_ASK_KINDS).
  step("Waiting for your approval before installing");
  const holder: { result: SkillWriteResult | null } = { result: null };
  const publishTo = (options.publishTo ?? "").trim();
  const pushed: { value: { ok: boolean; detail: string } | null } = { value: null };
  const decision = await governance.submit({
    kind: "skill",
    title: `New skill — ${goal.slice(0, 60)}`,
    rationale: publishTo
      ? `Verified in the sandbox. Installs at skills/${options.category ?? "custom"}/${id} AND pushes it to ${publishTo} on GitHub.`
      : `Verified in the sandbox. Installs at skills/${options.category ?? "custom"}/${id}. Stays in FRIDAY only.`,
    risk: publishTo || (options.risk ?? "safe") === "exec" ? "risky" : "review",
    evidence: [
      `forge:${run.id}`,
      `skill:${id}`,
      `attempts:${run.attempts}`,
      publishTo ? `github:${publishTo}` : "destination:local-only",
    ],
    apply: async () => {
      holder.result = await api.writeSkill!({
        id,
        name: goal.slice(0, 60),
        summary: goal,
        category: options.category ?? "custom",
        capabilities: options.capabilities ?? [],
        risk: options.risk ?? "safe",
        inputs: Object.keys(options.sample ?? {}),
        code,
        author: "friday",
      });
      if (!holder.result?.ok) {
        return { ok: false, detail: holder.result?.error ?? "write failed" };
      }
      // The GitHub push is part of the SAME approved action — the owner
      // approved "install locally and push", so it runs here or not at all.
      if (publishTo) {
        pushed.value = await pushSkillToGithub(
          publishTo,
          id,
          goal,
          code,
          options.publishBranch ?? "",
        );
        return {
          ok: pushed.value.ok,
          detail: `installed ${id}; ${pushed.value.detail}`,
        };
      }
      return { ok: true, detail: `installed ${id}` };
    },
  });
  if (decision.stage === "rejected") {
    run.stage = "failed";
    run.error = "You did not approve this skill, so nothing was installed.";
    step(run.error, false);
    return run;
  }
  const written = holder.result;
  if (!written?.ok) {
    run.stage = "failed";
    run.error = written?.error ?? "could not write the skill";
    step(run.error, false);
    return run;
  }

  run.skillId = written.skill?.id ?? id;
  run.stage = "done";
  step(`Installed as ${run.skillId} v${written.skill?.version ?? 1}`);
  if (publishTo)
    step(`GitHub — ${pushed.value?.detail ?? "push did not run"}`, Boolean(pushed.value?.ok));

  brainKnowledge.remember({
    kind: "skill",
    title: `Skill — ${written.skill?.name ?? id}`,
    body: `${goal}\nInstalled at skills/custom/${run.skillId}, verified in the sandbox before install.`,
    tags: ["skill", "self-written", options.category ?? "custom"],
    source: `forge/${run.id}`,
    provenance: "verified",
    confidence: 0.85,
  });
  learning.evaluate({
    taskId: run.id,
    kind: "skill-forge",
    title: goal,
    success: true,
    verified: true,
    ms: 0,
    detail: `installed ${run.skillId}`,
  });
  return run;
}

/**
 * Improve an existing skill: re-plan, rewrite with the failure history in hand
 * and install as the next version. The previous version stays for rollback.
 */
export async function improveSkill(
  id: string,
  reason: string,
  options: ForgeOptions = {},
): Promise<ForgeRun> {
  const existing = await readSkill(id);
  const goal =
    existing.ok && existing.skill ? `${existing.skill.summary} — improvement: ${reason}` : reason;
  return forgeSkill(goal, { ...options, id });
}

/** Skills that are measurably struggling and deserve an upgrade pass. */
export function upgradeCandidates(
  skills: SkillManifest[],
): { skill: SkillManifest; reason: string }[] {
  return skills
    .filter((skill) => !skill.builtin && skill.runs >= 3)
    .map((skill) => {
      const rate = skill.failures / Math.max(skill.runs, 1);
      return rate >= 0.34
        ? {
            skill,
            reason: `fails ${Math.round(rate * 100)}% of runs (${skill.failures}/${skill.runs})`,
          }
        : null;
    })
    .filter((entry): entry is { skill: SkillManifest; reason: string } => entry !== null);
}

/* ------------------------------------------------------- learned skills -- */

/**
 * A habit worth keeping: the same kind of task, done the same way, verified
 * successful several times over. FRIDAY notices it herself from the experience
 * store — she does not invent candidates out of nothing.
 */
export type LearnedSkillCandidate = {
  approach: string;
  kind: string;
  title: string;
  count: number;
  lastAt: number;
  goal: string;
};

const learnedSkillId = (approach: string) =>
  `learned-${approach
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)}`;

/**
 * Repeated, verified approaches that are not a skill yet.
 * Read-only: proposing one still goes through `forgeLearnedSkill`, which is
 * governance-gated like every other skill install.
 */
export function learnedSkillCandidates(
  installed: SkillManifest[] = [],
  minCount = 3,
): LearnedSkillCandidate[] {
  const known = new Set(installed.map((skill) => skill.id));
  return experiences
    .repeatedApproaches(minCount)
    .filter((habit) => !known.has(learnedSkillId(habit.approach)))
    .map((habit) => ({
      ...habit,
      goal: `Reusable skill for "${habit.title}" — this ${habit.kind} task has succeeded ${habit.count} times using the same approach (${habit.approach}). Capture that approach as a repeatable skill.`,
    }));
}

/**
 * Turn one noticed habit into a real skill. Same forge path as any other:
 * planned, written, sandbox-verified, and installed only after the owner
 * approves it at the governance gate.
 */
export async function forgeLearnedSkill(
  candidate: LearnedSkillCandidate,
  options: ForgeOptions = {},
): Promise<ForgeRun> {
  return forgeSkill(candidate.goal, {
    ...options,
    id: learnedSkillId(candidate.approach),
    category: options.category ?? "learned",
  });
}

const gapDrafts: ForgeRun[] = [];

/**
 * Conservative: only when the owner is clearly asking for a new/repeatable
 * skill, not ordinary chat or a one-off question.
 */
export function looksLikeCapabilityGap(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (text.length < 12) return false;
  if (/^(hi|hello|thanks|thank you|ok|okay|what time|who is)\b/i.test(text)) return false;
  if (/\b(create|write|forge|build|make)\s+(me\s+)?(a\s+)?skill\b/i.test(text)) return true;
  if (/\b(new skill|skill that|automate|whenever i|every time i)\b/i.test(text)) return true;
  return false;
}

export function recentSkillGapDrafts(limit = 10): ForgeRun[] {
  return gapDrafts.slice(0, Math.max(1, limit));
}

export function resetSkillGapDrafts(): void {
  gapDrafts.length = 0;
}

/**
 * File a real skill-forge draft through the existing governance "skill"
 * lifecycle. Nothing is written or installed here — `forgeSkill()` still
 * does sandbox-verify + owner approval when the desktop bridge is present
 * and the owner later approves.
 */
export function fileSkillGapDraft(goal: string): ForgeRun {
  const run: ForgeRun = {
    id: `forge-gap-${Date.now().toString(36)}`,
    goal,
    stage: "planning",
    attempts: 0,
    pipeline: null,
    skillId: null,
    log: [
      {
        at: Date.now(),
        text: "Capability gap — filing a skill-forge draft. Nothing will be installed until you approve.",
        ok: true,
      },
    ],
  };
  const item = governance.discover({
    id: `gov:skill-gap:${slug(goal)}`,
    kind: "skill",
    title: `New skill draft — ${goal.slice(0, 60)}`,
    rationale:
      "No installed skill covered this request. This is a skill-forge draft. Sandbox verify and install wait for your approval. I will not self-install.",
    risk: "review",
    evidence: [`gap:${goal.slice(0, 240)}`, `forge:${run.id}`],
  });
  run.log.push({
    at: Date.now(),
    text: `Queued as ${item.id} (${item.stage}). Approval required before install.`,
    ok: true,
  });
  if (!bridge()?.writeSkill) {
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
