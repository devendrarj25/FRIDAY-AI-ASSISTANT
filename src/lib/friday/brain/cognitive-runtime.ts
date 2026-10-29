/**
 * FRIDAY · cognitive runtime
 *
 * The working brain loop: a state machine, a goal stack, inhibition gates,
 * a functional self-model, ranked forgetting, and a resume rule that will
 * not repeat a side effect. The model is an engine. FRIDAY stays FRIDAY.
 * Continuity — know the open goal, verify, stay quiet unless the owner is
 * waiting — is the behaviour. This module does not execute tools and does
 * not claim consciousness.
 */

import { writeState } from "../persist";
import type { ReasoningMode } from "./reasoning";

export const COGNITIVE_STATES = [
  "DORMANT",
  "RECEIVING",
  "PERCEIVING",
  "UNDERSTANDING",
  "ATTENDING",
  "CONTEXT_BUILDING",
  "RETRIEVING",
  "DELIBERATING",
  "DECIDING",
  "AUTHORITY_WAIT",
  "EXECUTING",
  "OBSERVING",
  "VERIFYING",
  "REFLECTING",
  "LEARNING",
  "PERSISTING",
  "WAITING_EXTERNAL",
  "DEGRADED",
  "BLOCKED",
  "COMPLETE",
  "ABORTED",
] as const;

export type CognitiveState = (typeof COGNITIVE_STATES)[number];

const NEXT: Record<CognitiveState, readonly CognitiveState[]> = {
  DORMANT: ["RECEIVING", "DEGRADED", "ABORTED"],
  RECEIVING: ["PERCEIVING", "DEGRADED", "ABORTED"],
  PERCEIVING: ["UNDERSTANDING", "DEGRADED", "ABORTED"],
  UNDERSTANDING: ["ATTENDING", "DEGRADED", "ABORTED"],
  ATTENDING: ["CONTEXT_BUILDING", "DEGRADED", "ABORTED"],
  CONTEXT_BUILDING: ["RETRIEVING", "DECIDING", "DEGRADED", "ABORTED"],
  RETRIEVING: ["DELIBERATING", "DEGRADED", "ABORTED"],
  DELIBERATING: ["DECIDING", "DEGRADED", "ABORTED"],
  DECIDING: [
    "AUTHORITY_WAIT",
    "EXECUTING",
    "OBSERVING",
    "VERIFYING",
    "WAITING_EXTERNAL",
    "COMPLETE",
    "BLOCKED",
    "DEGRADED",
    "ABORTED",
  ],
  AUTHORITY_WAIT: ["OBSERVING", "WAITING_EXTERNAL", "ABORTED"],
  EXECUTING: ["OBSERVING", "DEGRADED", "ABORTED"],
  OBSERVING: ["VERIFYING", "DEGRADED", "ABORTED"],
  VERIFYING: ["REFLECTING", "LEARNING", "COMPLETE", "BLOCKED", "DEGRADED", "ABORTED"],
  REFLECTING: ["LEARNING", "COMPLETE", "ABORTED"],
  LEARNING: ["PERSISTING", "COMPLETE", "ABORTED"],
  PERSISTING: ["COMPLETE", "WAITING_EXTERNAL", "ABORTED"],
  WAITING_EXTERNAL: ["RECEIVING", "ABORTED"],
  DEGRADED: ["RECEIVING", "COMPLETE", "ABORTED"],
  BLOCKED: ["RECEIVING", "DECIDING", "ABORTED"],
  COMPLETE: ["DORMANT", "RECEIVING"],
  ABORTED: ["DORMANT", "RECEIVING"],
};

export type Transition = {
  from: CognitiveState;
  to: CognitiveState;
  reason: string;
  at: string;
  turnId: string;
  version: number;
  accepted: boolean;
};

export type GoalHorizon = "step" | "task" | "project" | "strategic" | "mission";

export type CognitiveGoal = {
  goal_id: string;
  desired_outcome: string;
  success_predicate: string;
  priority: number;
  urgency: number;
  horizon: GoalHorizon;
  constraints: string[];
  dependencies: string[];
  deadline: string | null;
  progress: number;
  confidence: number;
  abandonment: string;
  verification: string;
  status: "active" | "paused" | "done" | "abandoned";
  needsReplan: boolean;
};

export type GateId = "evidence" | "novelty" | "risk" | "authority" | "resource" | "completion";

export type GateReport = {
  open: GateId[];
  closed: { id: GateId; reason: string }[];
};

export type SelfModel = {
  identity: "FRIDAY";
  consciousnessClaim: false;
  mode: string;
  capabilities: string[];
  limitations: string[];
  modelAvailable: boolean | null;
  toolHealth: "ok" | "degraded" | "unknown";
  activeGoals: string[];
  recentFailures: string[];
  cognitiveState: CognitiveState;
};

export type DurableMark = {
  turnId: string;
  state: CognitiveState;
  sideEffectCommitted: boolean;
  at: string;
  version: number;
};

export type CognitiveRuntimeRecord = {
  turnId: string;
  state: CognitiveState;
  outcome: "answered" | "handoff" | "waiting" | "reflected" | "degraded";
  trace: Transition[];
  gates: GateReport;
  self: SelfModel;
  anticipate: string | null;
  mayExecute: false;
  interrupt: false;
  speak: boolean;
  resume: { state: CognitiveState; mayExecute: boolean; reason: string };
  experienceAdopted: false;
};

const STORAGE_KEY = "friday.cognitive-runtime.v1";
const HALF_LIFE_MS = 14 * 86_400_000;

let version = 0;
let seq = 0;
const goals = new Map<string, CognitiveGoal>();
const marks = new Map<string, DurableMark>();
const committedActions = new Set<string>();
const strategyFailures = new Map<string, number>();

const nextId = (prefix: string) => `${prefix}-${(seq += 1).toString(36)}`;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export function resetCognitiveRuntime(): void {
  version = 0;
  seq = 0;
  goals.clear();
  marks.clear();
  committedActions.clear();
  strategyFailures.clear();
}

export function canTransition(from: CognitiveState, to: CognitiveState): boolean {
  return NEXT[from].includes(to);
}

export function applyTransition(input: {
  from: CognitiveState;
  to: CognitiveState;
  reason: string;
  turnId: string;
  at: number;
}): Transition {
  const accepted = canTransition(input.from, input.to);
  version += 1;
  return {
    from: input.from,
    to: accepted ? input.to : "BLOCKED",
    reason: accepted ? input.reason : `rejected ${input.from} → ${input.to}: ${input.reason}`,
    at: iso(input.at),
    turnId: input.turnId,
    version,
    accepted,
  };
}

export function walkStates(input: {
  turnId: string;
  states: CognitiveState[];
  reason: string;
  at: number;
}): { state: CognitiveState; trace: Transition[] } {
  const trace: Transition[] = [];
  let state: CognitiveState = "DORMANT";
  for (const next of input.states) {
    const step = applyTransition({
      from: state,
      to: next,
      reason: input.reason,
      turnId: input.turnId,
      at: input.at,
    });
    trace.push(step);
    if (!step.accepted) return { state: "BLOCKED", trace };
    state = next;
  }
  return { state, trace };
}

export function rememberGoal(input: {
  outcome: string;
  success: string;
  priority?: number;
  urgency?: number;
  horizon?: GoalHorizon;
  constraints?: string[];
  dependencies?: string[];
  deadline?: string | null;
  confidence?: number;
}): CognitiveGoal {
  const desired = input.outcome.trim().slice(0, 240);
  const existing = [...goals.values()].find(
    (goal) => goal.desired_outcome === desired && goal.status === "active",
  );
  if (existing) return existing;
  const goal: CognitiveGoal = {
    goal_id: nextId("goal"),
    desired_outcome: desired,
    success_predicate: input.success.trim().slice(0, 240) || "owner accepts the result",
    priority: clamp(input.priority ?? 0.5),
    urgency: clamp(input.urgency ?? 0.4),
    horizon: input.horizon ?? "task",
    constraints: input.constraints ?? [],
    dependencies: input.dependencies ?? [],
    deadline: input.deadline ?? null,
    progress: 0,
    confidence: clamp(input.confidence ?? 0.6),
    abandonment: "abandon only when the owner drops it or the predicate is impossible",
    verification: "a check against the success predicate, not a model assertion",
    status: "active",
    needsReplan: false,
  };
  goals.set(goal.goal_id, goal);
  while (goals.size > 8) {
    const oldest = goals.keys().next().value;
    if (!oldest) break;
    goals.delete(oldest);
  }
  return goal;
}

export function rankGoals(list: CognitiveGoal[] = [...goals.values()]): CognitiveGoal[] {
  const done = new Set(list.filter((goal) => goal.status === "done").map((goal) => goal.goal_id));
  return [...list].sort((a, b) => scoreGoal(b, done) - scoreGoal(a, done));
}

function scoreGoal(goal: CognitiveGoal, done: Set<string>): number {
  if (goal.status === "abandoned" || goal.status === "done") return -1;
  const blocked = goal.dependencies.some((id) => !done.has(id));
  const base = goal.priority * 0.5 + goal.urgency * 0.3 + goal.confidence * 0.2;
  return blocked ? base * 0.25 : base;
}

export function replanGoal(goalId: string, reason: string): CognitiveGoal | null {
  const goal = goals.get(goalId);
  if (!goal) return null;
  goal.needsReplan = true;
  goal.status = "active";
  goal.abandonment = reason.slice(0, 180);
  return goal;
}

export function noteStrategyFailure(strategy: string): number {
  const count = (strategyFailures.get(strategy) ?? 0) + 1;
  strategyFailures.set(strategy, count);
  return count;
}

export function noteCommittedAction(signature: string): void {
  const key = signature.trim();
  if (key) committedActions.add(key);
}

export function evaluateGates(input: {
  claimingFact: boolean;
  confidence: number;
  hasEvidence: boolean;
  strategy: string;
  consequential: boolean;
  degraded: boolean;
  successMet: boolean;
  openDebt: boolean;
}): GateReport {
  const closed: GateReport["closed"] = [];
  const consider = (id: GateId, pass: boolean, reason: string) => {
    if (!pass) closed.push({ id, reason });
  };
  consider(
    "evidence",
    !(input.claimingFact && input.confidence < 0.45 && !input.hasEvidence),
    "low confidence and no evidence — do not state this as fact",
  );
  consider(
    "novelty",
    (strategyFailures.get(input.strategy) ?? 0) < 2 && !committedActions.has(input.strategy),
    "this strategy already failed or already ran — do not repeat it",
  );
  consider("risk", !input.consequential, "machine-changing work waits for authority");
  consider("authority", !input.consequential, "cognition does not grant itself permission");
  consider("resource", !input.degraded, "a dependency is degraded");
  consider(
    "completion",
    input.successMet && !input.openDebt,
    "success is not shown yet, or a verification debt is still open",
  );
  const open = (
    ["evidence", "novelty", "risk", "authority", "resource", "completion"] as GateId[]
  ).filter((id) => !closed.some((row) => row.id === id));
  return { open, closed };
}

/** Ranking decay. The record stays. Only its retrieval rank falls. */
export function decayRelevance(input: {
  ageMs: number;
  uses: number;
  confidence: number;
  superseded: boolean;
  userPinned: boolean;
  sensitive: boolean;
}): { rank: number; retained: true } {
  if (input.sensitive || input.userPinned) {
    return { rank: Math.max(0.5, clamp(input.confidence)), retained: true };
  }
  const halfLives = Math.max(0, input.ageMs) / HALF_LIFE_MS;
  const freshness = 0.5 ** halfLives;
  const useBoost = Math.min(0.3, Math.max(0, input.uses) * 0.04);
  let rank = clamp(input.confidence) * freshness + useBoost;
  if (input.superseded) rank *= 0.15;
  return { rank: clamp(rank), retained: true };
}

export function buildSelfModel(input: {
  mode: string;
  state: CognitiveState;
  capabilities?: string[];
  limitations?: string[];
  modelAvailable: boolean | null;
  toolHealth?: SelfModel["toolHealth"];
  failures?: string[];
}): SelfModel {
  return {
    identity: "FRIDAY",
    consciousnessClaim: false,
    mode: input.mode || "manual",
    capabilities: input.capabilities ?? [],
    limitations: ["self-model is a functional record", ...(input.limitations ?? [])].slice(0, 8),
    modelAvailable: input.modelAvailable,
    toolHealth: input.toolHealth ?? "unknown",
    activeGoals: rankGoals()
      .filter((goal) => goal.status === "active")
      .map((goal) => goal.goal_id)
      .slice(0, 4),
    recentFailures: (input.failures ?? []).slice(0, 4),
    cognitiveState: input.state,
  };
}

export function anticipateNext(list: CognitiveGoal[] = [...goals.values()]): string | null {
  const next = rankGoals(list).find((goal) => goal.status === "active");
  if (!next) return null;
  return `Next open goal: ${next.desired_outcome}`.slice(0, 180);
}

export function resumeMark(mark: DurableMark): {
  state: CognitiveState;
  mayExecute: boolean;
  reason: string;
} {
  if (mark.sideEffectCommitted) {
    return {
      state: "OBSERVING",
      mayExecute: false,
      reason: "side effect already committed — do not run it again",
    };
  }
  return {
    state: mark.state,
    mayExecute: false,
    reason: `resume ${mark.state} without a new side effect`,
  };
}

function persistMark(mark: DurableMark): void {
  marks.set(mark.turnId, mark);
  try {
    writeState(STORAGE_KEY, {
      version,
      marks: [...marks.values()].slice(-12),
      goals: [...goals.values()],
    });
  } catch {
    /* desktop persistence is best-effort; the in-memory mark still stands */
  }
}

export function lastMark(turnId: string): DurableMark | null {
  return marks.get(turnId) ?? null;
}

/**
 * One cognitive pass. `mayExecute` is always false: the existing fabric
 * runs tools, and authority owns machine-changing work.
 */
export function runCognitiveRuntime(input: {
  prompt: string;
  goal?: string;
  mode: ReasoningMode;
  surface?: string;
  depth: "fast" | "deliberative" | "metacognitive";
  confidence: number;
  consequential?: boolean;
  contradicted?: boolean;
  liveFact?: boolean;
  hasEvidence?: boolean;
  toolFailed?: boolean;
  degraded?: boolean;
  ambiguous?: boolean;
  ownerWaiting?: boolean;
  modelAvailable?: boolean | null;
  now?: number;
}): CognitiveRuntimeRecord {
  const now = input.now ?? Date.now();
  const turnId = nextId("turn");
  const consequential = Boolean(input.consequential);
  const toolFailed = Boolean(input.toolFailed);
  const missingLive = Boolean(input.liveFact) && !input.hasEvidence;
  const fast = input.depth === "fast" && !consequential && !toolFailed && !input.contradicted;

  if (input.goal && input.goal.trim().length > 12 && !fast) {
    const goal = rememberGoal({
      outcome: input.goal,
      success: "the reply matches the ask and names any failure",
      priority: consequential ? 0.9 : 0.6,
      urgency: input.ambiguous ? 0.3 : 0.55,
      horizon: consequential ? "project" : "task",
      confidence: input.confidence,
      constraints: consequential ? ["authority handoff before any side effect"] : [],
    });
    if (input.contradicted || toolFailed)
      replanGoal(goal.goal_id, "evidence changed — replan before claiming success");
  }
  if (toolFailed) noteStrategyFailure(input.mode);

  const gates = evaluateGates({
    claimingFact: Boolean(input.liveFact || input.contradicted),
    confidence: input.confidence,
    hasEvidence: Boolean(input.hasEvidence),
    strategy: input.mode,
    consequential,
    degraded: Boolean(input.degraded),
    successMet: !toolFailed && !missingLive && !input.contradicted,
    openDebt: toolFailed || missingLive || Boolean(input.contradicted),
  });

  const path: CognitiveState[] = [
    "RECEIVING",
    "PERCEIVING",
    "UNDERSTANDING",
    "ATTENDING",
    "CONTEXT_BUILDING",
  ];
  if (!fast) path.push("RETRIEVING", "DELIBERATING");
  path.push("DECIDING");
  let outcome: CognitiveRuntimeRecord["outcome"] = "answered";
  if (input.degraded) {
    path.push("DEGRADED", "COMPLETE");
    outcome = "degraded";
  } else if (consequential) {
    path.push("AUTHORITY_WAIT");
    outcome = "handoff";
  } else if (missingLive) {
    path.push("WAITING_EXTERNAL");
    outcome = "waiting";
  } else if (toolFailed || input.contradicted) {
    path.push("VERIFYING", "REFLECTING", "LEARNING", "PERSISTING", "COMPLETE");
    outcome = "reflected";
  } else {
    path.push("COMPLETE");
  }

  const walked = walkStates({
    turnId,
    states: path,
    reason: fast ? "light pass" : consequential ? "authority handoff" : "deliberative pass",
    at: now,
  });

  const mark: DurableMark = {
    turnId,
    state: walked.state,
    sideEffectCommitted: false,
    at: iso(now),
    version,
  };
  persistMark(mark);

  const self = buildSelfModel({
    mode: input.surface || "manual",
    state: walked.state,
    modelAvailable: input.modelAvailable ?? null,
    toolHealth: input.degraded ? "degraded" : toolFailed ? "degraded" : "unknown",
    failures: toolFailed ? [input.mode] : [],
    limitations: consequential ? ["will not execute a machine-changing action"] : [],
  });

  return {
    turnId,
    state: walked.state,
    outcome,
    trace: walked.trace,
    gates,
    self,
    anticipate: fast ? null : anticipateNext(),
    mayExecute: false,
    interrupt: false,
    speak: input.ownerWaiting !== false,
    resume: resumeMark(mark),
    experienceAdopted: false,
  };
}
