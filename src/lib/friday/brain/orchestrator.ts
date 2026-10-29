/**
 * FRIDAY · model orchestration
 *
 * Decides, per task, which model does which part of the work — so the owner
 * never has to pick a model for every request.
 *
 * Principles:
 *  - Offline first. A capable local model always wins when it can do the job.
 *  - Cloud only when it genuinely adds capability the local models lack, or
 *    when nothing local is available for that role.
 *  - Only the roles the task actually needs. A greeting does not get a
 *    planner, a coder, a reviewer and a tester.
 *  - Every choice is explainable, and every finished step is measured and fed
 *    back into the registry.
 */

import { brainKnowledge } from "./knowledge-base";
import {
  currentPolicy,
  describePolicy,
  freeProviders,
  orderByConfidence,
  orderByPolicy,
  type CloudChoice,
  type UsagePolicy,
} from "./cost-policy";
import { CONFIDENT_THRESHOLD, estimateConfidence, type Confidence } from "./confidence";
import { turnDone, turnMark } from "./turn-timing";
import {
  experiences,
  findRecentSubTask,
  ledger,
  rememberSubTask,
  subTaskKey,
  subTaskKind,
} from "../self/task-ledger";

import { modelRegistry, type ModelCapabilityRecord, type ModelRole } from "./model-registry";

export type TaskShape = {
  /** What the owner asked for, verbatim. */
  prompt: string;
  /** Set when FRIDAY already knows the kind of work (chat, build, repair…). */
  kind?: string;
  /** Same-turn id so an equivalent role can reuse a result already on the ledger. */
  taskId?: string;
  needsCode?: boolean;
  needsReasoning?: boolean;
  needsVision?: boolean;
  needsAudio?: boolean;
  /** Private work never leaves the machine, whatever the cloud offers. */
  private?: boolean;
  /** Model ids to skip for this plan (failed this turn; cooling handled in the registry). */
  excludeModelIds?: string[];
};

export type PipelineStep = {
  role: ModelRole;
  modelId: string | null;
  modelLabel: string;
  kind: "local" | "cloud" | "none";
  reason: string;
  /** True when this role is filled from a recent equivalent answer, not a new call. */
  reused?: boolean;
};

export type Pipeline = {
  steps: PipelineStep[];
  /** True when every needed role found a model. */
  complete: boolean;
  offline: boolean;
  notes: string[];
};

const CODE_HINTS = /\b(code|function|bug|error|refactor|compile|build|typescript|python|api)\b/i;
const REASON_HINTS =
  /\b(why|plan|design|architecture|compare|analyse|analyze|decide|strategy|tender|rfp|eligibility|submission requirements?)\b/i;
const VISION_HINTS = /\b(image|screenshot|picture|photo|diagram|see this)\b/i;
const AUDIO_HINTS = /\b(voice|speak|say|listen|transcribe|audio)\b/i;
const TRIVIAL = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no)\b/i;

/** Which roles this specific request needs — never more than necessary. */
export function rolesForTask(task: TaskShape): ModelRole[] {
  const text = task.prompt ?? "";
  if (TRIVIAL.test(text.trim()) && text.trim().length < 24) return ["fast"];

  const roles: ModelRole[] = [];
  const code = task.needsCode ?? CODE_HINTS.test(text);
  const reason = task.needsReasoning ?? REASON_HINTS.test(text);

  if (task.needsVision ?? VISION_HINTS.test(text)) roles.push("vision");
  if (task.needsAudio ?? AUDIO_HINTS.test(text)) roles.push("audio");
  if (reason || code) roles.push("planner");
  if (code) roles.push("coder", "reviewer");
  if (code && /\b(test|verify|check)\b/i.test(text)) roles.push("tester");
  if (reason && !code) roles.push("reasoner");
  if (!roles.length) roles.push("fast");
  return Array.from(new Set(roles));
}

/** Build the pipeline for a task from the models that are usable right now. */
export function planPipeline(task: TaskShape): Pipeline {
  turnMark("orchestrator", "planPipeline");
  const roles = rolesForTask(task);
  const notes: string[] = [];
  const available = modelRegistry.available();
  const anyLocal = available.some((record) => record.kind === "local");
  const offline = !available.some((record) => record.kind === "cloud");

  // A standing preference in the Brain ("always stay local") outranks defaults.
  const localOnly =
    task.private === true ||
    brainKnowledge
      .recall("local only offline privacy model preference", { kinds: ["preference"], k: 3 })
      .some((entry) => /local|offline|private/i.test(entry.body) && entry.permanent);

  if (localOnly) notes.push("staying on local models for this task");

  // The owner's usage policy applies to every planned step, not just routing.
  const policy = currentPolicy();
  const free = freeProviders();
  if (!localOnly) notes.push(describePolicy(policy));

  // How well can FRIDAY do this on her own? The answer, not a fixed rule,
  // decides whether local candidates lead the ordering.
  const confidence = estimateConfidence(task.prompt ?? "");
  if (!localOnly) notes.push(confidence.rationale);

  const used = new Set<string>();
  const steps = roles.map<PipelineStep>((role) => {
    const prior = findRecentSubTask(
      role,
      task.prompt ?? "",
      task.taskId ? { taskId: task.taskId } : undefined,
    );
    if (prior) {
      used.add(prior.modelId);
      const record = modelRegistry.get(prior.modelId);
      return {
        role,
        modelId: prior.modelId,
        modelLabel: record?.name ?? prior.modelId,
        kind: record?.kind ?? "none",
        reason: `reused equivalent ${role} result from ${prior.modelId} (${prior.sameTurn ? "this turn" : "a recent turn"})`,
        reused: true,
      };
    }

    const pool = modelRegistry
      .candidates(role, { preferLocal: true })
      .filter((record) => !localOnly || record.kind === "local");
    const excluded = new Set(task.excludeModelIds ?? []);
    const withoutFailed = excluded.size ? pool.filter((record) => !excluded.has(record.id)) : pool;
    // An empty alternate pool retries the original candidate honestly — never
    // invents a model that is not there.
    const ranked = withoutFailed.length ? withoutFailed : pool;
    const policyOrdered = localOnly
      ? orderByPolicy(ranked, policy, free)
      : orderCandidatesForRole(ranked, confidence, policy, free);
    const preferredId = task.kind && !localOnly ? experiences.preferredModelFor(task.kind) : null;
    const preferredOk =
      preferredId && ranked.some((record) => record.id === preferredId) ? preferredId : null;
    const candidates = preferredOk
      ? [
          ...policyOrdered.filter((record) => record.id === preferredOk),
          ...policyOrdered.filter((record) => record.id !== preferredOk),
        ]
      : policyOrdered;

    // Reuse of one model across two roles is fine; a fresh model is preferred
    // so a reviewer is not simply the coder marking its own work.
    const pick =
      candidates.find((record) => !used.has(record.id)) ?? candidates[0] ?? (null as never);

    if (!pick) {
      return {
        role,
        modelId: null,
        modelLabel: "no model available",
        kind: "none",
        reason: localOnly
          ? `no local model installed for ${role}`
          : `no installed or configured model can act as ${role}`,
      };
    }
    used.add(pick.id);
    return {
      role,
      modelId: pick.id,
      modelLabel: pick.name,
      kind: pick.kind,
      reason: explain(pick, role, anyLocal),
    };
  });

  if (offline) notes.push("no cloud provider is online — running fully offline");
  const cooling = modelRegistry.list().filter((record) => record.coolingDown);
  if (cooling.length) {
    notes.push(
      `skipped ${cooling.length} cooling-down model(s): ${cooling
        .slice(0, 3)
        .map((record) => record.name)
        .join(", ")}`,
    );
  }
  if (task.excludeModelIds?.length) {
    notes.push(`excluded failed model(s) this turn: ${task.excludeModelIds.join(", ")}`);
  }
  const complete = steps.every((step) => step.modelId !== null);
  if (!complete) notes.push("install a local model or configure a provider to complete this task");

  turnDone("orchestrator", "planPipeline", `${steps.length} role(s)`);
  return { steps, complete, offline, notes };
}

/**
 * True when at least one local candidate has already been measured above the
 * domain confidence threshold. Cost-policy precedence is unchanged: we only
 * flip the confidence signal that `orderByConfidence` already consults.
 */
export function hasProvenLocal(
  pool: ModelCapabilityRecord[],
  threshold: number = CONFIDENT_THRESHOLD,
): boolean {
  return pool.some(
    (record) =>
      record.kind === "local" && record.reliability !== null && record.reliability >= threshold,
  );
}

/**
 * Order role candidates with the existing cost-policy functions. When a local
 * model is already proven for this work, treat the task as locally confident
 * so cloud is not sorted first merely because the capability-matrix score is
 * still low. Unproven local models keep the historical fallback behaviour.
 */
export function orderCandidatesForRole(
  pool: ModelCapabilityRecord[],
  confidence: Confidence,
  policy: UsagePolicy = currentPolicy(),
  free: Set<string> = freeProviders(),
  choice?: CloudChoice,
): ModelCapabilityRecord[] {
  const effective: Confidence = hasProvenLocal(pool) ? { ...confidence, local: true } : confidence;
  return choice
    ? orderByConfidence(pool, effective, policy, free, choice)
    : orderByConfidence(pool, effective, policy, free);
}

function explain(record: ModelCapabilityRecord, role: ModelRole, anyLocal: boolean): string {
  const parts: string[] = [`${record.kind} model suited to ${role}`];
  if (record.reliability !== null) {
    parts.push(
      `${Math.round(record.reliability * 100)}% success over ${record.performance?.runs} runs`,
    );
    if (record.kind === "local" && record.reliability >= CONFIDENT_THRESHOLD) {
      parts.push(
        "measured reliability already above the domain confidence threshold — staying local",
      );
    }
  } else {
    parts.push("no measurements yet");
  }
  if (record.speed) parts.push(`${record.speed} tok/s measured`);
  if (record.kind === "cloud") {
    parts.push(
      anyLocal ? "chosen because no local model covers this role" : "no local model installed",
    );
  }
  return parts.join(" · ");
}

/** Report a finished step so the registry and the Brain both learn from it. */
export function recordStep(input: {
  taskId: string;
  role: ModelRole;
  modelId: string | null;
  ok: boolean;
  ms: number;
  tokensPerSec?: number;
  error?: string;
  prompt?: string;
  answer?: string;
}): void {
  if (!input.modelId) return;
  modelRegistry.recordRun({
    modelId: input.modelId,
    ok: input.ok,
    ms: input.ms,
    ...(input.tokensPerSec !== undefined ? { tokensPerSec: input.tokensPerSec } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  });

  // Model-performance knowledge is FRIDAY's own, not personal — no consent needed.
  const record = modelRegistry.get(input.modelId);
  // Real local-vs-cloud accounting: one entry per model call that actually ran.
  experiences.noteModelCall(input.modelId, record?.kind ?? "unknown", input.ok);
  if (input.ok && input.prompt && input.answer) {
    rememberSubTask({
      taskId: input.taskId,
      role: input.role,
      prompt: input.prompt,
      result: input.answer,
      modelId: input.modelId,
      success: true,
    });
  }
  if (!record) return;

  brainKnowledge.remember({
    kind: "knowledge",
    title: `Model performance — ${record.name} as ${input.role}`,
    body: input.ok
      ? `Completed a ${input.role} step in ${(input.ms / 1000).toFixed(1)}s${
          input.tokensPerSec ? ` at ${input.tokensPerSec.toFixed(1)} tok/s` : ""
        }.`
      : `Failed a ${input.role} step after ${(input.ms / 1000).toFixed(1)}s: ${input.error ?? "unknown error"}.`,
    tags: ["model-performance", input.role, record.kind],
    source: `task/${input.taskId}`,
    provenance: "verified",
    confidence: input.ok ? 0.8 : 0.6,
  });
}

/** One-line summary used in logs and the existing run detail panels. */
export function describePipeline(pipeline: Pipeline): string {
  return pipeline.steps
    .map((step) => `${step.role}: ${step.modelId ? step.modelLabel : "unavailable"}`)
    .join(" → ");
}

export type RoleDispatch<T = string> = {
  modelId: string;
  result: T;
  reused: boolean;
  tokens?: number;
  latencyMs?: number;
};

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Dispatch one role to a model, or reuse a recent equivalent answer already
 * on the task ledger / experience store. Concurrent identical keys still
 * coalesce through `ledger.run` — this is not a second cache.
 *
 * Collaboration (`considerCollaboration`) still fans out independently; pass
 * `allowReuse: false` when a second opinion must actually run.
 */
export async function dispatchRole<T = string>(input: {
  taskId?: string;
  role: ModelRole;
  prompt: string;
  run: () => Promise<{
    modelId: string;
    result: T;
    tokens?: number;
    latencyMs?: number;
    success?: boolean;
  }>;
  allowReuse?: boolean;
  /**
   * When false, skip model-performance / experience writes. Selection-only
   * dispatch must not count as a successful model run.
   */
  measure?: boolean;
}): Promise<RoleDispatch<T>> {
  const allowReuse = input.allowReuse !== false;
  const reuseOpts = input.taskId ? { taskId: input.taskId } : undefined;
  if (allowReuse) {
    const hit = findRecentSubTask(input.role, input.prompt, reuseOpts);
    if (hit) {
      return { modelId: hit.modelId, result: hit.result as T, reused: true };
    }
  }

  const { promise } = ledger.run(
    {
      kind: subTaskKind(input.role),
      title: (input.prompt ?? "").trim().slice(0, 280),
      key: subTaskKey(input.role, input.prompt),
    },
    async (ctx) => {
      if (allowReuse) {
        const inner = findRecentSubTask(input.role, input.prompt, reuseOpts);
        if (inner) {
          return { modelId: inner.modelId, result: inner.result as T, reused: true };
        }
      }
      const out = await input.run();
      ledger.note(ctx.id, { models: [out.modelId] });
      if (input.measure !== false) {
        recordStep({
          taskId: input.taskId ?? ctx.id,
          role: input.role,
          modelId: out.modelId,
          ok: out.success !== false,
          ms: out.latencyMs ?? 0,
          prompt: input.prompt,
          answer: asText(out.result),
        });
      }
      return {
        modelId: out.modelId,
        result: out.result,
        reused: false,
        ...(out.tokens !== undefined ? { tokens: out.tokens } : {}),
        ...(out.latencyMs !== undefined ? { latencyMs: out.latencyMs } : {}),
      } satisfies RoleDispatch<T>;
    },
  );
  return promise;
}

/**
 * First healthy id from the planned list, else the next role candidate.
 * Cooling-down models stay listed (honest) but are not selected.
 */
export function pickHealthyModelId(
  role: ModelRole,
  preferred: string[],
): { modelId: string | null; switched: boolean; reason?: string } {
  const wanted = preferred.filter(Boolean);
  if (!wanted.length) return { modelId: null, switched: false };
  const cooling = new Set(
    modelRegistry
      .list()
      .filter((record) => record.coolingDown)
      .map((record) => record.id),
  );
  const healthyPreferred = wanted.find((id) => !cooling.has(id)) ?? null;
  if (healthyPreferred) {
    return { modelId: healthyPreferred, switched: healthyPreferred !== wanted[0] };
  }
  const alternate = modelRegistry.candidates(role).find((record) => !wanted.includes(record.id));
  if (alternate) {
    return {
      modelId: alternate.id,
      switched: true,
      reason: `planned model cooling down — switching to ${alternate.name}`,
    };
  }
  return {
    modelId: wanted[0] ?? null,
    switched: false,
    ...(wanted[0] && cooling.has(wanted[0])
      ? { reason: "planned model is cooling down and no alternate is reachable" }
      : {}),
  };
}
