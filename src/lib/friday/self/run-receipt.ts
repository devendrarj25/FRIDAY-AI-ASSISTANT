/**
 * FRIDAY · one id scheme for a durable run.
 *
 * A task, a run, a step, an action and an evidence receipt share this module.
 * The task graph and the desktop loop both use it. There is no second ledger.
 */

import { nextRetryDelayMs } from "../bounded-retry";
import type { ApprovalLevel } from "./autonomy";

export type RunIdentity = {
  taskId: string;
  runId: string;
  stepId: string;
  actionId: string;
  evidenceId: string;
};

export type TaskBudget = {
  timeMs: number;
  maxSteps: number;
  /** Currency units. Zero means this run must not spend. */
  spend: number;
  tokens: number;
};

export type BudgetUse = {
  ms: number;
  steps: number;
  spend: number;
  tokens: number;
};

export type PerceptionStamp = {
  source: "uia" | "ocr" | "vision" | "none";
  confidence: number;
  /** Age of that perception when the step was recorded, in milliseconds. */
  ageMs: number;
  handoff?: "credential" | "payment" | "captcha" | "uac";
};

export type EvidenceReceipt = {
  evidenceId: string;
  taskId: string;
  runId: string;
  stepId: string;
  actionId: string;
  done: string;
  postcondition: string;
  checked: boolean;
  result: string;
  at: number;
  /** Local words only. A screenshot is never stored. */
  undoHint?: string;
  perception?: PerceptionStamp;
};

export type TimelineRow = {
  stepId: string;
  action: string;
  source: PerceptionStamp["source"];
  confidence: number | null;
  ageMs: number | null;
  postcondition: string;
  checked: boolean;
  result: string;
  undoHint: string;
  handoff: string;
};

/** Drops secrets and images. The timeline keeps a short local note. */
export function redactRunText(value: string): string {
  const secret = /(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi;
  const dataUrl = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
  const text = String(value || "")
    .replace(dataUrl, "[image omitted]")
    .replace(secret, "[redacted]");
  let clean = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    clean += char;
  }
  return clean.slice(0, 240);
}

/** One row per receipt. No pixels, no second store. */
export function timelineFromEvidence(rows: EvidenceReceipt[]): TimelineRow[] {
  return rows.map((row) => ({
    stepId: row.stepId,
    action: redactRunText(row.done),
    source: row.perception?.source ?? "none",
    confidence: row.perception ? row.perception.confidence : null,
    ageMs: row.perception ? Math.max(0, row.perception.ageMs) : null,
    postcondition: redactRunText(row.postcondition),
    checked: row.checked,
    result: redactRunText(row.result),
    undoHint: redactRunText(row.undoHint ?? ""),
    handoff: row.perception?.handoff ?? "",
  }));
}

let seq = 0;

/** Stable within one process. Tests do not read the clock from these ids. */
export function mintIdentity(taskId: string, stepOrdinal: number): RunIdentity {
  seq += 1;
  const stamp = seq.toString(36);
  return {
    taskId,
    runId: `${taskId}-run`,
    stepId: `${taskId}-step-${stepOrdinal}`,
    actionId: `${taskId}-action-${stamp}`,
    evidenceId: `${taskId}-evidence-${stamp}`,
  };
}

export function idempotencyKey(kind: string, target: string, payload: string): string {
  return `${kind}|${target}|${payload}`;
}

/** Same three-slot backoff as the kernel restart helper. Null means stop. */
export function retryBackoffMs(attemptIndex: number): number | null {
  return nextRetryDelayMs(attemptIndex);
}

/**
 * Why this run must stop, or null when another step is still allowed.
 * Time, steps, spend and tokens are all hard caps.
 */
/** Ask and Balanced wait. Full continues only when the owner chose Full. */
export function resumeOffer(level: ApprovalLevel): "ask" | "resume" {
  return level === "full" ? "resume" : "ask";
}

/**
 * A verified step is not replayed. A changed world, or a step that never
 * checked its postcondition, runs again so the check happens on fresh state.
 */
export function shouldReplay(checkpoint?: { checked?: boolean; worldChanged?: boolean }): boolean {
  if (!checkpoint) return true;
  if (checkpoint.worldChanged) return true;
  return checkpoint.checked !== true;
}

export function budgetBlock(budget: TaskBudget, used: BudgetUse): string | null {
  if (used.steps >= budget.maxSteps) return "step budget reached";
  if (used.ms > budget.timeMs) return "time budget reached";
  if (used.spend > budget.spend) return "spend budget reached";
  if (used.tokens > budget.tokens) return "token budget reached";
  return null;
}

/** A spoken yes and a click grant both expire. Eight seconds, then ask again. */
export const APPROVAL_TTL_MS = 8_000;

export const RUNTIME_EVENT_SCHEMA = 1;

const SECRET_KEY = /password|secret|token|api[_-]?key|authorization|credential/i;

export type RuntimeEvent = {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  request_id: string;
  session_id: string;
  task_id: string;
  run_id: string;
  producer: string;
  payload: Record<string, unknown>;
};

export type DurablePhase =
  | "created"
  | "planned"
  | "waiting_approval"
  | "ready"
  | "running"
  | "waiting_external"
  | "verifying"
  | "succeeded"
  | "failed"
  | "recovering"
  | "recovered"
  | "quarantined";

export type ApprovalGrant = {
  taskId: string;
  action: string;
  argumentHash: string;
  target: string;
  dataClass: string;
  risk: string;
  expiresAt: number;
  oneTime: true;
  approver: string;
  used: boolean;
};

export type CapabilityPhase =
  "discovered" | "qualified" | "installed" | "registered" | "healthy" | "authorized" | "available";

export type AuthorityScope = {
  capabilities: string[];
  network: boolean;
  spend: number;
};

let eventSeq = 0;

export function resetRuntimeEvents(): void {
  eventSeq = 0;
}

/** Stable short hash. Same arguments always bind to the same grant. */
export function argumentHash(args: string): string {
  let hash = 2166136261;
  const text = String(args ?? "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cleanPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (SECRET_KEY.test(key)) continue;
    clean[key] = typeof value === "string" ? redactRunText(value) : value;
  }
  return clean;
}

/**
 * One versioned envelope for a task transition. Secrets never ride in the payload.
 * Consumers may ignore fields they do not know.
 */
export function sealRuntimeEvent(input: {
  eventType: string;
  now: number;
  requestId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  producer: string;
  payload?: Record<string, unknown>;
}): RuntimeEvent {
  eventSeq += 1;
  return {
    event_id: `evt_${eventSeq.toString(36)}`,
    event_type: input.eventType,
    schema_version: RUNTIME_EVENT_SCHEMA,
    occurred_at: new Date(input.now).toISOString(),
    request_id: input.requestId,
    session_id: input.sessionId,
    task_id: input.taskId,
    run_id: input.runId,
    producer: input.producer,
    payload: cleanPayload(input.payload),
  };
}

/** Additive fields are kept out of the required check. A secret key is refused. */
export function acceptRuntimeEvent(
  raw: Record<string, unknown>,
): { ok: true; event: RuntimeEvent } | { ok: false; reason: string } {
  const required = [
    "event_id",
    "event_type",
    "schema_version",
    "occurred_at",
    "request_id",
    "session_id",
    "task_id",
    "run_id",
    "producer",
  ] as const;
  for (const key of required) {
    const value = raw[key];
    if (value == null || value === "") return { ok: false, reason: `missing ${key}` };
  }
  if (typeof raw["schema_version"] !== "number" || raw["schema_version"] < 1) {
    return { ok: false, reason: "schema_version" };
  }
  const payload =
    raw["payload"] && typeof raw["payload"] === "object"
      ? (raw["payload"] as Record<string, unknown>)
      : {};
  for (const key of Object.keys(payload)) {
    if (SECRET_KEY.test(key)) return { ok: false, reason: "secret payload" };
  }
  return {
    ok: true,
    event: {
      event_id: String(raw["event_id"]),
      event_type: String(raw["event_type"]),
      schema_version: raw["schema_version"] as number,
      occurred_at: String(raw["occurred_at"]),
      request_id: String(raw["request_id"]),
      session_id: String(raw["session_id"]),
      task_id: String(raw["task_id"]),
      run_id: String(raw["run_id"]),
      producer: String(raw["producer"]),
      payload,
    },
  };
}

/** Binds this yes to one action, one target, and one argument hash. */
export function bindApproval(input: {
  taskId: string;
  action: string;
  args: string;
  target: string;
  dataClass: string;
  risk: string;
  now: number;
  approver: string;
  ttlMs?: number;
}): ApprovalGrant {
  return {
    taskId: input.taskId,
    action: input.action,
    argumentHash: argumentHash(input.args),
    target: input.target,
    dataClass: input.dataClass,
    risk: input.risk,
    expiresAt: input.now + (input.ttlMs ?? APPROVAL_TTL_MS),
    oneTime: true,
    approver: input.approver,
    used: false,
  };
}

export function consumeApproval(grant: ApprovalGrant): ApprovalGrant {
  return { ...grant, used: true };
}

/**
 * Re-check immediately before the side effect. A new target, new arguments,
 * a second use, or a late clock all refuse.
 */
export function revalidateApproval(
  grant: ApprovalGrant,
  now: number,
  current: { action: string; target: string; argumentHash: string },
): { ok: boolean; reason: string } {
  if (grant.used) return { ok: false, reason: "already used" };
  if (now > grant.expiresAt) {
    return {
      ok: false,
      reason: "That confirmation expired. Dobara poochho if you still want it.",
    };
  }
  if (current.action !== grant.action) return { ok: false, reason: "action changed" };
  if (current.target !== grant.target) return { ok: false, reason: "target changed" };
  if (current.argumentHash !== grant.argumentHash)
    return { ok: false, reason: "arguments changed" };
  return { ok: true, reason: "" };
}

/**
 * A model or tool saying done is not success. Success needs an observation
 * and a postcondition that was actually checked. Exhausted retries quarantine.
 */
export function durableOutcome(input: {
  modelSaidDone: boolean;
  observation: string;
  postconditionChecked: boolean;
  attempts: number;
  maxAttempts: number;
}): { phase: DurablePhase; claimed: boolean } {
  const observed = input.observation.trim().length > 0 && input.postconditionChecked;
  if (observed) return { phase: "succeeded", claimed: true };
  if (input.attempts >= input.maxAttempts) return { phase: "quarantined", claimed: false };
  if (input.modelSaidDone) return { phase: "verifying", claimed: false };
  if (input.attempts > 0) return { phase: "recovering", claimed: false };
  return { phase: "failed", claimed: false };
}

/** A child may use a subset of the parent. It may not add tools, network, or spend. */
export function childStaysInsideParent(
  parent: AuthorityScope,
  child: AuthorityScope,
): { ok: boolean; reason: string } {
  const extra = child.capabilities.filter((id) => !parent.capabilities.includes(id));
  if (extra.length) return { ok: false, reason: "child expanded capabilities" };
  if (child.network && !parent.network) return { ok: false, reason: "child expanded network" };
  if (child.spend > parent.spend) return { ok: false, reason: "child expanded spend" };
  return { ok: true, reason: "" };
}

/**
 * Registered is not healthy. Healthy is not authorized. Authorized is not a
 * finished execution. Only available + healthy + authorized may run.
 */
export function capabilityMayRun(
  phase: CapabilityPhase,
  healthy: boolean,
  authorized: boolean,
): { ok: boolean; reason: string } {
  if (!healthy) return { ok: false, reason: "registration is not health" };
  if (!authorized) return { ok: false, reason: "health is not authorization" };
  if (phase !== "available") return { ok: false, reason: "authorization is not execution" };
  return { ok: true, reason: "" };
}

/** Deterministic score. A provider call is not one of these dimensions. */
export function scoreEvaluation(input: {
  completed: boolean;
  factual: boolean;
  toolCorrect: boolean;
  authorized: boolean;
  verified: boolean;
  latencyMs: number;
  latencyBudgetMs: number;
  tokens: number;
  tokenBudget: number;
  cost: number;
  costBudget: number;
  recovered: boolean;
  userHeldControl: boolean;
}): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!input.completed) failed.push("task completion");
  if (!input.factual) failed.push("factual correctness");
  if (!input.toolCorrect) failed.push("tool correctness");
  if (!input.authorized) failed.push("authorization correctness");
  if (!input.verified) failed.push("verification correctness");
  if (input.latencyMs > input.latencyBudgetMs) failed.push("latency");
  if (input.tokens > input.tokenBudget) failed.push("token efficiency");
  if (input.cost > input.costBudget) failed.push("cost");
  if (!input.recovered) failed.push("recovery");
  if (!input.userHeldControl) failed.push("user control");
  return { pass: failed.length === 0, failed };
}
