/**
 * FRIDAY · context engine
 *
 * Reconstructs the useful context for this turn: topic, thread, decisions,
 * unresolved questions, and referenced entities. Recency is a signal, not
 * the definition of importance. Session topic, options and open loops live
 * in conversation-state.ts (short-lived; the memory fabric remains durable).
 */

import { turnDone, turnMark } from "./turn-timing";
import { retrievalTerms, termJaccard } from "./retrieval";
import {
  boundTaskCue,
  extractPresentedOptions,
  getConversationSession,
  hydrateLiveConversation,
  lastDecision,
  looksLikeChangeAsk,
  looksLikeDecisionAsk,
  looksLikeNextStepAsk,
  noteCorrection,
  noteUserGoal,
  noteUserTurn,
  observeConversation,
  selectPresentedOption,
  sessionWritesEnabled,
  setInterpretationConfidence,
} from "./conversation-state";
import { resolveSessionReferences } from "./reference-resolver";
import { observeOpenLoops, listOpenLoops, resolveOpenLoop } from "./open-loops";
import { topicShift } from "./topic-state";

export type ChatTurn = { role: "user" | "assistant" | "friday" | string; text: string };

export type ResolvedContext = {
  original: string;
  resolved: string;
  references: string[];
  ongoing: boolean;
  topic: string | null;
  goal: string | null;
  selectedContext: string[];
  confidence: number;
  ambiguous: boolean;
};

const REF =
  /\b(it|that|this|those|them|these|the same|same as before|continue( this)?|keep going|carry on|usko|uska|wo|ye|woh|isko|usi|isi|the other one|that one|same one|same thing|previous one|last task|previous project)\b/i;
const WHAT_ABOUT = /^(what|how) about\b/i;
const SAME_FOR = /\bsame (for|with)\b/i;
const ORDINAL = /\bthe (first|second|third|last)(?:\s+(one|thing|item|option))?\b/i;
const CORRECTION =
  /\b(no,? (i meant|not that)|actually|correction|galat(?: hai)?|nahi,? wo nahi|ye galat|that's (wrong|not (right|correct)))\b/i;

const ORDINAL_INDEX: Record<string, number> = { first: 0, second: 1, third: 2, last: -1 };

function lastOf(history: ChatTurn[], role: ChatTurn["role"]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn && turn.role === role && turn.text.trim()) return turn.text.trim();
  }
  return null;
}

export function conversationOngoing(history: ChatTurn[]): boolean {
  const users = history.filter((t) => t.role === "user").length;
  return users >= 1;
}

function scoreTurn(query: string, turn: ChatTurn, topic: string): number {
  const text = turn.text;
  const lexical = termJaccard(retrievalTerms(query), retrievalTerms(text));
  const topicHit = topic ? termJaccard(retrievalTerms(topic), retrievalTerms(text)) : 0;
  const assistant = turn.role === "assistant" || turn.role === "friday" ? 0.05 : 0;
  return lexical * 0.7 + topicHit * 0.25 + assistant;
}

/** Pick the history turns that still matter — not merely the last few lines. */
export function selectRelevantTurns(
  query: string,
  history: ChatTurn[],
  topic: string | null,
  k = 4,
): string[] {
  if (!history.length) return [];
  const ranked = history
    .map((turn, index) => ({
      turn,
      index,
      score: scoreTurn(query, turn, topic || "") + index * 0.01,
    }))
    .filter((row) => row.turn.text.trim().length > 0)
    .sort((a, b) => b.score - a.score);
  const picked = ranked
    .filter((row) => row.score >= 0.08)
    .slice(0, k)
    .sort((a, b) => a.index - b.index);
  return picked.map((row) => `${row.turn.role}: ${row.turn.text.trim().slice(0, 180)}`);
}

/** Expand a short/referential prompt using session + ranked history, not last-line guesswork. */
export function resolveContext(
  text: string,
  history: ChatTurn[] = [],
  options: { observe?: boolean } = {},
): ResolvedContext {
  turnMark("context", "resolve");
  const original = String(text || "").trim();
  const observe = options.observe !== false && sessionWritesEnabled();
  if (observe) {
    hydrateLiveConversation();
    observeConversation(history);
    observeOpenLoops(history);
    noteUserTurn(original);
    if (CORRECTION.test(original) || looksLikeChangeAsk(original)) noteCorrection(original);
  }
  if (observe && /\b(ye kar diya|ye wala part complete(?: ho gaya)?)\b/i.test(original)) {
    const topic = getConversationSession().activeTopic;
    if (topic) {
      for (const loop of listOpenLoops()) {
        if (termJaccard(retrievalTerms(loop.text), retrievalTerms(topic)) >= 0.25) {
          resolveOpenLoop(loop.id);
        }
      }
    }
  }

  const lastUser = lastOf(history, "user");
  const lastAssistant = lastOf(history, "assistant") || lastOf(history, "friday");
  const session = getConversationSession();
  const decision = lastDecision();
  const topic = session.activeTopic || lastUser || lastAssistant;
  const ongoing = conversationOngoing(history) || Boolean(session.activeTopic);
  const references: string[] = [];
  let resolved = original;
  let confidence = 0.7;
  let ambiguous = false;

  const sessionRef = resolveSessionReferences(original, history);
  if (sessionRef.kind === "option") {
    references.push("option");
    if (ORDINAL.test(original)) references.push("ordinal");
    resolved = sessionRef.resolved;
    confidence = sessionRef.confidence;
    ambiguous = sessionRef.ambiguous;
  } else if (sessionRef.kind === "yesterday") {
    references.push("prior-talk");
    resolved = sessionRef.resolved;
    confidence = sessionRef.confidence;
    ambiguous = sessionRef.ambiguous;
  } else if (sessionRef.kind !== "none") {
    references.push(sessionRef.kind);
    resolved = sessionRef.resolved;
    confidence = sessionRef.confidence;
    ambiguous = sessionRef.ambiguous;
  }

  if (looksLikeChangeAsk(original)) {
    references.push("change");
    if (sessionRef.ambiguous) {
      ambiguous = true;
      confidence = Math.min(sessionRef.confidence, 0.45);
      resolved = `${original}\n(${sessionRef.resolved} Ask which item they mean.)`;
    } else {
      const bound =
        decision?.selected ||
        lastAssistant ||
        session.userGoal ||
        topic ||
        (sessionRef.kind !== "none" ? sessionRef.resolved : "");
      if (bound) {
        resolved = `Change the current item. Do not start a new topic. Current item: "${String(bound).slice(0, 200)}". ${original}`;
        confidence = decision || sessionRef.kind !== "none" ? 0.84 : 0.74;
        ambiguous = false;
      } else {
        ambiguous = true;
        confidence = 0.35;
        resolved = `${original}\n(Nothing is stored to change. Ask which item they mean.)`;
      }
    }
  } else if (looksLikeDecisionAsk(original) && sessionRef.kind === "none") {
    references.push("decision");
    if (decision) {
      resolved = `The decision still in effect is "${decision.selected.slice(0, 200)}". ${decision.summary}`;
      confidence = 0.88;
    } else if (topic || lastAssistant || lastUser) {
      const stated = lastAssistant || lastUser || topic;
      resolved = `${original}\n(Use the decision already stated in this conversation: "${String(stated).slice(0, 200)}". Do not invent a new one.)`;
      confidence = 0.7;
    } else {
      ambiguous = true;
      confidence = 0.35;
      resolved = `${original}\n(No decision is stored for this conversation. Ask which decision they mean.)`;
    }
  } else if (looksLikeNextStepAsk(original) && sessionRef.kind === "none") {
    const cue = boundTaskCue();
    references.push("next-step");
    if (cue || topic) {
      resolved = `Continue only the unfinished step. ${cue || `Current topic: ${String(topic).slice(0, 200)}`}. ${original}`;
      confidence = cue ? 0.84 : 0.62;
    } else {
      ambiguous = true;
      confidence = 0.35;
      resolved = `${original}\n(No unfinished step is stored. Ask which task they mean.)`;
    }
  } else if (original && REF.test(original) && topic && sessionRef.kind === "none") {
    const target = decision?.selected || session.userGoal || topic;
    references.push("anaphora");
    resolved = `${original}\n(Context: previous request was "${target.slice(0, 240)}")`;
    confidence = decision ? 0.8 : 0.64;
  }
  if (/^(continue|keep going|carry on)\b/i.test(original) && topic && sessionRef.kind === "none") {
    references.push("continue");
    resolved = `Continue this work: ${decision?.selected || session.userGoal || topic}`;
    confidence = 0.74;
  }
  if (WHAT_ABOUT.test(original) && topic) {
    references.push("topic-shift");
    if (observe) topicShift(topic, original);
    resolved = `${original}\n(Context: previous request was "${topic.slice(0, 240)}")`;
  }
  if (SAME_FOR.test(original) && topic) {
    references.push("same-for");
    resolved = `${original}\n(Context: apply the same approach as "${topic.slice(0, 240)}")`;
  }
  const ordinal = ORDINAL.exec(original);
  if (ordinal && lastAssistant && sessionRef.kind === "none") {
    const items = extractPresentedOptions(lastAssistant);
    const key = String(ordinal[1] || "").toLowerCase();
    const index = key === "last" ? items.length : (ORDINAL_INDEX[key] ?? -1) + 1;
    const picked = index > 0 ? items.find((item) => item.index === index) : undefined;
    if (picked) {
      if (observe) selectPresentedOption(picked.index);
      references.push("ordinal");
      resolved = `${original}\n(Context: that item is "${picked.text.slice(0, 240)}")`;
      confidence = 0.9;
    }
  }

  const selectedContext = selectRelevantTurns(resolved, history, topic, 4);
  const open = (() => {
    try {
      return listOpenLoops()
        .slice(0, 2)
        .map((item) => item.text);
    } catch {
      return [];
    }
  })();
  if (open.length && !ambiguous) {
    selectedContext.push(`unresolved: ${open.join(" | ")}`);
  }
  if (decision && !selectedContext.some((line) => line.includes(decision.selected.slice(0, 40)))) {
    selectedContext.push(`decision: ${decision.selected.slice(0, 160)}`);
  }

  const goal = session.userGoal || (decision ? `carry out ${decision.selected}` : topic);
  if (observe && goal && original.length > 12 && !session.userGoal) {
    noteUserGoal(goal);
  }
  if (observe) setInterpretationConfidence(ambiguous ? Math.min(confidence, 0.45) : confidence);

  const result: ResolvedContext = {
    original,
    resolved,
    references,
    ongoing,
    topic: topic ? topic.slice(0, 240) : null,
    goal: goal ? String(goal).slice(0, 240) : null,
    selectedContext: selectedContext.slice(0, 6),
    confidence,
    ambiguous,
  };
  turnDone("context", "resolve", result.references.join(",") || "none");
  return result;
}

export type ContextRole =
  | "fact"
  | "observation"
  | "goal"
  | "memory"
  | "belief"
  | "constraint"
  | "failure"
  | "capability"
  | "safety";

export type ContextDraft = {
  id: string;
  role: ContextRole;
  text: string;
  source: string;
  at: string;
  confidence: number;
  stale?: boolean;
  conflict?: boolean;
};

export type CompiledContextItem = ContextDraft & {
  salience: number;
  reason: string;
  estimate: number;
};

export type CompiledContext = {
  included: CompiledContextItem[];
  dropped: { id: string; reason: string }[];
  budget: number;
  used: number;
  conflicts: string[];
};

const ROLE_WEIGHT: Record<ContextRole, number> = {
  safety: 1,
  constraint: 0.95,
  goal: 0.92,
  belief: 0.86,
  failure: 0.82,
  observation: 0.74,
  fact: 0.68,
  memory: 0.56,
  capability: 0.42,
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Character budget for one model view. This desk has no tokenizer here. */
export function contextBudgetFor(depth: "fast" | "deliberative" | "metacognitive"): number {
  if (depth === "metacognitive") return 4200;
  if (depth === "deliberative") return 2800;
  return 900;
}

/**
 * Self-RAG style packet: keep what earns its place, drop stale low-value
 * lines, and always leave a contradiction visible. Estimates are characters.
 */
export function compileContextPacket(drafts: ContextDraft[], budget: number): CompiledContext {
  const cap = Math.max(0, budget);
  const ranked = drafts
    .map((draft) => {
      const text = draft.text.trim().slice(0, 500);
      const confidence = clampUnit(draft.confidence);
      const stale = Boolean(draft.stale);
      const conflict = Boolean(draft.conflict);
      let salience = confidence * ROLE_WEIGHT[draft.role] * (stale ? 0.35 : 1);
      if (conflict) salience = Math.min(1, salience + 0.25);
      if (draft.role === "safety") salience = Math.max(salience, 0.9);
      return {
        ...draft,
        text,
        confidence,
        stale,
        conflict,
        salience,
        estimate: text.length,
      };
    })
    .filter((row) => row.text.length > 0)
    .sort((a, b) => b.salience - a.salience || a.estimate - b.estimate);

  const included: CompiledContextItem[] = [];
  const dropped: { id: string; reason: string }[] = [];
  const conflicts: string[] = [];
  let used = 0;

  const consider = (row: (typeof ranked)[number], forced: boolean) => {
    const duplicate = included.find(
      (kept) => termJaccard(retrievalTerms(kept.text), retrievalTerms(row.text)) >= 0.72,
    );
    if (duplicate && !row.conflict) {
      dropped.push({ id: row.id, reason: `redundant with ${duplicate.id}` });
      return;
    }
    if (!forced && row.stale && row.salience < 0.25) {
      dropped.push({ id: row.id, reason: "stale and low salience" });
      return;
    }
    if (!forced && used + row.estimate > cap) {
      dropped.push({ id: row.id, reason: "over the context budget" });
      return;
    }
    let reason = `salience ${row.salience.toFixed(2)}`;
    if (row.conflict) reason = "contradiction stays visible";
    else if (row.role === "safety") reason = "safety constraint stays in view";
    else if (row.stale) reason = "stale, kept because salience still earns the budget";
    included.push({ ...row, reason });
    used += row.estimate;
    if (row.conflict) conflicts.push(row.id);
  };

  for (const row of ranked.filter((item) => item.conflict || item.role === "safety")) {
    consider(row, true);
  }
  for (const row of ranked.filter((item) => !item.conflict && item.role !== "safety")) {
    consider(row, false);
  }

  return { included, dropped, budget: cap, used, conflicts };
}
