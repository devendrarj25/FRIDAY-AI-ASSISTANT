/**
 * FRIDAY · multi-model collaboration decision
 *
 * Deliberate, rare and always explainable. FRIDAY normally answers one turn
 * with one model. Two or three models are run CONCURRENTLY only when:
 *
 *   1. her own confidence engine (brain/confidence.ts, fed by the real
 *      capability matrix) says there is a genuine capability gap for this
 *      task, and the task is consequential enough to be worth the extra
 *      requests — the FRIDAY-initiated case; or
 *   2. the owner explicitly asks for it ("second opinion", "check this with
 *      two models", "cross-check this") — the owner-initiated case.
 *
 * Nothing here calls a model. The execution itself goes through the existing
 * main-process `selectParallel()` path (one privacy confirmation and one
 * billing check per model actually used), and the answers are merged by the
 * existing reconciler (`coreBrain.reconcileTurn`) — no new synthesis engine.
 *
 * Duplicate-work reuse (same or recent equivalent sub-task) lives in
 * `brain/orchestrator.ts` `dispatchRole` and `self/task-ledger.ts`. This
 * module still decides whether a turn deserves independent second opinions
 * and does not collapse those on purpose. Pass `allowReuse: false` when a
 * collaboration path must actually run each model.
 */

import { estimateConfidence, type Confidence } from "./confidence";
import { isConsequential } from "./action-risk";
import { capabilityMatrix, DOMAIN_LABEL } from "../self/capability-matrix";
import { turnDone, turnMark } from "./turn-timing";

/** Below this the capability gap is real, not just an unfamiliar phrasing. */
export const COLLABORATION_GAP = 0.5;

/** The owner asking, in his own words, for more than one model on a task. */
const OWNER_REQUEST =
  /\b(second opinion|another opinion|cross[- ]?check|double[- ]?check(?:\s+(?:this|that|it))?(?:\s+with)?|check (?:this|that|it) carefully|check (?:this|that|it) with (?:two|2|three|3|multiple|another|other) models?|(?:use|ask|try) (?:two|2|three|3|multiple|another|other) models?|compare (?:answers|models)|what do other models say)\b/i;

/** Phrases that mean a wrong answer would actually cost the owner something. */
const HIGH_STAKES =
  /\b(production|deploy|release|migration|irreversible|security|credential|financial|payment|legal|medical|delete everything|before i (?:ship|send|sign|publish))\b/i;

export type CollaborationDecision = {
  /** True when this turn should genuinely fan out to several models. */
  warranted: boolean;
  /** Who asked for it — the owner, or FRIDAY's own capability judgement. */
  initiator: "owner" | "friday" | null;
  /** How many models to run concurrently (2 normally, 3 when asked for). */
  count: number;
  /** One plain sentence the owner can read in the trace and the run log. */
  reason: string;
  confidence: Confidence;
};

/**
 * Decide whether one turn deserves real multi-model collaboration.
 * Pure: the confidence source can be injected so tests need no browser.
 */
export function considerCollaboration(
  prompt: string,
  options: { confidence?: Confidence; enabled?: boolean } = {},
): CollaborationDecision {
  turnMark("multi-model", "consider");
  const text = (prompt ?? "").trim();
  const confidence = options.confidence ?? estimateConfidence(text);
  const no = (reason: string): CollaborationDecision => {
    turnDone("multi-model", "consider", "no");
    return {
      warranted: false,
      initiator: null,
      count: 1,
      reason,
      confidence,
    };
  };

  if (options.enabled === false) return no("multi-model collaboration is switched off in settings");
  if (!text) return no("nothing to work on");

  if (OWNER_REQUEST.test(text)) {
    turnDone("multi-model", "consider", "owner");
    return {
      warranted: true,
      initiator: "owner",
      count: 3,
      reason: "you asked me to check this with more than one model",
      confidence,
    };
  }

  // FRIDAY-initiated: a real, measured capability gap on a request where being
  // wrong actually matters. Both halves must hold, which is what keeps this
  // off the ordinary path.
  const gap = confidence.score < COLLABORATION_GAP;
  const stakes = HIGH_STAKES.test(text) || isConsequential(text);
  if (gap && stakes) {
    const weakest = confidence.domains
      .map((domain) => capabilityMatrix.score(domain))
      .sort((a, b) => a.score - b.score)[0];
    const where = weakest
      ? `${weakest.label} is my weakest capability here (${weakest.score}/100)`
      : `${confidence.domains.map((d) => DOMAIN_LABEL[d]).join(", ")} is outside what I've proven`;
    turnDone("multi-model", "consider", "friday");
    return {
      warranted: true,
      initiator: "friday",
      count: 2,
      reason: `my confidence was ${Math.round(confidence.score * 100)}% and this one matters — ${where}, so I compared two independent answers`,
      confidence,
    };
  }

  return no(
    gap
      ? "confidence is low but the task is not consequential enough to spend extra model calls"
      : "one model is enough for this",
  );
}

/** True when the owner's wording alone asks for more than one model. */
export function ownerAskedForSecondOpinion(prompt: string): boolean {
  return OWNER_REQUEST.test(prompt ?? "");
}
