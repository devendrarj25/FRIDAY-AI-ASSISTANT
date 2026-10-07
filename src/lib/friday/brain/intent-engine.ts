/**
 * FRIDAY · intent engine (runtime)
 *
 * Understands what the owner wants before a model is contacted. Agent
 * selection still uses brain-catalog.analyseIntent — this module adds kind,
 * entities, follow-ups, corrections, urgency and when to ask instead of guess.
 *
 * `understandTurn` composes the existing context / memory / knowledge /
 * identity / affect signals into one normalized understanding. It is not a
 * second interpreter.
 */

import { analyseIntent } from "../brain-catalog";
import { turnDone, turnMark } from "./turn-timing";
import { resolveContext, type ChatTurn, type ResolvedContext } from "./context-engine";
import { ownerContextDigest } from "./identity";
import { userProfileDigest } from "./user-profile";
import { readPromptSignals } from "./affect";
import { memory } from "../self/memory-engine";
import { brainKnowledge } from "./knowledge-base";
import { retrievalTerms, termJaccard } from "./retrieval";
import {
  getConversationSession,
  isContinuingCurrentGoal,
  noteUserGoal,
} from "./conversation-state";

export type IntentKind =
  | "command"
  | "question"
  | "conversation"
  | "request"
  | "task"
  | "follow-up"
  | "correction"
  | "ambiguous";

export type ConversationalMove =
  | "literal-request"
  | "question"
  | "follow-up"
  | "correction"
  | "confirmation"
  | "disagreement"
  | "approval"
  | "rejection"
  | "clarification-request"
  | "brainstorming"
  | "decision-support"
  | "execution-request"
  | "explanation-request"
  | "emotional-support"
  | "status-request"
  | "continuation"
  | "task-pause"
  | "task-resume"
  | "task-complete"
  | "previous-conversation"
  | "side-topic"
  | "comparison"
  | "planning"
  | "troubleshooting"
  | "research"
  | "casual";

export type UnderstoodIntent = {
  kind: IntentKind;
  catalogId: string;
  catalogLabel: string;
  catalogScore: number;
  matched: string[];
  goals: string[];
  constraints: string[];
  entities: { paths: string[]; urls: string[]; apps: string[] };
  urgency: number;
  needsClarification: boolean;
  ask: string | null;
  text: string;
  conversationalMove?: ConversationalMove;
  underlyingGoal?: string;
  desiredOutcome?: string;
  expectedOutput?: string;
  successCriteria?: string[];
  scope?: string;
  timeReferences?: string[];
  dependencies?: string[];
  styleCue?: "simple" | "brief" | "detailed" | null;
  meanings?: {
    literal: string;
    conversationResolved: string;
    memoryInformed: string;
    ownerProjectInformed: string;
  };
  missingInformation?: string[];
  understandingConfidence?: number;
};

/** One-turn normalized understanding, composed from existing engines. */
export type TurnUnderstanding = {
  literal: string;
  conversationResolved: string;
  memoryInformed: string;
  ownerProjectInformed: string;
  resolvedIntent: UnderstoodIntent;
  resolvedGoal: string;
  missingInformation: string[];
  ambiguous: boolean;
  understandingConfidence: number;
  context: ResolvedContext;
  conversationalMove: ConversationalMove;
};

/** Compact shape stored on the existing decision trace. */
export type UnderstandingTrace = {
  literal: string;
  conversationResolved: string;
  resolvedGoal: string;
  ambiguous: boolean;
  missingInformation: string[];
  understandingConfidence: number;
  conversationalMove?: ConversationalMove;
};

export function toUnderstandingTrace(u: TurnUnderstanding): UnderstandingTrace {
  return {
    literal: u.literal,
    conversationResolved: u.conversationResolved.slice(0, 400),
    resolvedGoal: u.resolvedGoal,
    ambiguous: u.ambiguous,
    missingInformation: [...u.missingInformation],
    understandingConfidence: u.understandingConfidence,
    conversationalMove: u.conversationalMove,
  };
}

const FOLLOW_UP =
  /^(and |also |then |plus |\+ |what about |how about )|^\b(it|that|this|those|them)\b|\b(continue|carry on|keep going|same as (before|last time)|that one|the other one|do that again|same for|the (first|second|third|last) (one|thing)|uska|usko)\b/i;
const CORRECTION =
  /\b(no,? (i meant|not that)|actually|correction|i said|wait,? not|galat(?: hai)?|nahi woh|nahi,? wo nahi|wo nahi|ye galat|that'?s (wrong|not (right|correct))|that is wrong|jo pehle wala tha|purani baat thi|ab aisa karna)\b/i;

const CONFIRM = /^(got it|alright|theek hai|done|noted)[\s.!]*$/i;

/** Explicit user teaching — stronger than a casual Settings ask. */
export function looksLikeCorrection(text: string): boolean {
  return CORRECTION.test(String(text || ""));
}

export function conversationalMove(text: string): ConversationalMove {
  const t = String(text || "").trim();
  if (!t) return "casual";
  if (looksLikeCorrection(t)) return "correction";
  if (/\b(chhodo|isko pause(?: karo)?|baad mein continue karenge)\b/i.test(t)) return "task-pause";
  if (/\b(ye kar diya|ye wala part complete(?: ho gaya)?)\b/i.test(t)) return "task-complete";
  if (/\b(purani wali baat continue|previous conversation|kal wali baat continue)\b/i.test(t)) {
    return "previous-conversation";
  }
  if (
    /\b(us project ko continue|jahan chhoda tha|wapas .{0,48}par aao|continue that project)\b/i.test(
      t,
    )
  ) {
    return "task-resume";
  }
  if (/\bwaise ek (aur|alag) baat\b/i.test(t)) return "side-topic";
  if (/\b(i disagree|don't think so|galat approach|that's not right)\b/i.test(t))
    return "disagreement";
  if (/^(yes|yep|haan|ha|ok|okay|sure|do it|bas kar do|go ahead|approved|proceed)\b/i.test(t)) {
    return "approval";
  }
  if (/^(no|nahi|don't|cancel|stop that)\b/i.test(t)) return "rejection";
  if (/\b(which (one|option)|kya matlab|what do you mean|clarify)\b/i.test(t)) {
    return "clarification-request";
  }
  if (/\b(brainstorm|ideas|what if we|maybe we could)\b/i.test(t)) return "brainstorming";
  if (
    /\b(which should i|ab kya karna|ab next kya|recommend|better option|what should we do)\b/i.test(
      t,
    )
  ) {
    return "decision-support";
  }
  if (/\bisme ye bhi\b/i.test(t) || /\bachha isme\b/i.test(t)) return "continuation";
  if (/\b(implement|execute|bas kar do|kar do|ship it|apply (it|that))\b/i.test(t)) {
    return "execution-request";
  }
  if (/\b(explain|simple batao|why does|kaise kaam|in detail)\b/i.test(t))
    return "explanation-request";
  if (/\b(how are you|i'?m (tired|stressed|upset)|frustrated)\b/i.test(t))
    return "emotional-support";
  if (/\b(status|where are we|kahan tak|progress)\b/i.test(t)) return "status-request";
  if (
    FOLLOW_UP.test(t) ||
    /^(continue|carry on|keep going)\b/i.test(t) ||
    /\bisme ye bhi\b/i.test(t)
  ) {
    return "continuation";
  }
  if (/\b(compare|vs\.?|versus|difference between)\b/i.test(t)) return "comparison";
  if (/\b(plan|roadmap|break (it|this) down|steps to)\b/i.test(t)) return "planning";
  if (/\b(not working|broken|error|fix|stuck|crash)\b/i.test(t)) return "troubleshooting";
  if (/\b(search|look up|latest|research)\b/i.test(t)) return "research";
  if (QUESTION.test(t)) return "question";
  if (CONFIRM.test(t)) return "confirmation";
  if (t.length < 18) return "casual";
  return "literal-request";
}

const COMMAND =
  /^(please\s+)?(open|launch|start|run|close|stop|install|uninstall|delete|remember|forget|search|look up)\b/i;
const QUESTION = /^(who|what|when|where|why|how|is|are|can|does|do|kya|kaun)\b|\?\s*$/i;
const TASK =
  /\b(prepare|build|create|make|write|generate|research|report|plan|organise|organize)\b/i;
const CONSTRAINT = /\b(without|don't|do not|must not|only|except|after|before|unless)\b/i;
const URGENCY = /\b(urgent|asap|now|immediately|hurry|deadline|jaldi|abhi)\b/i;
const AMBIGUOUS =
  /^(it|that|this|do it|fix it|the thing|wo wala|which one|either|whatever)\s*[.!?]*$/i;

function entities(text: string) {
  return {
    paths: text.match(/(?:[a-zA-Z]:\\[^\s"']+|\.{0,2}\/[^\s"']+)/g) ?? [],
    urls: text.match(/https?:\/\/[^\s"']+/g) ?? [],
    apps: text.match(/\b[A-Za-z0-9_.-]+\.exe\b/gi) ?? [],
  };
}

/**
 * Split a multi-part request into ordered goals. Numbered lists and
 * then/also connectors only — a single clause stays one goal.
 */
export function splitGoals(text: string): string[] {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  const numbered = trimmed
    .split(/(?:^|\s)\d+[.)]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (numbered.length >= 2) {
    return numbered.map((part) => part.replace(/\s+/g, " ").slice(0, 200));
  }
  const parts = trimmed
    .split(/\s+(?:and then|then|after that|and also|; then)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
  if (parts.length >= 2) return parts.map((part) => part.slice(0, 200));
  return [trimmed.slice(0, 200)];
}

function kindOf(text: string): IntentKind {
  if (CORRECTION.test(text)) return "correction";
  if (FOLLOW_UP.test(text)) return "follow-up";
  if (AMBIGUOUS.test(text)) return "ambiguous";
  if (COMMAND.test(text)) return "command";
  if (TASK.test(text) && text.length > 40) return "task";
  if (QUESTION.test(text)) return "question";
  if (text.length < 24 && !QUESTION.test(text) && !COMMAND.test(text)) return "conversation";
  return "request";
}

/** Single entry: classify this turn. */
export function understand(text: string): UnderstoodIntent {
  turnMark("intent", "understand");
  const trimmed = String(text || "").trim();
  const catalog = analyseIntent(trimmed);
  const kind = kindOf(trimmed);
  const found = entities(trimmed);
  const goals = splitGoals(trimmed);
  const constraints = CONSTRAINT.test(trimmed) ? ["owner named a constraint — honour it"] : [];
  const urgency = URGENCY.test(trimmed) ? 0.85 : 0.2;
  const needsClarification = kind === "ambiguous" || (kind === "follow-up" && trimmed.length < 8);
  const result: UnderstoodIntent = {
    kind,
    catalogId: catalog.rule.id,
    catalogLabel: catalog.rule.label,
    catalogScore: catalog.score,
    matched: catalog.matched,
    goals,
    constraints,
    entities: found,
    urgency,
    needsClarification,
    ask: needsClarification
      ? "Which thing should I continue — the last task, or something else?"
      : null,
    text: trimmed,
    conversationalMove: conversationalMove(trimmed),
    timeReferences: TIME_REF.test(trimmed) ? [String(trimmed.match(TIME_REF)?.[0] ?? "")] : [],
    styleCue: /\b(thoda simple|simple batao|keep it simple)\b/i.test(trimmed)
      ? "simple"
      : /\b(in detail|explain fully)\b/i.test(trimmed)
        ? "detailed"
        : /\b(briefly|in short|be brief)\b/i.test(trimmed)
          ? "brief"
          : null,
  };
  turnDone("intent", "understand", result.kind);
  return result;
}

const TIME_REF =
  /\b(yesterday|today|tomorrow|kal|abhi|last (week|time)|earlier|pehle|baad mein)\b/i;

function inferUnderlyingGoal(
  literal: string,
  context: ResolvedContext,
): { goal: string; confidence: number } {
  const topic = context.topic || "";
  const decided = context.goal || "";
  if (/\b(better bana|improve|thoda better|polish|refine)\b/i.test(literal)) {
    if (/\b(ui|ux|design|layout|css|visual)\b/i.test(topic)) {
      return { goal: `improve the design of ${topic.slice(0, 80)}`, confidence: 0.82 };
    }
    if (/\b(word|copy|wording|text|sentence|prose)\b/i.test(topic)) {
      return { goal: `improve the wording of ${topic.slice(0, 80)}`, confidence: 0.82 };
    }
    if (/\b(perf|slow|speed|latency)\b/i.test(topic)) {
      return { goal: `improve performance of ${topic.slice(0, 80)}`, confidence: 0.82 };
    }
    if (/\b(logic|bug|function|code|algorithm)\b/i.test(topic)) {
      return { goal: `improve the logic of ${topic.slice(0, 80)}`, confidence: 0.82 };
    }
    const topicIsThisTurn =
      !topic || termJaccard(retrievalTerms(topic), retrievalTerms(literal)) >= 0.5;
    if (topicIsThisTurn) return { goal: literal.slice(0, 200), confidence: 0.34 };
    return { goal: `improve ${topic.slice(0, 100)}`, confidence: 0.7 };
  }
  if (/\bab kya karna chahiye|what should (i|we) do\b/i.test(literal)) {
    const target = decided || topic;
    if (target)
      return { goal: `recommend the next step for ${target.slice(0, 80)}`, confidence: 0.76 };
  }
  if (isContinuingCurrentGoal(literal) && decided) {
    return { goal: decided.slice(0, 200), confidence: Math.max(context.confidence, 0.7) };
  }
  return { goal: literal.slice(0, 200), confidence: context.confidence || 0.6 };
}

function memoryInformedMeaning(resolved: string, topic: string | null, literal: string): string {
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|good)[\s.!]*$/i.test(literal)) {
    return resolved;
  }
  try {
    const hits = memory.search(resolved, { k: 4, context: topic || resolved });
    const terms = retrievalTerms(`${resolved} ${topic || ""}`);
    const relevant = hits.filter((hit) => {
      const hay = retrievalTerms(`${hit.title} ${hit.text}`);
      const score = termJaccard(hay, terms);
      if (hit.tier === "temporary") return score >= 0.18;
      if (hit.kind === "decision" || hit.kind === "preference" || hit.tags.includes("correction")) {
        return score >= 0.08;
      }
      return score >= 0.12;
    });
    if (!relevant.length) return resolved;
    const note = relevant
      .slice(0, 2)
      .map((hit) => `${hit.title}: ${hit.text.slice(0, 80)}`)
      .join("; ");
    return `${resolved} [memory: ${note}]`;
  } catch {
    return resolved;
  }
}

const OWNERSHIP_ASK =
  /\b(who owns|who (made|created|built)|publisher|copyright|who is (the )?owner)\b/i;

function ownerProjectMeaning(memoryInformed: string, resolved: string): string {
  const digest = ownerContextDigest();
  const user = userProfileDigest();
  let project: string;
  try {
    const recalled = brainKnowledge.recall(resolved, { k: 3 });
    project = recalled.find((entry) => entry.kind === "project")?.title ?? "";
  } catch {
    project = "";
  }
  const ownership = OWNERSHIP_ASK.test(resolved) || OWNERSHIP_ASK.test(memoryInformed);
  const customized =
    Boolean(user.preferredName) ||
    Boolean(user.occupation) ||
    Boolean(user.location) ||
    Boolean(user.about) ||
    Boolean(user.notes) ||
    user.addressAs !== "sir" ||
    user.useNameInAddress;
  const bits = [
    ownership && digest.owner ? `publisher: ${digest.owner}` : "",
    customized && user.preferredName ? `helping: ${user.preferredName}` : "",
    customized && user.honorific ? `address: ${user.honorific}` : "",
    project
      ? `project: ${project}`
      : digest.instructions
        ? `standing: ${digest.instructions.slice(0, 80)}`
        : "",
  ].filter(Boolean);
  return bits.length ? `${memoryInformed} [${bits.join("; ")}]` : memoryInformed;
}

/**
 * Compose literal, conversation-resolved, memory-informed and owner/project
 * meanings for one turn. Clarifying still uses `understand().needsClarification`
 * + `decideAction` route `"ask"` — this does not invent a second ask path.
 */
export function understandTurn(input: { text: string; history?: ChatTurn[] }): TurnUnderstanding {
  turnMark("intent", "understandTurn");
  const literal = String(input.text || "").trim();
  const context = resolveContext(literal, input.history ?? []);
  const conversationResolved = context.resolved || literal;
  const resolvedIntent = understand(conversationResolved);
  const move = conversationalMove(literal);
  resolvedIntent.conversationalMove = move;
  const inferred = inferUnderlyingGoal(literal, context);
  resolvedIntent.underlyingGoal = inferred.goal;
  resolvedIntent.desiredOutcome = inferred.goal;
  if (inferred.confidence >= 0.6) noteUserGoal(inferred.goal);

  const memoryInformed = memoryInformedMeaning(conversationResolved, context.topic, literal);
  const ownerProjectInformed = ownerProjectMeaning(memoryInformed, conversationResolved);
  const signals = readPromptSignals(literal);
  const missingInformation: string[] = [];

  const resolvedReferent =
    context.references.length > 0 && !context.ambiguous && context.confidence >= 0.55;
  if (resolvedReferent) {
    resolvedIntent.needsClarification = false;
    resolvedIntent.ask = null;
  }
  if (context.ambiguous || (inferred.confidence < 0.4 && /better bana|improve/i.test(literal))) {
    resolvedIntent.needsClarification = true;
    resolvedIntent.ask =
      context.selectedContext.length > 1
        ? "Which of those should I use — I can see more than one match."
        : (resolvedIntent.ask ??
          "Which thing should I continue — the last task, or something else?");
  }

  if (resolvedIntent.needsClarification) missingInformation.push("referent");
  if (resolvedIntent.kind === "ambiguous" && !resolvedReferent) missingInformation.push("intent");
  if (signals.confusion) missingInformation.push("user-confusion");

  const ambiguous =
    resolvedIntent.needsClarification ||
    (resolvedIntent.kind === "ambiguous" && !resolvedReferent) ||
    context.ambiguous;
  let understandingConfidence = inferred.confidence || 0.88;
  if (ambiguous) understandingConfidence = Math.min(understandingConfidence, 0.32);
  else if (context.references.length) {
    understandingConfidence = Math.max(understandingConfidence, context.confidence);
  }
  if (signals.confusion) understandingConfidence = Math.min(understandingConfidence, 0.5);
  if (move === "follow-up" && !context.topic) {
    understandingConfidence = Math.min(understandingConfidence, 0.4);
  }

  const session = getConversationSession();
  const resolvedGoal =
    inferred.goal ||
    session.userGoal ||
    resolvedIntent.goals[0] ||
    conversationResolved.slice(0, 200);
  resolvedIntent.meanings = {
    literal,
    conversationResolved,
    memoryInformed,
    ownerProjectInformed,
  };
  resolvedIntent.missingInformation = missingInformation;
  resolvedIntent.understandingConfidence = understandingConfidence;

  const result: TurnUnderstanding = {
    literal,
    conversationResolved,
    memoryInformed,
    ownerProjectInformed,
    resolvedIntent,
    resolvedGoal,
    missingInformation,
    ambiguous,
    understandingConfidence,
    context,
    conversationalMove: move,
  };
  turnDone("intent", "understandTurn", ambiguous ? "ambiguous" : resolvedIntent.kind);
  return result;
}
