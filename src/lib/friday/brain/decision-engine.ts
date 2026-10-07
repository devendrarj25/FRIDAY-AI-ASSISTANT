/**
 * FRIDAY · decision engine
 *
 * For a meaningful turn: goal, constraints, risk, cost policy, confidence,
 * reversibility. Chooses the safest effective next action. Low confidence or
 * risky work asks the owner instead of guessing.
 */

import { actionMode, isConsequential } from "./action-risk";
import { currentPolicy } from "./cost-policy";
import { CONFIDENT_THRESHOLD, estimateConfidence } from "./confidence";
import type { UnderstoodIntent } from "./intent-engine";
import { reviewAssumptions } from "./meta-reasoner";
import { getConversationSession } from "./conversation-state";
import { affect } from "./affect";

export type DecisionRoute =
  "baseline" | "memory" | "web" | "tool" | "skill" | "model" | "confirm" | "ask";

export type ResponseStrategy =
  | "answer-directly"
  | "answer-briefly"
  | "explain"
  | "ask-clarification"
  | "provide-options"
  | "recommend-one"
  | "disagree-respectfully"
  | "correct-misunderstanding"
  | "acknowledge-correction"
  | "continue-task"
  | "summarize-state"
  | "execute-action"
  | "verify-first"
  | "research-first"
  | "warn-risk"
  | "defer"
  | "acknowledge-uncertainty"
  | "mention-relevant-context"
  | "omit-old-context";

export type ActionDecision = {
  route: DecisionRoute;
  proceed: boolean;
  askUser: boolean;
  reason: string;
  confidence: number;
  reversible: boolean;
  paidBlocked: boolean;
  strategy: ResponseStrategy;
  strategyDirective: string;
};

export function selectResponseStrategy(input: {
  text: string;
  intent: UnderstoodIntent;
  move?: string;
  ambiguous?: boolean;
  confidence?: number;
}): { strategy: ResponseStrategy; reason: string; directive: string } {
  const text = String(input.text || "");
  const move = input.move || input.intent.conversationalMove || "";
  const session = getConversationSession();
  const mood = (() => {
    try {
      return affect.getSnapshot();
    } catch {
      return null;
    }
  })();
  const frustrated = (mood?.user.frustration ?? 0) >= 0.4 || session.correctionStreak >= 2;
  const low = (input.confidence ?? input.intent.understandingConfidence ?? 1) < 0.45;

  if (move === "correction" || input.intent.kind === "correction") {
    return {
      strategy: "acknowledge-correction",
      reason: "owner corrected FRIDAY — incorporate, do not defend",
      directive:
        "The owner just corrected you. Acknowledge once, incorporate the correction, and do not repeat the discarded answer. Stay concise.",
    };
  }
  if (move === "task-pause") {
    return {
      strategy: "defer",
      reason: "owner paused this thread — keep it for later",
      directive:
        "Pause the current thread or task. Do not forget it. Do not start unrelated work unless they asked.",
    };
  }
  if (move === "task-complete") {
    return {
      strategy: "summarize-state",
      reason: "owner marked progress — state the next step",
      directive:
        "Note the completed part. Name the next remaining step from current task state. Do not invent finished work.",
    };
  }
  if (move === "task-resume" || move === "previous-conversation") {
    return {
      strategy: "continue-task",
      reason: "resume prior work from stored state",
      directive:
        "Continue from the latest stored project, decision, or paused thread. Do not invent a chat that cannot be retrieved.",
    };
  }
  if (move === "side-topic") {
    return {
      strategy: "omit-old-context",
      reason: "side topic — keep the paused thread",
      directive:
        "Answer this aside. Keep the previous thread paused. Do not merge unrelated topics.",
    };
  }
  if (input.intent.needsClarification || input.ambiguous || (low && move === "follow-up")) {
    return {
      strategy: "ask-clarification",
      reason: "referent or intent is ambiguous — ask rather than guess",
      directive: "Ask one short clarifying question. Do not invent the missing referent.",
    };
  }
  if (move === "disagreement") {
    return {
      strategy: "disagree-respectfully",
      reason: "owner disagrees — reassess instead of repeating",
      directive:
        "They disagree. Reassess the claim against current context. Do not get defensive or restated.",
    };
  }
  if (move === "research" || /\b(latest|right now|today'?s)\b/i.test(text)) {
    return {
      strategy: "research-first",
      reason: "needs a live check",
      directive:
        "Do not answer from training memory. Use live research or say you could not check.",
    };
  }
  if (isConsequential(text)) {
    return {
      strategy: "verify-first",
      reason: "consequential — existing governance still confirms",
      directive:
        "This can change the machine. Confirm through the existing approval path. Do not silently execute.",
    };
  }
  if (move === "execution-request" || move === "approval") {
    return {
      strategy: "execute-action",
      reason: "owner is approving or asking to carry out the active item",
      directive:
        "Carry out the currently selected option or goal, subject to existing governance. Do not start a new topic.",
    };
  }
  if (move === "continuation" || /^(continue|carry on|keep going)\b/i.test(text)) {
    return {
      strategy: "continue-task",
      reason: "continue the active thread",
      directive:
        "Continue the current task or decided option. Do not restart or recap unless asked.",
    };
  }
  if (move === "decision-support") {
    return {
      strategy: "recommend-one",
      reason: "owner asked what to do next",
      directive:
        "Recommend one next step from current context. Give a brief why. Do not dump options already rejected.",
    };
  }
  if (move === "brainstorming") {
    return {
      strategy: "provide-options",
      reason: "exploratory turn",
      directive: "Offer a few distinct options. Stay collaborative. Do not lock a decision.",
    };
  }
  if (move === "explanation-request" || session.styleCue === "detailed") {
    return {
      strategy: "explain",
      reason: "owner asked for an explanation",
      directive: "Explain clearly. If they asked for simple, keep substance and drop jargon.",
    };
  }
  if (frustrated || session.styleCue === "simple" || session.styleCue === "brief") {
    return {
      strategy: "answer-briefly",
      reason: "keep it short — frustration or a brevity cue",
      directive:
        "Lead with the answer. No preamble, no recap of the question, no extra explanation unless they ask.",
    };
  }
  if (move === "status-request") {
    return {
      strategy: "summarize-state",
      reason: "status ask",
      directive: "Summarize current goal, decision, and next step. Skip unrelated old context.",
    };
  }
  if ((input.intent.understandingConfidence ?? 1) < 0.6 && !input.intent.needsClarification) {
    return {
      strategy: "acknowledge-uncertainty",
      reason: "confidence is moderate",
      directive: "Give the best supported answer and say what is uncertain. Do not bluff.",
    };
  }
  if (session.previousTopics.length && session.activeTopic) {
    return {
      strategy: "omit-old-context",
      reason: "stay on the active thread",
      directive: "Use the active thread. Do not drag paused topics unless they referred to them.",
    };
  }
  return {
    strategy: "answer-directly",
    reason: "direct answer is enough",
    directive:
      "Answer the actual goal. Do not repeat the question, dump memory, mention models, or expose internal routing.",
  };
}

export function decideAction(input: {
  text: string;
  intent: UnderstoodIntent;
  handledByBaseline?: boolean;
}): ActionDecision {
  const text = input.text;
  const policy = currentPolicy();
  const confidence = estimateConfidence(text).score;
  const consequential = isConsequential(text);
  const reversible = !consequential;
  const paidBlocked = policy === "free-only";
  const mode = actionMode();
  const chosen = selectResponseStrategy({
    text,
    intent: input.intent,
    ...(input.intent.conversationalMove ? { move: input.intent.conversationalMove } : {}),
    ambiguous: input.intent.needsClarification,
    confidence: input.intent.understandingConfidence ?? confidence,
  });
  const withStrategy = (
    decision: Omit<ActionDecision, "strategy" | "strategyDirective">,
  ): ActionDecision => ({
    ...decision,
    strategy: chosen.strategy,
    strategyDirective: chosen.directive,
  });

  const understandingLow =
    input.intent.understandingConfidence !== undefined &&
    input.intent.understandingConfidence < 0.4;
  const missing = input.intent.missingInformation ?? [];
  if (input.intent.needsClarification || (understandingLow && missing.length > 0)) {
    return withStrategy({
      route: "ask",
      proceed: false,
      askUser: true,
      reason: input.intent.ask ?? "Need a clearer target before acting.",
      confidence: understandingLow
        ? Math.min(confidence, input.intent.understandingConfidence ?? confidence)
        : confidence,
      reversible: true,
      paidBlocked,
    });
  }

  try {
    const meta = reviewAssumptions({ text, intent: input.intent });
    if (meta.action === "ask" && meta.ask) {
      return withStrategy({
        route: "ask",
        proceed: false,
        askUser: true,
        reason: meta.ask,
        confidence,
        reversible: true,
        paidBlocked,
      });
    }
  } catch {
    /* meta-reasoning must never block a turn */
  }

  if (input.handledByBaseline) {
    return withStrategy({
      route: "baseline",
      proceed: true,
      askUser: false,
      reason: "FRIDAY can answer this without a model.",
      confidence: Math.max(confidence, 0.9),
      reversible: true,
      paidBlocked,
    });
  }

  if (consequential && (mode === "manual" || confidence < CONFIDENT_THRESHOLD)) {
    return withStrategy({
      route: "confirm",
      proceed: false,
      askUser: true,
      reason:
        confidence < CONFIDENT_THRESHOLD
          ? "This can change the machine and I'm not confident enough to guess — confirm first."
          : "Manual mode: confirm before I run this.",
      confidence,
      reversible,
      paidBlocked,
    });
  }

  if (input.intent.kind === "command") {
    return withStrategy({
      route: "tool",
      proceed: true,
      askUser: false,
      reason: "Direct command — use an existing tool/skill.",
      confidence,
      reversible,
      paidBlocked,
    });
  }

  return withStrategy({
    route: "model",
    proceed: true,
    askUser: false,
    reason: "Open-ended — specialist model after Core Brain cognition.",
    confidence,
    reversible,
    paidBlocked,
  });
}
