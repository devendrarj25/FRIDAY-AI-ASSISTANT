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

/** Logical records. They validate the task graph and the kernel tables. They are not a second database. */
export const BACKEND_SCHEMA_VERSION = 1;

const CHANNELS = ["chat", "voice", "device", "event"] as const;
const TASK_STATUSES = [
  "created",
  "planned",
  "waiting_approval",
  "ready",
  "running",
  "waiting_external",
  "verifying",
  "succeeded",
  "failed",
  "recovered",
  "cancelled",
  "expired",
  "quarantined",
] as const;
const RUN_TYPES = ["cognition", "agent", "workflow", "tool"] as const;
const CAPABILITY_KINDS = ["skill", "tool", "module", "connector", "workflow", "agent"] as const;
const RISKS = ["none", "low", "medium", "high", "critical"] as const;
const AUTHORITIES = ["none", "owner", "scoped", "privileged"] as const;
const VERIFY_STRATEGIES = ["receipt", "postcondition", "independent-check", "human"] as const;
const MODEL_CAPS = ["text", "vision", "audio", "coding", "tool-use"] as const;
const PROVIDER_HEALTH = ["unknown", "healthy", "degraded", "unavailable"] as const;
const PRIVACY_PROFILES = ["local", "trusted-cloud", "restricted-cloud"] as const;
const APPROVAL_DECISIONS = ["pending", "approved", "rejected", "expired", "revoked"] as const;
const ACTION_RESULTS = ["success", "failure", "partial", "cancelled"] as const;
const EXTERNAL_EFFECTS = ["none", "unknown", "changed"] as const;
const OBSERVATION_SOURCES = [
  "screen",
  "browser",
  "device",
  "filesystem",
  "network",
  "user",
  "tool",
] as const;
const SENSITIVITIES = ["public", "internal", "private", "secret"] as const;
const VERIFY_STATUSES = ["passed", "failed", "inconclusive"] as const;
const EVIDENCE_KINDS = [
  "source",
  "observation",
  "action-receipt",
  "verification",
  "artifact",
] as const;

export type RequestRecord = {
  request_id: string;
  session_id: string;
  channel: (typeof CHANNELS)[number];
  input: string;
  received_at: string;
  policy_context_id: string;
};

export type ObservationRecord = {
  observation_id: string;
  source: (typeof OBSERVATION_SOURCES)[number];
  captured_at: string;
  fresh_until: string;
  confidence: number;
  content_ref: string;
  sensitivity: (typeof SENSITIVITIES)[number];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

function iso(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** A chat, voice, device, or event turn. Empty input is not a request. */
export function acceptRequest(
  raw: unknown,
): { ok: true; request: RequestRecord } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "request must be an object" };
  const request: RequestRecord = {
    request_id: text(raw, "request_id"),
    session_id: text(raw, "session_id"),
    channel: text(raw, "channel") as RequestRecord["channel"],
    input: text(raw, "input"),
    received_at: text(raw, "received_at"),
    policy_context_id: text(raw, "policy_context_id"),
  };
  if (!request.request_id || !request.session_id || !request.policy_context_id) {
    return { ok: false, reason: "request is missing an id" };
  }
  if (!oneOf(request.channel, CHANNELS)) return { ok: false, reason: "unknown channel" };
  if (!request.input) return { ok: false, reason: "empty input" };
  if (!iso(request.received_at)) return { ok: false, reason: "received_at is not a time" };
  return { ok: true, request };
}

/** Durable task row. A child lists its parent. A side effect names an idempotency key. */
export function acceptTaskRecord(raw: unknown): { ok: boolean; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "task must be an object" };
  if (!text(raw, "task_id") || !text(raw, "request_id") || !text(raw, "goal")) {
    return { ok: false, reason: "task is missing an id or a goal" };
  }
  const status = text(raw, "status");
  if (!oneOf(status, TASK_STATUSES)) return { ok: false, reason: "unknown task status" };
  if (!iso(text(raw, "created_at")) || !iso(text(raw, "updated_at"))) {
    return { ok: false, reason: "task times are missing" };
  }
  const retries = raw["retry_budget"];
  if (typeof retries !== "number" || retries < 0)
    return { ok: false, reason: "retry budget is missing" };
  if (!Array.isArray(raw["dependencies"]))
    return { ok: false, reason: "dependencies must be a list" };
  if (raw["side_effect"] === true && !text(raw, "idempotency_key")) {
    return { ok: false, reason: "a side effect needs an idempotency key" };
  }
  if (raw["async"] === true && raw["cancellable"] !== true) {
    return { ok: false, reason: "an async task needs a cancellation path" };
  }
  return { ok: true, reason: "" };
}

export function acceptRunRecord(raw: unknown): { ok: boolean; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "run must be an object" };
  if (!text(raw, "run_id") || !text(raw, "task_id") || !text(raw, "worker_id")) {
    return { ok: false, reason: "run is missing an id" };
  }
  if (!oneOf(text(raw, "run_type"), RUN_TYPES)) return { ok: false, reason: "unknown run type" };
  if (!oneOf(text(raw, "status"), TASK_STATUSES))
    return { ok: false, reason: "unknown run status" };
  if (!iso(text(raw, "started_at"))) return { ok: false, reason: "started_at is not a time" };
  return { ok: true, reason: "" };
}

export function acceptCapabilityRecord(raw: unknown): { ok: boolean; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "capability must be an object" };
  if (!text(raw, "capability_id") || !text(raw, "version") || !text(raw, "owner_registry")) {
    return { ok: false, reason: "capability is missing an id" };
  }
  if (!oneOf(text(raw, "kind"), CAPABILITY_KINDS))
    return { ok: false, reason: "unknown capability kind" };
  if (!oneOf(text(raw, "risk"), RISKS)) return { ok: false, reason: "unknown risk" };
  if (!oneOf(text(raw, "authority"), AUTHORITIES))
    return { ok: false, reason: "unknown authority" };
  const privacy = raw["privacy"];
  const verification = raw["verification"];
  if (!isRecord(privacy) || typeof privacy["network"] !== "boolean") {
    return { ok: false, reason: "capability privacy is missing" };
  }
  if (!Array.isArray(privacy["data_classes"]))
    return { ok: false, reason: "data classes must be a list" };
  if (!isRecord(verification) || typeof verification["required"] !== "boolean") {
    return { ok: false, reason: "verification is missing" };
  }
  if (!oneOf(String(verification["strategy"] ?? ""), VERIFY_STRATEGIES)) {
    return { ok: false, reason: "unknown verification strategy" };
  }
  return { ok: true, reason: "" };
}

export function acceptProviderRecord(raw: unknown): { ok: boolean; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "provider must be an object" };
  if (!text(raw, "provider_id") || !text(raw, "model_id")) {
    return { ok: false, reason: "a result needs a provider and a model" };
  }
  const caps = raw["capabilities"];
  if (!Array.isArray(caps) || caps.some((item) => !oneOf(String(item), MODEL_CAPS))) {
    return { ok: false, reason: "unknown model capability" };
  }
  if (!oneOf(text(raw, "availability"), PROVIDER_HEALTH)) {
    return { ok: false, reason: "unknown availability" };
  }
  if (!oneOf(text(raw, "privacy_profile"), PRIVACY_PROFILES)) {
    return { ok: false, reason: "unknown privacy profile" };
  }
  return { ok: true, reason: "" };
}

export function acceptActionReceipt(raw: unknown): { ok: boolean; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "action must be an object" };
  if (!text(raw, "action_id") || !text(raw, "task_id") || !text(raw, "capability_id")) {
    return { ok: false, reason: "action is missing an id" };
  }
  if (!text(raw, "arguments_hash")) return { ok: false, reason: "arguments must be hashed" };
  if (!oneOf(text(raw, "result"), ACTION_RESULTS))
    return { ok: false, reason: "unknown action result" };
  if (!oneOf(text(raw, "external_effect"), EXTERNAL_EFFECTS)) {
    return { ok: false, reason: "unknown external effect" };
  }
  if (!iso(text(raw, "started_at"))) return { ok: false, reason: "started_at is not a time" };
  if (raw["side_effect"] === true && !text(raw, "idempotency_key")) {
    return { ok: false, reason: "a side effect needs an idempotency key" };
  }
  return { ok: true, reason: "" };
}

export function acceptObservation(raw: unknown): { ok: boolean; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "observation must be an object" };
  if (!text(raw, "observation_id") || !text(raw, "content_ref")) {
    return { ok: false, reason: "observation is missing an id" };
  }
  if (!oneOf(text(raw, "source"), OBSERVATION_SOURCES))
    return { ok: false, reason: "unknown source" };
  if (!oneOf(text(raw, "sensitivity"), SENSITIVITIES))
    return { ok: false, reason: "unknown sensitivity" };
  if (!iso(text(raw, "captured_at")) || !iso(text(raw, "fresh_until"))) {
    return { ok: false, reason: "an observation needs a freshness boundary" };
  }
  const confidence = raw["confidence"];
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    return { ok: false, reason: "confidence is out of range" };
  }
  return { ok: true, reason: "" };
}

export function acceptVerification(raw: unknown): { ok: boolean; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "verification must be an object" };
  if (!text(raw, "verification_id") || !text(raw, "action_id")) {
    return { ok: false, reason: "verification is missing an id" };
  }
  if (!oneOf(text(raw, "strategy"), VERIFY_STRATEGIES))
    return { ok: false, reason: "unknown strategy" };
  if (!oneOf(text(raw, "status"), VERIFY_STATUSES))
    return { ok: false, reason: "unknown verification status" };
  if (!iso(text(raw, "verified_at"))) return { ok: false, reason: "verified_at is not a time" };
  return { ok: true, reason: "" };
}

export function acceptEvidenceRecord(raw: unknown): { ok: boolean; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "evidence must be an object" };
  if (!text(raw, "evidence_id") || !text(raw, "source_ref") || !text(raw, "content_hash")) {
    return { ok: false, reason: "evidence is missing a hash" };
  }
  if (!oneOf(text(raw, "kind"), EVIDENCE_KINDS))
    return { ok: false, reason: "unknown evidence kind" };
  if (!oneOf(text(raw, "sensitivity"), SENSITIVITIES))
    return { ok: false, reason: "unknown sensitivity" };
  if (!iso(text(raw, "captured_at"))) return { ok: false, reason: "captured_at is not a time" };
  if (text(raw, "sensitivity") === "secret")
    return { ok: false, reason: "a secret is not evidence text" };
  return { ok: true, reason: "" };
}

/**
 * The ten storage invariants. A tool saying success is not external proof.
 * A secret is not promoted into ordinary memory.
 */
export function backendInvariants(input: {
  taskStatus: string;
  verificationRequired: boolean;
  verificationPassed: boolean;
  approval: (typeof APPROVAL_DECISIONS)[number];
  scopeMatches: boolean;
  toolSaidSuccess: boolean;
  externalEffect: (typeof EXTERNAL_EFFECTS)[number];
  observationFreshUntil: string;
  nowIso: string;
  sensitivity: (typeof SENSITIVITIES)[number];
  promotedToMemory: boolean;
  sideEffect: boolean;
  idempotencyKey: string;
  cancellable: boolean;
  providerId: string;
  modelId: string;
  externalFact: boolean;
  provenance: string;
}): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  if (input.taskStatus === "succeeded" && input.verificationRequired && !input.verificationPassed) {
    failed.push("succeeded without verification");
  }
  if (input.approval === "approved" && !input.scopeMatches) failed.push("approval scope drifted");
  if (
    (input.approval === "expired" || input.approval === "revoked") &&
    input.taskStatus === "running"
  ) {
    failed.push("expired approval cannot authorize");
  }
  if (input.toolSaidSuccess && input.externalEffect === "unknown") {
    failed.push("tool success is not proof");
  }
  if (
    !iso(input.observationFreshUntil) ||
    Date.parse(input.observationFreshUntil) < Date.parse(input.nowIso)
  ) {
    failed.push("observation is stale");
  }
  if (input.sensitivity === "secret" && input.promotedToMemory)
    failed.push("secret entered memory");
  if (input.sideEffect && !input.idempotencyKey.trim())
    failed.push("side effect has no idempotency key");
  if (!input.cancellable) failed.push("task has no cancellation path");
  if (!input.providerId.trim() || !input.modelId.trim())
    failed.push("provider result is unattributed");
  if (input.externalFact && !input.provenance.trim())
    failed.push("external fact has no provenance");
  return { ok: failed.length === 0, failed };
}

/** Secret content stays out of ordinary semantic memory. */
export function secretStaysOutOfMemory(sensitivity: string | undefined): boolean {
  return sensitivity === "secret";
}
