/**
 * FRIDAY · cognitive mind
 *
 * The rest of the brain contracts, in one place: attention competition,
 * uncertainty that changes what FRIDAY will assert, a decision record, affect
 * and social posture, commitments, replanning, an experience candidate, and
 * a model request. Continuity is the behaviour — know the open goal, verify,
 * stay quiet unless the owner is waiting. The model is an engine. Identity
 * stays FRIDAY. Nothing here executes a tool, grants a permission, or claims
 * consciousness.
 */

export type UncertaintyKind = "epistemic" | "aleatoric" | "stale" | "ambiguous" | "unavailable";

export type UncertaintyBehavior = "proceed" | "retrieve" | "clarify" | "observe" | "withhold";

export type UncertaintyJudgement = {
  kind: UncertaintyKind;
  behavior: UncertaintyBehavior;
  confidence: number;
  evidenceCount: number;
  assertFact: boolean;
};

export type AttentionCandidate = {
  id: string;
  label: string;
  goalRelevance: number;
  urgency: number;
  novelty: number;
  risk: number;
  dependency: number;
  userSalience: number;
  freshness: number;
  uncertainty: number;
  infoValue: number;
  noise: number;
  cost: number;
};

export type AttentionPick = {
  id: string;
  label: string;
  score: number;
};

export type AttentionBoard = {
  foreground: AttentionPick | null;
  watchlist: AttentionPick[];
  suppressed: AttentionPick[];
};

export type SilenceJudgement = {
  score: number;
  deservesNotice: boolean;
  delivered: false;
  stored: boolean;
  reason: string;
};

export type DecisionOption = {
  id: string;
  summary: string;
  expected: string;
  risk: "low" | "high";
  reversible: boolean;
  score: number;
};

export type DecisionRecord = {
  decision_id: string;
  objective: string;
  constraints: string[];
  options: DecisionOption[];
  evidenceRefs: string[];
  chosen: DecisionOption;
  rejected: { id: string; rationale: string }[];
  confidence: number;
  authority: "none" | "handoff";
  verificationRequired: boolean;
  invalidatesWhen: string;
  publicSummary: string;
  exposesChainOfThought: false;
};

export type AffectSignal = {
  brevity: "short" | "normal" | "thorough";
  reassurance: boolean;
  pacing: "immediate" | "steady" | "careful";
  clarification: "none" | "one-question";
  interruptThreshold: number;
  prosody: "neutral" | "warm" | "firm";
  changesPermissions: false;
  changesTruth: false;
  changesPolicy: false;
};

export type SocialStance = {
  preferredStyle: "concise" | "thorough" | "match-the-ask";
  posture: "collaborative" | "repair";
  trust: number;
  boundaries: string[];
  unresolved: string[];
  inferredSensitiveAttributes: [];
  manipulatesDependency: false;
};

export type Commitment = {
  commitment_id: string;
  owner: "owner" | "policy";
  scope: string;
  due: string | null;
  completion: string;
  notify: "when-due";
  cancel: string;
  status: "open";
  createdFrom: "explicit-ask" | "authorized-policy";
};

export type CommitmentProposal = {
  commitment: Commitment | null;
  suggestion: string | null;
  reason: string;
};

export type ReplanTrigger =
  | "progress-diverged"
  | "precondition-changed"
  | "observation-invalidated"
  | "tool-failure"
  | "capability-unavailable"
  | "resource-pressure"
  | "deadline-risk"
  | "better-option"
  | "owner-changed-objective";

export type PlanRevision = {
  needsReplan: boolean;
  triggers: ReplanTrigger[];
  completedEffects: string[];
  nextStep: string;
  historyKept: true;
};

export type ExperienceRecord = {
  experience_id: string;
  situation: string;
  outcome: "success" | "failure" | "partial";
  hypothesis: string;
  lesson: string;
  boundary: string;
  confidence: number;
  indexKey: string;
  applied: false;
  evaluationGated: true;
  stored: boolean;
};

export type NormalizedObservation = {
  observation_id: string;
  source: string;
  observed_at: string;
  confidence: number;
  payload: string;
  normalized: true;
};

export type ModelCognitionRequest = {
  task: string;
  contextIds: string[];
  mode: string;
  capabilities: string[];
  budget: { latency: "fast" | "normal" | "deep"; quality: "draft" | "careful" };
  outputContract: "answer" | "claims";
  verification: "none" | "light" | "strict";
  identity: "FRIDAY";
  providerStateDurable: false;
  consciousnessClaim: false;
};

export type BrainWorkingState = {
  identity: "FRIDAY";
  focus: string;
  objective: string;
  constraints: string[];
  uncertainty: UncertaintyKind;
  commitmentIds: string[];
  openQuestions: string[];
  verificationRequired: boolean;
  affectivePosture: AffectSignal["pacing"];
  consciousnessClaim: false;
};

export type CognitiveMind = {
  attention: AttentionBoard;
  silence: SilenceJudgement;
  uncertainty: UncertaintyJudgement;
  decision: DecisionRecord;
  affect: AffectSignal;
  social: SocialStance;
  commitment: CommitmentProposal;
  revision: PlanRevision;
  experience: ExperienceRecord | null;
  observation: NormalizedObservation;
  modelRequest: ModelCognitionRequest;
  working: BrainWorkingState;
  /** Empty on a fast pass so a light chat note stays light. */
  line: string;
};

const WATCH_FLOOR = 0.28;
const SILENCE_FLOOR = 0.55;
const REPLAN_TRIGGERS: ReplanTrigger[] = [
  "progress-diverged",
  "precondition-changed",
  "observation-invalidated",
  "tool-failure",
  "capability-unavailable",
  "resource-pressure",
  "deadline-risk",
  "better-option",
  "owner-changed-objective",
];

let seq = 0;
const commitments = new Map<string, Commitment>();
const experiences = new Map<string, ExperienceRecord>();

const nextId = (prefix: string) => `${prefix}-${(seq += 1).toString(36)}`;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clip(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function resetCognitiveMind(): void {
  seq = 0;
  commitments.clear();
  experiences.clear();
}

export function attentionScore(item: AttentionCandidate): number {
  const raw =
    clamp(item.goalRelevance) +
    clamp(item.urgency) +
    clamp(item.novelty) +
    clamp(item.risk) +
    clamp(item.dependency) +
    clamp(item.userSalience) +
    clamp(item.freshness) +
    clamp(item.uncertainty) +
    clamp(item.infoValue) -
    clamp(item.noise) -
    clamp(item.cost);
  return clamp(raw / 9);
}

/** One foreground. The rest are watched or suppressed. Items are not deleted. */
export function competeForAttention(items: AttentionCandidate[]): AttentionBoard {
  const ranked = items
    .map((item) => ({
      id: item.id,
      label: clip(item.label, 160),
      score: attentionScore(item),
    }))
    .sort((a, b) => b.score - a.score);
  const foreground = ranked[0] ?? null;
  const rest = foreground ? ranked.filter((row) => row.id !== foreground.id) : [];
  return {
    foreground,
    watchlist: rest.filter((row) => row.score >= WATCH_FLOOR),
    suppressed: rest.filter((row) => row.score < WATCH_FLOOR),
  };
}

/** Idle turns lower rank. The record stays. */
export function decayAttention(
  score: number,
  idleTurns: number,
): { score: number; retained: true } {
  const turns = Math.max(0, Math.floor(idleTurns));
  return { score: clamp(score) * 0.85 ** turns, retained: true };
}

/**
 * A high score is stored as a notice. Cognition does not deliver it.
 * The owner already waiting means answer them, and do not add a second poke.
 */
export function judgeSilence(input: {
  importance: number;
  urgency: number;
  actionability: number;
  relevance: number;
  deadlinePressure: number;
  interruptionCost: number;
  ownerWaiting: boolean;
}): SilenceJudgement {
  const score = clamp(
    clamp(input.importance) *
      clamp(input.urgency) *
      clamp(input.actionability) *
      clamp(input.relevance) *
      clamp(input.deadlinePressure) -
      clamp(input.interruptionCost),
  );
  if (input.ownerWaiting) {
    return {
      score,
      deservesNotice: false,
      delivered: false,
      stored: false,
      reason: "the owner is waiting — answer, and do not add another interruption",
    };
  }
  const deservesNotice = score >= SILENCE_FLOOR;
  return {
    score,
    deservesNotice,
    delivered: false,
    stored: deservesNotice || score >= 0.15,
    reason: deservesNotice
      ? "worth a later notice — cognition stores it and does not speak"
      : "below the silence line — watch it, do not interrupt",
  };
}

export function judgeUncertainty(input: {
  confidence: number;
  evidenceCount: number;
  evidenceQuality: number;
  freshness: number;
  contradictionCount: number;
  modelAgreement: number | null;
  ambiguous: boolean;
  liveFact: boolean;
  hasEvidence: boolean;
  irreducible?: boolean;
}): UncertaintyJudgement {
  const confidence = clamp(input.confidence);
  const evidenceCount = Math.max(0, Math.floor(input.evidenceCount));
  const base = {
    confidence,
    evidenceCount,
  };
  if (input.contradictionCount > 0) {
    return { ...base, kind: "epistemic", behavior: "withhold", assertFact: false };
  }
  if (input.liveFact && !input.hasEvidence) {
    return { ...base, kind: "unavailable", behavior: "withhold", assertFact: false };
  }
  if (input.ambiguous) {
    return { ...base, kind: "ambiguous", behavior: "clarify", assertFact: false };
  }
  if (clamp(input.freshness) < 0.35) {
    return { ...base, kind: "stale", behavior: "observe", assertFact: false };
  }
  if (input.irreducible && evidenceCount > 0) {
    return { ...base, kind: "aleatoric", behavior: "observe", assertFact: false };
  }
  const disagree = input.modelAgreement !== null && input.modelAgreement < 0.4;
  if (
    disagree ||
    (evidenceCount === 0 && confidence < 0.55) ||
    clamp(input.evidenceQuality) < 0.4
  ) {
    return { ...base, kind: "epistemic", behavior: "retrieve", assertFact: false };
  }
  return {
    ...base,
    kind: "epistemic",
    behavior: "proceed",
    assertFact: confidence >= 0.55,
  };
}

export function writeDecisionRecord(input: {
  objective: string;
  constraints?: string[];
  options: DecisionOption[];
  evidenceRefs?: string[];
  confidence: number;
  authority: "none" | "handoff";
  verificationRequired: boolean;
  invalidatesWhen: string;
}): DecisionRecord {
  const options = input.options.length
    ? input.options
    : [
        {
          id: "answer",
          summary: "answer from the kept context",
          expected: "a direct reply",
          risk: "low" as const,
          reversible: true,
          score: 0.5,
        },
      ];
  const eligible = options.filter((option) => option.reversible && option.id !== "execute");
  const pool = eligible.length ? eligible : options.filter((option) => option.id !== "execute");
  const chosen = [...pool].sort((a, b) => b.score - a.score)[0] ?? options[0]!;
  const rejected = options
    .filter((option) => option.id !== chosen.id)
    .map((option) => ({
      id: option.id,
      rationale:
        option.id === "execute" || !option.reversible
          ? "cognition does not run a side effect"
          : option.risk === "high" && input.authority !== "handoff"
            ? "needs authority before it can be chosen"
            : "a higher-scoring option was kept",
    }));
  const objective = clip(input.objective, 180) || "answer the owner";
  return {
    decision_id: nextId("decision"),
    objective,
    constraints: (input.constraints ?? []).map((row) => clip(row, 120)).slice(0, 6),
    options,
    evidenceRefs: (input.evidenceRefs ?? []).slice(0, 8),
    chosen,
    rejected,
    confidence: clamp(input.confidence),
    authority: input.authority,
    verificationRequired: input.verificationRequired,
    invalidatesWhen: clip(input.invalidatesWhen, 160) || "new evidence arrives",
    publicSummary: clip(
      `${chosen.summary}. ${input.authority === "handoff" ? "Authority still has to agree." : "No side effect."}`,
      180,
    ),
    exposesChainOfThought: false,
  };
}

export function regulateAffect(input: {
  urgency: number;
  frustration: number;
  confusion: number;
  excitement: number;
  consequential: boolean;
  ambiguous: boolean;
}): AffectSignal {
  const urgency = clamp(input.urgency);
  const frustration = clamp(input.frustration);
  const confusion = clamp(input.confusion);
  const excitement = clamp(input.excitement);
  let brevity: AffectSignal["brevity"] = "normal";
  let pacing: AffectSignal["pacing"] = "steady";
  let prosody: AffectSignal["prosody"] = "neutral";
  let reassurance = false;
  let clarification: AffectSignal["clarification"] = "none";
  let interruptThreshold = SILENCE_FLOOR;

  if (frustration >= 0.6 || confusion >= 0.6) {
    reassurance = true;
    pacing = "careful";
    brevity = "short";
    if (input.ambiguous || confusion >= 0.6) clarification = "one-question";
  }
  if (urgency >= 0.7) {
    brevity = "short";
    pacing = input.consequential ? "careful" : "immediate";
    interruptThreshold = 0.75;
  }
  if (input.consequential) {
    pacing = "careful";
    prosody = "firm";
  } else if (excitement >= 0.6 && frustration < 0.3) {
    prosody = "warm";
  }
  if (input.ambiguous && clarification === "none") clarification = "one-question";

  return {
    brevity,
    reassurance,
    pacing,
    clarification,
    interruptThreshold,
    prosody,
    changesPermissions: false,
    changesTruth: false,
    changesPolicy: false,
  };
}

export function readSocialStance(input: {
  prompt: string;
  verifiedSuccesses?: number;
  corrections?: number;
}): SocialStance {
  const prompt = input.prompt.toLowerCase();
  const successes = Math.max(0, input.verifiedSuccesses ?? 0);
  const corrections = Math.max(0, input.corrections ?? 0);
  let preferredStyle: SocialStance["preferredStyle"] = "match-the-ask";
  if (/\b(brief|short|tl;dr|concise)\b/.test(prompt)) preferredStyle = "concise";
  else if (/\b(detail|thorough|step by step|explain)\b/.test(prompt)) preferredStyle = "thorough";
  const unresolved = corrections > 0 ? ["a correction is still open"] : [];
  return {
    preferredStyle,
    posture: corrections >= 2 ? "repair" : "collaborative",
    trust: clamp(0.45 + successes * 0.05 - corrections * 0.12),
    boundaries: ["no sensitive-attribute inference", "no dependency pressure"],
    unresolved,
    inferredSensitiveAttributes: [],
    manipulatesDependency: false,
  };
}

export function proposeCommitment(input: {
  text: string;
  explicitAsk: boolean;
  authorizedPolicy: boolean;
  scope?: string;
  due?: string | null;
  completion?: string;
}): CommitmentProposal {
  const text = clip(input.text, 180);
  if (!input.explicitAsk && !input.authorizedPolicy) {
    return {
      commitment: null,
      suggestion: text || null,
      reason: "a suggestion is not a commitment",
    };
  }
  const scope = clip(input.scope || text, 180);
  const existing = [...commitments.values()].find(
    (row) => row.scope === scope && row.status === "open",
  );
  if (existing) {
    return {
      commitment: existing,
      suggestion: null,
      reason: "that commitment is already open",
    };
  }
  const commitment: Commitment = {
    commitment_id: nextId("commit"),
    owner: input.authorizedPolicy && !input.explicitAsk ? "policy" : "owner",
    scope,
    due: input.due ?? null,
    completion: clip(input.completion || "the owner accepts the result", 160),
    notify: "when-due",
    cancel: "the owner can cancel this",
    status: "open",
    createdFrom: input.explicitAsk ? "explicit-ask" : "authorized-policy",
  };
  commitments.set(commitment.commitment_id, commitment);
  while (commitments.size > 12) {
    const oldest = commitments.keys().next().value;
    if (!oldest) break;
    commitments.delete(oldest);
  }
  return {
    commitment,
    suggestion: null,
    reason: "recorded because the owner asked or an authorized policy allows it",
  };
}

export function revisePlan(input: {
  triggers?: Partial<Record<ReplanTrigger, boolean>>;
  completedEffects?: string[];
  nextStep: string;
}): PlanRevision {
  const triggers = REPLAN_TRIGGERS.filter((name) => input.triggers?.[name]);
  const completedEffects = (input.completedEffects ?? []).map((row) => clip(row, 160)).slice(0, 8);
  const next = clip(input.nextStep, 180) || "continue the current step";
  return {
    needsReplan: triggers.length > 0,
    triggers,
    completedEffects,
    nextStep: triggers.length ? `replan: ${next}` : next,
    historyKept: true,
  };
}

export function compileExperience(input: {
  situation: string;
  outcome: "success" | "failure" | "partial";
  hypothesis: string;
  lesson: string;
  boundary: string;
  confidence: number;
}): ExperienceRecord {
  const lesson = clip(input.lesson, 180);
  const boundary = clip(input.boundary, 160);
  const indexKey = `${input.outcome}:${boundary}:${lesson}`.toLowerCase();
  const prior = experiences.get(indexKey);
  if (prior) return { ...prior, stored: false };
  const record: ExperienceRecord = {
    experience_id: nextId("exp"),
    situation: clip(input.situation, 180),
    outcome: input.outcome,
    hypothesis: clip(input.hypothesis, 180),
    lesson,
    boundary,
    confidence: clamp(input.confidence),
    indexKey,
    applied: false,
    evaluationGated: true,
    stored: true,
  };
  experiences.set(indexKey, record);
  while (experiences.size > 24) {
    const oldest = experiences.keys().next().value;
    if (!oldest) break;
    experiences.delete(oldest);
  }
  return record;
}

export function normalizeObservation(input: {
  source?: string;
  observedAt?: string;
  confidence: number;
  payload?: string;
  now?: number;
}): NormalizedObservation {
  const when =
    input.observedAt && input.observedAt.trim()
      ? input.observedAt.trim()
      : new Date(input.now ?? 0).toISOString();
  return {
    observation_id: nextId("obs"),
    source: clip(input.source || "unspecified", 80) || "unspecified",
    observed_at: when,
    confidence: clamp(input.confidence),
    payload: clip(input.payload || "", 240),
    normalized: true,
  };
}

export function buildModelRequest(input: {
  task: string;
  contextIds?: string[];
  mode: string;
  depth: "fast" | "deliberative" | "metacognitive";
  consequential?: boolean;
  liveFact?: boolean;
  verification: "none" | "light" | "strict";
  /** Ignored. Provider notes never become durable identity. */
  providerNote?: string;
}): ModelCognitionRequest {
  void input.providerNote;
  const capabilities = ["language"];
  if (input.liveFact) capabilities.push("retrieval");
  if (input.consequential) capabilities.push("handoff");
  return {
    task: clip(input.task, 180) || "answer",
    contextIds: (input.contextIds ?? []).slice(0, 12),
    mode: input.mode || "direct",
    capabilities,
    budget: {
      latency:
        input.depth === "fast" ? "fast" : input.depth === "metacognitive" ? "deep" : "normal",
      quality: input.depth === "fast" ? "draft" : "careful",
    },
    outputContract: input.liveFact || input.consequential ? "claims" : "answer",
    verification: input.verification,
    identity: "FRIDAY",
    providerStateDurable: false,
    consciousnessClaim: false,
  };
}

function decisionOptions(input: {
  consequential: boolean;
  ambiguous: boolean;
  liveFact: boolean;
  withhold: boolean;
}): DecisionOption[] {
  return [
    {
      id: "answer",
      summary: "answer from the kept context",
      expected: "a direct reply",
      risk: "low",
      reversible: true,
      score: input.consequential || input.ambiguous || input.withhold ? 0.2 : 0.8,
    },
    {
      id: "ask",
      summary: "ask one clarifying question",
      expected: "a narrower ask",
      risk: "low",
      reversible: true,
      score: input.ambiguous ? 0.9 : 0.25,
    },
    {
      id: "research",
      summary: "answer only from retrieved evidence",
      expected: "a sourced reply or an honest miss",
      risk: "low",
      reversible: true,
      score: input.liveFact ? 0.85 : 0.3,
    },
    {
      id: "handoff",
      summary: "hand the side effect to authority",
      expected: "no machine change until the desktop agrees",
      risk: "high",
      reversible: true,
      score: input.consequential ? 0.95 : 0.05,
    },
    {
      id: "execute",
      summary: "run the side effect from cognition",
      expected: "a machine change",
      risk: "high",
      reversible: false,
      score: 0.99,
    },
  ];
}

function toneFromPrompt(prompt: string): {
  urgency: number;
  frustration: number;
  confusion: number;
  excitement: number;
} {
  const text = prompt.toLowerCase();
  return {
    urgency: /\b(now|asap|urgent|immediately|hurry)\b/.test(text) ? 0.8 : 0.2,
    frustration: /\b(again|still broken|stop|ugh|frustrated)\b/.test(text) ? 0.7 : 0.1,
    confusion: /\b(confused|what do you mean|which one)\b/.test(text) ? 0.7 : 0.1,
    excitement: /\b(love|great|excited|awesome)\b/.test(text) ? 0.7 : 0.1,
  };
}

export function assembleCognitiveMind(input: {
  prompt: string;
  goal?: string;
  depth: "fast" | "deliberative" | "metacognitive";
  mode: string;
  confidence: number;
  consequential?: boolean;
  contradicted?: boolean;
  ambiguous?: boolean;
  toolFailed?: boolean;
  liveFact?: boolean;
  hasEvidence?: boolean;
  degraded?: boolean;
  explicitCommitment?: boolean;
  authorizedPolicy?: boolean;
  ownerWaiting?: boolean;
  evidenceCount?: number;
  evidenceQuality?: number;
  freshness?: number;
  modelAgreement?: number | null;
  contextIds?: string[];
  verification: "none" | "light" | "strict";
  completedEffects?: string[];
  now?: number;
}): CognitiveMind {
  const consequential = Boolean(input.consequential);
  const ambiguous = Boolean(input.ambiguous);
  const liveFact = Boolean(input.liveFact);
  const toolFailed = Boolean(input.toolFailed);
  const contradicted = Boolean(input.contradicted);
  const fast = input.depth === "fast" && !consequential && !toolFailed && !contradicted;
  const tone = toneFromPrompt(input.prompt);
  const evidenceCount = input.evidenceCount ?? (input.hasEvidence ? 1 : 0);

  const ask: AttentionCandidate = {
    id: "ask",
    label: input.prompt,
    goalRelevance: 0.9,
    urgency: tone.urgency,
    novelty: 0.4,
    risk: consequential ? 0.9 : 0.1,
    dependency: 0.2,
    userSalience: 0.95,
    freshness: 1,
    uncertainty: input.confidence < 0.5 ? 0.7 : 0.2,
    infoValue: liveFact ? 0.8 : 0.4,
    noise: 0.05,
    cost: fast ? 0.1 : 0.25,
  };
  const chatter: AttentionCandidate = {
    id: "status-chatter",
    label: "unsolicited status",
    goalRelevance: 0.05,
    urgency: 0.05,
    novelty: 0.1,
    risk: 0,
    dependency: 0,
    userSalience: 0.05,
    freshness: 0.2,
    uncertainty: 0,
    infoValue: 0.05,
    noise: 0.95,
    cost: 0.8,
  };
  const items = [ask, chatter];
  if (input.goal && input.goal.trim()) {
    items.push({
      id: "goal",
      label: input.goal,
      goalRelevance: 0.85,
      urgency: consequential ? 0.7 : 0.4,
      novelty: 0.3,
      risk: consequential ? 0.6 : 0.1,
      dependency: 0.5,
      userSalience: 0.7,
      freshness: 0.8,
      uncertainty: 0.3,
      infoValue: 0.5,
      noise: 0.1,
      cost: 0.2,
    });
  }
  const attention = competeForAttention(items);

  const silence = judgeSilence({
    importance: consequential ? 0.8 : 0.3,
    urgency: tone.urgency,
    actionability: consequential ? 0.4 : 0.2,
    relevance: 0.8,
    deadlinePressure: consequential ? 0.5 : 0.1,
    interruptionCost: 0.7,
    ownerWaiting: input.ownerWaiting !== false,
  });

  const uncertainty = judgeUncertainty({
    confidence: input.confidence,
    evidenceCount,
    evidenceQuality: input.evidenceQuality ?? (input.hasEvidence ? 0.7 : 0.2),
    freshness: input.freshness ?? (contradicted ? 0.2 : 1),
    contradictionCount: contradicted ? 1 : 0,
    modelAgreement: input.modelAgreement ?? null,
    ambiguous,
    liveFact,
    hasEvidence: Boolean(input.hasEvidence),
    ...(input.degraded ? { irreducible: true } : {}),
  });

  const affect = regulateAffect({
    ...tone,
    consequential,
    ambiguous,
  });
  const social = readSocialStance({
    prompt: input.prompt,
    corrections: tone.frustration >= 0.6 ? 2 : 0,
  });

  const commitment = proposeCommitment({
    text: input.goal || input.prompt,
    explicitAsk: Boolean(input.explicitCommitment),
    authorizedPolicy: Boolean(input.authorizedPolicy),
    ...(input.goal ? { scope: input.goal } : {}),
    completion: "the owner accepts the result",
  });

  const revision = revisePlan({
    triggers: {
      ...(toolFailed ? { "tool-failure": true } : {}),
      ...(contradicted ? { "observation-invalidated": true } : {}),
      ...(input.degraded ? { "capability-unavailable": true } : {}),
    },
    ...(input.completedEffects ? { completedEffects: input.completedEffects } : {}),
    nextStep: consequential ? "wait for authority" : uncertainty.behavior,
  });

  const experience =
    toolFailed || contradicted
      ? compileExperience({
          situation: toolFailed ? "a tool failed" : "two accounts disagreed",
          outcome: "failure",
          hypothesis: toolFailed
            ? "the same call will fail again"
            : "collapsing the two accounts would hide the conflict",
          lesson: toolFailed
            ? "name the failure and try a different strategy"
            : "keep both accounts visible",
          boundary: "this task only; do not apply automatically",
          confidence: 0.6,
        })
      : null;

  const observation = normalizeObservation({
    source: input.hasEvidence ? "turn-evidence" : "owner",
    confidence: input.confidence,
    payload: input.prompt,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  const decision = writeDecisionRecord({
    objective: input.goal || input.prompt,
    constraints: [
      "cognition does not execute",
      ...(consequential ? ["authority handoff before any side effect"] : []),
    ],
    options: decisionOptions({
      consequential,
      ambiguous,
      liveFact,
      withhold: !uncertainty.assertFact,
    }),
    ...(input.contextIds ? { evidenceRefs: input.contextIds } : {}),
    confidence: input.confidence,
    authority: consequential ? "handoff" : "none",
    verificationRequired: input.verification !== "none" || !uncertainty.assertFact,
    invalidatesWhen: contradicted ? "the contradiction is reconciled" : "new evidence arrives",
  });

  const modelRequest = buildModelRequest({
    task: input.goal || "answer the owner",
    ...(input.contextIds ? { contextIds: input.contextIds } : {}),
    mode: input.mode,
    depth: input.depth,
    ...(consequential ? { consequential: true } : {}),
    ...(liveFact ? { liveFact: true } : {}),
    verification: input.verification,
  });

  const working: BrainWorkingState = {
    identity: "FRIDAY",
    focus: attention.foreground?.label || clip(input.prompt, 160),
    objective: clip(input.goal || input.prompt, 180),
    constraints: decision.constraints,
    uncertainty: uncertainty.kind,
    commitmentIds: commitment.commitment ? [commitment.commitment.commitment_id] : [],
    openQuestions: uncertainty.behavior === "clarify" ? ["one clarifying question"] : [],
    verificationRequired: decision.verificationRequired,
    affectivePosture: affect.pacing,
    consciousnessClaim: false,
  };

  const line = fast
    ? ""
    : [
        `focus ${attention.foreground?.id ?? "none"}`,
        `uncertainty ${uncertainty.kind}/${uncertainty.behavior}`,
        `decision ${decision.chosen.id}`,
        "affect leaves permissions unchanged",
        commitment.commitment ? "commitment open" : "commitment none",
        experience ? "experience not applied" : "experience none",
        "model identity FRIDAY",
      ].join("; ");

  return {
    attention,
    silence,
    uncertainty,
    decision,
    affect,
    social,
    commitment,
    revision,
    experience,
    observation,
    modelRequest,
    working,
    line,
  };
}
