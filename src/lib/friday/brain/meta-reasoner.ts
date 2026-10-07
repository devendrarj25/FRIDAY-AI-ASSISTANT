/**
 * FRIDAY · meta-reasoner
 *
 * Before an important conclusion, answer from existing signals: what is known,
 * unknown, assumed, stale, or low-confidence — and pick a real next action
 * (research, ask, verify, safer collaboration, or proceed). This does not
 * reimplement reasoning in TypeScript; models still do the thinking.
 *
 * `brain/reasoning.ts` already lists private stages. No `brain/reasoning/`
 * folder (that path would collide with the existing file).
 */

import { estimateConfidence, CONFIDENT_THRESHOLD } from "./confidence";
import { capabilityMatrix } from "../self/capability-matrix";
import { considerCollaboration } from "./multi-model";
import { isConsequential } from "./action-risk";
import { readWorldState, factFreshness } from "./world-model";
import { brainKnowledge } from "./knowledge-base";
import { memory } from "../self/memory-engine";
import type { UnderstoodIntent } from "./intent-engine";
import { leaksForeignIdentity, enforceIdentity } from "./reconciler";
import { capabilityRegistry } from "./capability-registry";
import { modelRegistry } from "./model-registry";
import { looksLikeLiveFact, looksLikeKnowledgeAsk, shouldResearch } from "./research";
import { gradeRetrieval } from "./retrieval";

export type MetaAction =
  "proceed" | "ask" | "research" | "verify" | "safer" | "execute" | "defer" | "switch-model";

export type MetaReview = {
  known: string[];
  unknown: string[];
  assumptions: string[];
  evidenceReliable: boolean;
  stale: boolean;
  action: MetaAction;
  reason: string;
  ask: string | null;
};

/** Machine-changing asks — not "write a haiku". */
const SYSTEM_ACT =
  /\b(delete|install|uninstall|shutdown|restart|reboot|execute|overwrite|format|wipe)\b/i;

export function reviewAssumptions(input: { text: string; intent?: UnderstoodIntent }): MetaReview {
  const text = String(input.text || "").trim();
  const known: string[] = [];
  const unknown: string[] = [];
  const assumptions: string[] = [];

  const confidence = estimateConfidence(text);
  const consequential = isConsequential(text);
  const collab = considerCollaboration(text, { confidence });

  for (const domain of confidence.domains) {
    const score = capabilityMatrix.score(domain);
    if (score.provisional) {
      unknown.push(`${score.label} is still a declared baseline, not measured`);
      assumptions.push(`assuming the ${score.label} baseline is good enough`);
    } else {
      known.push(`${score.label} measured ${score.score}/100 over ${score.runs} run(s)`);
    }
  }

  try {
    const mem = memory.search(text, { k: 2 });
    if (mem.length) known.push(`memory: ${mem.length} hit(s)`);
    else unknown.push("no matching memory");
  } catch {
    unknown.push("memory unreadable");
  }

  try {
    const knowledge = brainKnowledge.recall(text, { k: 2 });
    if (knowledge.length) {
      const staleBelief = knowledge.some(
        (entry) => entry.freshnessAt && Date.now() - entry.freshnessAt > 14 * 86_400_000,
      );
      if (staleBelief) unknown.push("stored knowledge may be stale");
      else known.push(`knowledge: ${knowledge.length} hit(s)`);
      if (knowledge.some((entry) => entry.contradiction)) {
        unknown.push("knowledge has an unresolved contradiction");
        assumptions.push("not auto-resolving the contradiction");
      }
    } else {
      unknown.push("no matching knowledge");
    }
  } catch {
    unknown.push("knowledge unreadable");
  }

  let stale = false;
  try {
    const world = readWorldState();
    for (const fact of world.facts) {
      const freshness = factFreshness(fact);
      if (freshness === "stale") {
        stale = true;
        unknown.push(`world.${fact.domain} is stale`);
      } else if (freshness === "unknown") {
        unknown.push(`world.${fact.domain} is unknown`);
      } else {
        known.push(`world.${fact.domain} live`);
      }
    }
  } catch {
    unknown.push("world state unreadable");
  }

  if (input.intent?.needsClarification) {
    unknown.push("referent or intent is missing");
  }
  if (
    input.intent?.understandingConfidence !== undefined &&
    input.intent.understandingConfidence < 0.4
  ) {
    unknown.push("understanding confidence is below 0.4");
  }

  const evidenceReliable =
    !stale && unknown.filter((line) => /contradiction|stale/.test(line)).length === 0;

  let action: MetaAction = "proceed";
  let reason = "signals are good enough to continue";
  let ask: string | null = null;

  if (
    input.intent?.needsClarification ||
    (input.intent?.understandingConfidence !== undefined &&
      input.intent.understandingConfidence < 0.4 &&
      (input.intent.missingInformation?.length ?? 0) > 0)
  ) {
    action = "ask";
    reason = input.intent.ask ?? "Need a clearer target before acting.";
    ask = reason;
  } else {
    let knowledgeStatus = "";
    let retrievalGrade: ReturnType<typeof gradeRetrieval>["grade"] | undefined;
    try {
      const status = brainKnowledge.queryStatus(text);
      knowledgeStatus = status.status;
      const hits = brainKnowledge.recall(text, { k: 3 });
      retrievalGrade = gradeRetrieval(
        hits.map((entry) => ({ score: Math.max(0.2, entry.confidence) })),
      ).grade;
    } catch {
      /* optional */
    }
    if (
      shouldResearch({
        status: knowledgeStatus,
        liveFact: looksLikeLiveFact(text),
        knowledgeAsk: looksLikeKnowledgeAsk(text),
        ...(retrievalGrade ? { retrievalGrade } : {}),
      })
    ) {
      action = "research";
      reason = looksLikeLiveFact(text)
        ? "this needs a live check rather than a remembered guess"
        : looksLikeKnowledgeAsk(text)
          ? `Self-RAG: factual ask with ${knowledgeStatus || "unknown"} store — retrieve live sources`
          : `stored knowledge is ${knowledgeStatus || "unknown"} — research only because it is not known and fresh`;
    } else if (collab.warranted) {
      action = "safer";
      reason = collab.reason;
    } else if (consequential && confidence.score < CONFIDENT_THRESHOLD) {
      action = "verify";
      reason =
        "this can change the machine and confidence is below the local threshold — verify or confirm first";
      if (confidence.score < 0.4) {
        action = "ask";
        ask = reason;
      }
    } else if (!evidenceReliable && consequential) {
      action = "verify";
      reason = "evidence looks stale or contradicted — verify before concluding";
    }
  }

  if (action === "proceed") {
    try {
      const snap = capabilityRegistry.getSnapshot();
      const down = snap.resources.filter(
        (row) => row.health === "offline" || row.health === "degraded",
      );
      if (SYSTEM_ACT.test(text) && down.length) {
        action = "defer";
        reason = `${down.length} capability resource(s) degraded/offline — do not execute blindly`;
      }
    } catch {
      /* registry optional */
    }
  }
  if (action === "proceed") {
    try {
      const cooling = modelRegistry.list().filter((row) => row.coolingDown);
      if (cooling.length && SYSTEM_ACT.test(text)) {
        action = "switch-model";
        reason = `${cooling.length} model(s) cooling down — pick another specialist`;
      }
    } catch {
      /* registry optional */
    }
  }
  if (
    action === "proceed" &&
    SYSTEM_ACT.test(text) &&
    evidenceReliable &&
    confidence.score >= CONFIDENT_THRESHOLD
  ) {
    action = "execute";
    reason = "evidence and confidence are sufficient to act through existing governance";
  }

  return {
    known,
    unknown,
    assumptions,
    evidenceReliable,
    stale,
    action,
    reason,
    ask,
  };
}

export type SelfEvaluation = {
  ran: boolean;
  ok: boolean;
  issues: string[];
  reason: string;
};

const CERTAIN = /\b(definitely|certainly|guaranteed|confirmed fact|i am sure)\b/i;

function contentTerms(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
}

/**
 * Cheap check before finalizing a consequential answer. Skipped for trivial
 * chat so the fast path stays fast (`isConsequential` from action-risk).
 */
export function evaluateAnswer(input: {
  prompt: string;
  answer: string;
  meta?: MetaReview;
  goal?: string;
  toolsFailed?: boolean;
  knowledgeSupported?: boolean;
  groundedness?: number;
}): SelfEvaluation {
  const prompt = String(input.prompt || "").trim();
  const answer = String(input.answer || "").trim();
  if (!isConsequential(prompt) && !isConsequential(answer)) {
    return { ran: false, ok: true, issues: [], reason: "trivial — skipped for speed" };
  }

  const issues: string[] = [];
  const promptTerms = contentTerms(prompt);
  const answerTerms = new Set(contentTerms(answer));
  const overlap = promptTerms.filter((word) => answerTerms.has(word)).length;
  if (promptTerms.length >= 2 && overlap === 0) {
    issues.push("answer does not address the owner's ask");
  }

  const goal = String(input.goal || "").trim();
  if (goal) {
    const goalTerms = contentTerms(goal);
    const goalHit = goalTerms.filter((word) => answerTerms.has(word)).length;
    if (goalTerms.length >= 2 && goalHit === 0) {
      issues.push("answer drifted from the resolved goal");
    }
  }

  if (leaksForeignIdentity(answer)) {
    issues.push("answer still speaks as another model");
  }

  if (input.toolsFailed && !/\b(fail|could not|unavailable|did not)\b/i.test(answer)) {
    issues.push("execution failed but the answer does not say so");
  }

  if (input.knowledgeSupported === false && CERTAIN.test(answer)) {
    issues.push("answer claims certainty without supporting knowledge");
  }

  if (typeof input.groundedness === "number" && input.groundedness < 0.35 && CERTAIN.test(answer)) {
    issues.push("answer claims certainty while reasoning was weakly grounded");
  }

  const must = prompt.match(/\bmust\s+(?:include|contain|have)\s+([^.,;]+)/i);
  if (must?.[1]) {
    const need = must[1].trim().toLowerCase();
    const token = need.split(/\s+/).find((word) => word.length > 3) ?? need;
    if (token && !answer.toLowerCase().includes(token.slice(0, 40))) {
      issues.push("answer missed a stated must-include criterion");
    }
  }

  const meta = input.meta;
  if (meta) {
    if (meta.action === "ask" && !/\?/.test(answer) && answer.length > 80) {
      issues.push("meta-reasoner asked to clarify but the answer proceeds as if settled");
    }
    if (!meta.evidenceReliable && CERTAIN.test(answer)) {
      issues.push("answer claims certainty while meta-reasoner marked evidence unreliable");
    }
    if (
      meta.action === "research" &&
      !/\b(search|looked up|live|don't know|do not know)\b/i.test(answer)
    ) {
      issues.push("meta-reasoner wanted a live check but the answer does not say it looked");
    }
  }

  return {
    ran: true,
    ok: issues.length === 0,
    issues,
    reason: issues.length
      ? issues.join("; ")
      : "consequential answer matches ask, goal, and meta signals",
  };
}

const TRIVIAL_CHAT =
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|good|great|cool|sure|hmm|namaste|shukriya)[\s.!]*$/i;
const FILLER_OPENER =
  /^(i understand\.?|got it\.?|great question\.?|that's a great question\.?|as an ai[^.]*\.?)\s*/i;
const INTERNAL_LEAK =
  /\b(core-brain|cognitive route|vitest|intent-engine|decision-trace|as a language model)\b/i;

export function reviseConversationalAnswer(answer: string): string {
  let text = enforceIdentity(String(answer || ""));
  text = text.replace(FILLER_OPENER, "");
  text = text.replace(/^(sure[,.]?\s*){2,}/i, "");
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Lightweight conversational fit. Runs even when the turn is not
 * consequential, except for bare greetings. Does not dump chain-of-thought.
 */
export function evaluateConversationalFit(input: {
  prompt: string;
  answer: string;
  goal?: string;
  strategy?: string;
  correction?: boolean;
  frustrated?: boolean;
  selectedDecision?: string;
  rejected?: string[];
}): SelfEvaluation {
  const prompt = String(input.prompt || "").trim();
  const revised = reviseConversationalAnswer(input.answer);
  if (TRIVIAL_CHAT.test(prompt) && !input.correction) {
    return { ran: false, ok: true, issues: [], reason: "trivial chat — skipped for speed" };
  }

  const issues: string[] = [];
  const answer = revised.toLowerCase();

  if (leaksForeignIdentity(revised)) {
    issues.push("answer still speaks as another model");
  }
  if (INTERNAL_LEAK.test(revised)) {
    issues.push("answer leaked internal implementation details");
  }
  if (FILLER_OPENER.test(String(input.answer || ""))) {
    issues.push("answer opened with filler");
  }
  // Goal-term overlap lives on evaluateAnswer for consequential turns.
  // Short replies ("A closure captures its scope.") must not fail verify.
  if (input.strategy === "ask-clarification" && !/\?/.test(revised) && revised.length > 80) {
    issues.push("strategy was to clarify but the answer proceeds as if settled");
  }
  if (input.correction && /^(i understand|as i (said|mentioned))/i.test(revised)) {
    issues.push("correction was not incorporated — answer is defensive");
  }
  if (input.frustrated && revised.length > 900) {
    issues.push("answer is too long for a frustrated turn");
  }
  const rejected = input.rejected ?? [];
  if (
    input.selectedDecision &&
    rejected.some((item) => item && answer.includes(item.slice(0, 24).toLowerCase())) &&
    !answer.includes(input.selectedDecision.slice(0, 24).toLowerCase())
  ) {
    issues.push("answer ignored a decision already made");
  }

  return {
    ran: true,
    ok: issues.length === 0,
    issues,
    reason: issues.length ? issues.join("; ") : "conversational fit is acceptable",
  };
}
