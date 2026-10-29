/**
 * FRIDAY · cognitive route table
 *
 * Wires existing signals into one decision — not a new router, model
 * registry, or hardcoded "this model is better".
 *
 *   SIMPLE        → fast-path
 *   NORMAL        → best-single-model
 *   COMPLEX       → deep-reasoning
 *   HIGH-STAKES   → multi-model + verification
 *   UNKNOWN       → research
 *   REPEATED      → reuse-result
 */

import { isConsequential } from "./action-risk";
import { estimateConfidence } from "./confidence";
import { findRecentSubTask } from "../self/task-ledger";
import { looksLikeCorrection } from "./intent-engine";

export type CognitiveClass =
  "simple" | "normal" | "complex" | "high-stakes" | "unknown" | "repeated";

export type CognitiveAction =
  "fast-path" | "best-single" | "deep-reasoning" | "multi-verify" | "research" | "reuse-result";

export type CognitiveRoute = {
  klass: CognitiveClass;
  action: CognitiveAction;
  reason: string;
};

const LIVE =
  /\b(search|google|look ?up|latest|news|today'?s|current(?:ly)?|right now|price|weather)\b/i;
const COMPLEX_KIND = /^(code|reasoning|system)$/;
const RELATED = /\bhow is\b.+\brelated\b|\bmulti-?hop\b|\broot cause\b|\bwhat would break\b/i;
const CREATIVE_CHAT = /\b(haiku|poem|joke|hello|hi\b|thanks|write a)\b/i;
const TRIVIAL =
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|good|great|cool|sure|hmm|namaste|shukriya)[\s.!]*$/i;

export function classifyCognitiveRoute(input: {
  prompt: string;
  kind: string;
  ambiguous?: boolean;
  understandingConfidence?: number;
}): CognitiveRoute {
  const prompt = String(input.prompt || "").trim();
  const confidence = estimateConfidence(prompt);

  if (isConsequential(prompt) && input.kind !== "chat") {
    return {
      klass: "high-stakes",
      action: "multi-verify",
      reason: "action-risk: consequential — multi-model + verify, never a silent auto-run",
    };
  }

  if (TRIVIAL.test(prompt) && !looksLikeCorrection(prompt) && !input.ambiguous) {
    return {
      klass: "simple",
      action: "fast-path",
      reason: "acknowledgement — skip deep fabric, keep governance elsewhere",
    };
  }

  if (looksLikeCorrection(prompt) && input.kind === "chat") {
    return {
      klass: "normal",
      action: "best-single",
      reason: "correction — incorporate on the normal path, do not fast-path a greeting",
    };
  }

  if (input.ambiguous || LIVE.test(prompt)) {
    return {
      klass: "unknown",
      action: "research",
      reason: input.ambiguous
        ? "understanding is ambiguous — research or ask rather than guess"
        : "live-fact prompt — research instead of a model's memory",
    };
  }

  // Preferred-model scoring stays in orchestrator.ts (measured sample size).
  // This table only flags a duplicate-work hit as reuse-result.
  const reuse = findRecentSubTask("reasoner", prompt) ?? findRecentSubTask("fast", prompt);
  if (reuse) {
    return {
      klass: "repeated",
      action: "reuse-result",
      reason: "duplicate-work guard found a recent equivalent result",
    };
  }

  if (COMPLEX_KIND.test(input.kind) || (input.understandingConfidence ?? 1) < 0.7) {
    return {
      klass: "complex",
      action: "deep-reasoning",
      reason: "kind or understanding needs the deep fabric",
    };
  }

  if (RELATED.test(prompt) && !CREATIVE_CHAT.test(prompt)) {
    return {
      klass: "complex",
      action: "deep-reasoning",
      reason: "related-entity / multi-hop ask needs graph + reasoning",
    };
  }

  if (input.kind === "chat" && confidence.score >= 0.5) {
    return {
      klass: "simple",
      action: "fast-path",
      reason: "simple chat — light fabric / fast-path",
    };
  }

  return {
    klass: "normal",
    action: "best-single",
    reason: "one best measured model — no hardcoded superiority",
  };
}
