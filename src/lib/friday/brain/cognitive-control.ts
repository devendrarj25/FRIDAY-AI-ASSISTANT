/**
 * FRIDAY · cognitive control
 *
 * One executive pass around the existing brain. It ranks context, picks a
 * reasoning mode, records verification debt, and can propose a different
 * strategy after a miss. It does not execute tools, replace the model router,
 * or apply a lesson by itself. Governance stays outside.
 *
 * Adapted from the brain research already adopted for FRIDAY:
 * Self-RAG (retrieve only when the line earns a place), Tree of Thoughts
 * (at most three scored modes), Reflexion (a verbal lesson, not a weight
 * update), and bounded context (stale low-value lines drop first).
 */

import type { CognitiveRoute } from "./cognitive-route";
import {
  compileContextPacket,
  contextBudgetFor,
  type CompiledContext,
  type ContextDraft,
} from "./context-engine";
import {
  deliberateModes,
  describeAntiAnchor,
  selectReasoningMode,
  type AntiAnchorProposal,
  type ReasoningMode,
  type ThoughtCandidate,
} from "./reasoning";
import { reconcileTemporalBeliefs, type BeliefMark, type TemporalClaim } from "./world-model";
import { assembleCognitiveMind, type CognitiveMind } from "./cognitive-mind";
import { runCognitiveRuntime, type CognitiveRuntimeRecord } from "./cognitive-runtime";

export type CognitiveDepth = "fast" | "deliberative" | "metacognitive";

export type CognitiveDisposition = "continue" | "pause" | "replan" | "complete" | "wait";

export type ActionIntentKind = "answer" | "ask" | "research" | "handoff" | "wait" | "replan";

export type ActionIntent = {
  id: string;
  kind: ActionIntentKind;
  summary: string;
  authority: "none" | "handoff";
  executes: false;
};

export type VerificationDebt = {
  id: string;
  claim: string;
  needed: string;
  open: true;
};

export type DepthPlan = {
  depth: CognitiveDepth;
  mode: ReasoningMode;
  reason: string;
  forceDeep: boolean;
};

export type CognitiveCycle = {
  id: string;
  at: string;
  depth: CognitiveDepth;
  mode: ReasoningMode;
  memoryScope: Array<"working" | "episodic" | "semantic" | "belief">;
  verificationLevel: "none" | "light" | "strict";
  interrupt: { user: false; reason: "proactive silence" };
  disposition: CognitiveDisposition;
  context: CompiledContext;
  beliefs: BeliefMark[];
  intent: ActionIntent;
  debts: VerificationDebt[];
  candidates: ThoughtCandidate[];
  experience: AntiAnchorProposal | null;
  /** State machine for this pass. It never executes a side effect. */
  runtime: CognitiveRuntimeRecord;
  /** Attention, uncertainty, decision, affect, and the model request. */
  mind: CognitiveMind;
  publicNote: string;
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1).toString(36)}`;

function memoryScope(depth: CognitiveDepth): CognitiveCycle["memoryScope"] {
  if (depth === "metacognitive") return ["working", "episodic", "semantic", "belief"];
  if (depth === "deliberative") return ["working", "episodic", "belief"];
  return ["working"];
}

/**
 * How deep this turn should go. A fast-path route stays light so a greeting
 * or a short creative line does not pull the world and meta fabric.
 */
export function planCognitiveDepth(input: {
  prompt: string;
  kind: string;
  route: CognitiveRoute;
  confidence: number;
  ambiguous: boolean;
}): DepthPlan {
  const consequential = input.route.klass === "high-stakes";
  const mode = selectReasoningMode({
    prompt: input.prompt,
    consequential,
    ambiguous: input.ambiguous,
    complex: input.route.klass === "complex" || input.kind === "reasoning" || input.kind === "code",
    liveFact: input.route.action === "research",
  });

  if (input.route.action === "fast-path" && !input.ambiguous && input.confidence >= 0.45) {
    return {
      depth: "fast",
      mode: "direct",
      reason: "fast path stays light — proactive silence",
      forceDeep: false,
    };
  }

  if (consequential || input.confidence < 0.45) {
    return {
      depth: "metacognitive",
      mode: mode === "direct" ? "verification-first" : mode,
      reason: consequential
        ? "high-stakes — verify before any handoff"
        : "low confidence — check assumptions before answering",
      forceDeep: true,
    };
  }

  if (
    input.route.klass === "complex" ||
    input.route.klass === "unknown" ||
    input.route.action === "research" ||
    input.ambiguous ||
    mode !== "direct"
  ) {
    return {
      depth: "deliberative",
      mode,
      reason: "score a second mode before committing",
      forceDeep: true,
    };
  }

  return {
    depth: "fast",
    mode,
    reason: "one direct pass",
    forceDeep: false,
  };
}

export function finishCognitiveCycle(input: {
  prompt: string;
  plan: DepthPlan;
  route: CognitiveRoute;
  goal?: string;
  strategy?: string;
  confidence: number;
  ambiguous: boolean;
  consequential?: boolean;
  contradicted?: boolean;
  failed?: boolean;
  toolFailed?: boolean;
  liveFact?: boolean;
  /** Retrieved web sources. Stored memory does not close a live-fact debt. */
  liveSources?: number;
  hasEvidence?: boolean;
  paused?: boolean;
  /** True only when the owner explicitly asked FRIDAY to take this on. */
  explicitCommitment?: boolean;
  claims?: TemporalClaim[];
  drafts?: ContextDraft[];
  now?: number;
}): CognitiveCycle {
  const now = input.now ?? Date.now();
  let depth = input.plan.depth;
  let mode = input.contradicted
    ? "verification-first"
    : input.failed || input.toolFailed
      ? "recovery"
      : input.plan.mode;
  if (input.contradicted && depth !== "metacognitive") depth = "metacognitive";
  else if ((input.failed || input.toolFailed) && depth === "fast") depth = "deliberative";

  const beliefs = reconcileTemporalBeliefs(input.claims ?? [], now);
  const packet = compileContextPacket(input.drafts ?? [], contextBudgetFor(depth));
  const candidates = deliberateModes({
    primary: mode,
    depth,
    contradicted: Boolean(
      input.contradicted || beliefs.some((row) => row.status === "contradicted"),
    ),
    ...(input.consequential ? { consequential: true } : {}),
    ...(input.hasEvidence ? { hasEvidence: true } : {}),
    ...(input.liveFact ? { liveFact: true } : {}),
    ...(input.failed || input.toolFailed ? { failed: true } : {}),
  });
  const kept = candidates.find((row) => row.kept) ?? candidates[0];
  if (kept) mode = kept.mode;

  const debts: VerificationDebt[] = [];
  if (input.contradicted || beliefs.some((row) => row.status === "contradicted")) {
    debts.push({
      id: nextId("debt"),
      claim: "two accounts disagree",
      needed: "keep both visible and do not collapse them into one fact",
      open: true,
    });
  }
  const missingLive = Boolean(input.liveFact) && (input.liveSources ?? 0) === 0;
  if (missingLive) {
    debts.push({
      id: nextId("debt"),
      claim: "this asks for a live fact",
      needed: "a retrieved source, or an explicit statement that the search failed",
      open: true,
    });
  }
  if (input.toolFailed) {
    debts.push({
      id: nextId("debt"),
      claim: "a tool failed",
      needed: "the answer names the failure",
      open: true,
    });
  }
  if (input.consequential) {
    debts.push({
      id: nextId("debt"),
      claim: "this can change the machine",
      needed: "authority handoff before any side effect",
      open: true,
    });
  }

  let disposition: CognitiveDisposition = "continue";
  if (input.paused) disposition = "pause";
  else if (input.ambiguous || input.confidence < 0.4) disposition = "wait";
  else if (input.contradicted) disposition = "replan";
  else if (depth === "fast" && mode === "direct" && !debts.length) disposition = "complete";

  let kind: ActionIntentKind = "answer";
  let authority: ActionIntent["authority"] = "none";
  if (input.consequential || input.route.klass === "high-stakes") {
    kind = "handoff";
    authority = "handoff";
  } else if (disposition === "wait") kind = "ask";
  else if (disposition === "pause") kind = "wait";
  else if (disposition === "replan") kind = "replan";
  else if (input.liveFact || input.route.action === "research") kind = "research";

  const intent: ActionIntent = {
    id: nextId("act"),
    kind,
    authority,
    executes: false,
    summary:
      authority === "handoff"
        ? "Hand the side effect to the existing authority path. Do not run it from cognition."
        : kind === "ask"
          ? "Ask one clarifying question instead of guessing."
          : kind === "research"
            ? "Answer from retrieved evidence, or say the lookup failed."
            : kind === "replan"
              ? "The previous account conflicts. Replan before stating a fact."
              : "Answer from the kept context. Do not add an unsolicited interruption.",
  };

  const material = Boolean(input.failed || input.toolFailed || input.contradicted || missingLive);
  const experience = material
    ? describeAntiAnchor({
        failed: input.plan.mode,
        cause: input.toolFailed
          ? "a tool failed"
          : input.contradicted
            ? "beliefs contradict"
            : input.failed
              ? "the turn failed verification"
              : "live evidence is missing",
      })
    : null;

  const verificationLevel: CognitiveCycle["verificationLevel"] =
    depth === "metacognitive" || debts.length
      ? "strict"
      : depth === "deliberative"
        ? "light"
        : "none";

  const publicNote = [
    `depth ${depth}`,
    `mode ${mode}`,
    `intent ${intent.kind}`,
    `authority ${intent.authority}`,
    "executes: false",
    "proactive silence",
    `verification debt ${debts.length}`,
    experience ? `anti-anchor ${experience.alternative} not applied` : "",
    input.strategy ? `strategy ${input.strategy}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  const mind = assembleCognitiveMind({
    prompt: input.prompt,
    ...(input.goal ? { goal: input.goal } : {}),
    depth,
    mode,
    confidence: input.confidence,
    ...(input.consequential ? { consequential: true } : {}),
    ...(input.contradicted ? { contradicted: true } : {}),
    ...(input.ambiguous ? { ambiguous: true } : {}),
    ...(input.toolFailed ? { toolFailed: true } : {}),
    ...(input.liveFact ? { liveFact: true } : {}),
    ...(input.hasEvidence ? { hasEvidence: true } : {}),
    ...(input.explicitCommitment ? { explicitCommitment: true } : {}),
    evidenceCount: input.liveSources ?? (input.hasEvidence ? 1 : 0),
    contextIds: packet.included.map((item) => item.id),
    verification: verificationLevel,
    ownerWaiting: true,
    now,
  });

  const runtime = runCognitiveRuntime({
    prompt: input.prompt,
    ...(input.goal ? { goal: input.goal } : {}),
    mode,
    depth,
    confidence: input.confidence,
    ...(input.consequential ? { consequential: true } : {}),
    ...(input.contradicted ? { contradicted: true } : {}),
    ...(input.liveFact ? { liveFact: true } : {}),
    ...(input.hasEvidence ? { hasEvidence: true } : {}),
    ...(input.toolFailed ? { toolFailed: true } : {}),
    ...(input.ambiguous ? { ambiguous: true } : {}),
    ownerWaiting: true,
    now,
  });

  return {
    id: nextId("cyc"),
    at: new Date(now).toISOString(),
    depth,
    mode,
    memoryScope: memoryScope(depth),
    verificationLevel,
    interrupt: { user: false, reason: "proactive silence" },
    disposition,
    context: packet,
    beliefs,
    intent,
    debts,
    candidates,
    experience,
    runtime,
    mind,
    publicNote,
  };
}
