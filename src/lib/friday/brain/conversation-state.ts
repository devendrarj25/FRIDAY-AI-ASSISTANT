/**
 * FRIDAY · conversation session state
 *
 * Short-lived tracking for the current talk: topic, threads, options,
 * decisions, open loops, ephemeral facts. This is not a second memory store.
 * Durable recall stays on `self/memory-engine.ts`. A session fact may be
 * promoted through the existing consolidation pipeline when the owner
 * actually decides something.
 *
 * Layers (local-first CST / MemoryOS-style, without a second database):
 *   ephemeral  — this-turn facts, decay in minutes
 *   session    — this talk's threads / decisions / goals
 *   durable    — memory fabric only, never duplicated here
 * Compact current-state is a derived view (plus one working/project memory
 * row). A new chat starts clean; "continue that project" retrieves memory.
 */

import { writeState, readLocalState } from "../persist";
import { consolidateEvent } from "../self/memory-consolidate";
import { memory } from "../self/memory-engine";
import { continuityKey } from "../self/run-receipt";
import { graphProgress, taskGraph } from "../self/task-graph";
import { retrievalTerms, termJaccard } from "./retrieval";

export type SessionTurn = { role: string; text: string };

export type OptionStatus = "presented" | "selected" | "rejected";

export type PresentedOption = {
  index: number;
  text: string;
  status: OptionStatus;
};

export type SessionDecision = {
  id: string;
  summary: string;
  selected: string;
  rejected: string[];
  at: number;
};

export type ConversationPhase =
  "opening" | "exploring" | "deciding" | "executing" | "repairing" | "closing";

export type TopicTransition = {
  from: string;
  to: string;
  at: number;
  cue: string;
};

export type ConversationThread = {
  id: string;
  topic: string;
  at: number;
  status: "active" | "paused" | "resolved";
};

export type SessionFactKind =
  "ephemeral" | "session" | "commitment" | "assumption" | "correction" | "preference";

export type SessionFact = {
  id: string;
  text: string;
  kind: SessionFactKind;
  at: number;
  expiresAt: number;
};

export type StyleCue = "simple" | "brief" | "detailed" | null;

export type ConversationSession = {
  id: string;
  startedAt: number;
  updatedAt: number;
  activeTopic: string;
  subtopics: string[];
  previousTopics: string[];
  topicTransitions: TopicTransition[];
  threads: ConversationThread[];
  activeThreadId: string;
  presentedOptions: PresentedOption[];
  decisions: SessionDecision[];
  pendingDecisions: string[];
  commitments: string[];
  corrections: string[];
  assumptions: string[];
  facts: SessionFact[];
  userGoal: string;
  desiredOutcome: string;
  constraints: string[];
  preferences: string[];
  phase: ConversationPhase;
  interpretationConfidence: number;
  correctionStreak: number;
  styleCue: StyleCue;
  /** Bound task-graph id for this talk — not a second task store. */
  activeGraphId: string;
  lastMeaningfulChange: number;
};

const EPHEMERAL_MS = 30 * 60 * 1000;
const SESSION_FACT_MS = 4 * 60 * 60 * 1000;
const MAX_THREADS = 6;
const MAX_FACTS = 12;
const MAX_TRANSITIONS = 12;
const SITUATION_TITLE = "Continuity — current situation";
const SNAP_KEY = "friday.conversation.v1";

type CompactSnap = {
  topic: string;
  goal: string;
  threadId: string;
  graphId: string;
  at: number;
};

let session = emptySession();
let seq = 0;

function emptySession(): ConversationSession {
  return {
    id: "session-boot",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    activeTopic: "",
    subtopics: [],
    previousTopics: [],
    topicTransitions: [],
    threads: [],
    activeThreadId: "",
    presentedOptions: [],
    decisions: [],
    pendingDecisions: [],
    commitments: [],
    corrections: [],
    assumptions: [],
    facts: [],
    userGoal: "",
    desiredOutcome: "",
    constraints: [],
    preferences: [],
    phase: "opening",
    interpretationConfidence: 0.5,
    correctionStreak: 0,
    styleCue: null,
    activeGraphId: "",
    lastMeaningfulChange: Date.now(),
  };
}

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function touch(): void {
  session.updatedAt = Date.now();
}

function overlap(a: string, b: string): number {
  return termJaccard(retrievalTerms(a), retrievalTerms(b));
}

/** Numbered or bullet lines from an assistant turn — 1-based indexes. */
export function extractPresentedOptions(text: string): PresentedOption[] {
  const options: PresentedOption[] = [];
  let bullets = 0;
  for (const raw of String(text || "").split(/\n+/)) {
    const line = raw.trim();
    const numbered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (numbered) {
      const index = Number(numbered[1]);
      const body = String(numbered[2] || "").trim();
      if (index > 0 && body) options.push({ index, text: body, status: "presented" });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const body = line.replace(/^[-*]\s+/, "").trim();
      if (!body) continue;
      bullets += 1;
      options.push({ index: bullets, text: body, status: "presented" });
    }
  }
  return options;
}

function lastAssistantText(history: SessionTurn[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (!turn) continue;
    if ((turn.role === "assistant" || turn.role === "friday") && turn.text.trim()) {
      return turn.text.trim();
    }
  }
  return "";
}

function lastUserText(history: SessionTurn[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn && turn.role === "user" && turn.text.trim()) return turn.text.trim();
  }
  return "";
}

/** "remember that X" uses complementizer *that*, not a referent. */
const COMPLEMENTIZER_THAT = /\b(remember|note|know|say|think|mean|ensure|forget|tell me) that\b/gi;

function referentSurface(text: string): string {
  return String(text || "").replace(COMPLEMENTIZER_THAT, " ");
}

function looksLikeReferenceOnly(text: string): boolean {
  return (
    text.length < 80 &&
    /\b(option|choice|it|that|this|these|those|same|continue|carry on|kal|yesterday|wahi|dusra|doosra|pehla|pehle|uska|usko|uski|isko|iske|ispe|revert|go back|the (first|second|third|last)|previous one|bas kar)\b/i.test(
      referentSurface(text),
    )
  );
}

function looksLikeSubtopicShift(text: string): boolean {
  return /^(what|how) about\b|\bsame (for|with)\b|\bwaise ek (aur|alag) baat\b/i.test(text);
}

function looksLikeFollowUpWork(text: string): boolean {
  return (
    text.length < 80 &&
    (/\b(better bana|thoda better|improve|polish|refine|implement|continue|simple batao|fix it|kar do|isme ye bhi|achha isme|ab next kya|next kya(?: karna)?|original (?:task|baat)|pehle wali baat|kya pending)\b/i.test(
      text,
    ) ||
      /^(ab|next|pending)\??$/i.test(text))
  );
}

function looksLikePauseWork(text: string): boolean {
  return (
    /\b(chhodo|isko pause(?: karo)?|pause (?:this|it)|baad mein continue(?: karenge)?|isko baad mein)\b/i.test(
      text,
    ) || /^(pause this|pause it)[\s.!]*$/i.test(text)
  );
}

function looksLikeCompleteWork(text: string): boolean {
  return /\b(ye kar diya|ye wala part complete(?: ho gaya)?|(?:that|this) part(?: is)? (?:done|complete))\b/i.test(
    text,
  );
}

/** Resume work from a previous chat — not a same-session "continue". */
export function looksLikeContinueAcrossChats(text: string): boolean {
  return /\b(us project ko continue|continue that project|jahan chhoda tha|purani wali baat continue|jo hum kar rahe the|wapas .{0,48}par aao|previous project|last task|jo decision (humne )?liya tha)\b/i.test(
    text,
  );
}

function markMeaningful(): void {
  session.lastMeaningfulChange = Date.now();
}

/** True when this utterance continues the current goal rather than replacing it. */
export function isContinuingCurrentGoal(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  return looksLikeReferenceOnly(value) || looksLikeFollowUpWork(value);
}

function looksLikeClosing(text: string): boolean {
  return /^(thanks|thank you|ok|okay|bye|that's all|bas ho gaya|shukriya)[\s.!]*$/i.test(text);
}

function ensureActiveThread(topic: string): void {
  const label = topic.slice(0, 240);
  if (!label) return;
  const existing = session.threads.find((item) => item.status === "active");
  if (existing) {
    existing.topic = label;
    session.activeThreadId = existing.id;
    return;
  }
  const paused = session.threads.find(
    (item) => item.status === "paused" && overlap(item.topic, label) >= 0.45,
  );
  if (paused) {
    paused.status = "active";
    paused.topic = label;
    session.activeThreadId = paused.id;
    return;
  }
  const thread: ConversationThread = {
    id: nextId("thread"),
    topic: label,
    at: Date.now(),
    status: "active",
  };
  session.threads = [...session.threads, thread].slice(-MAX_THREADS);
  session.activeThreadId = thread.id;
}

function pauseActiveThread(): void {
  session.threads = session.threads.map((item) =>
    item.status === "active" ? { ...item, status: "paused" as const } : item,
  );
}

/** Drop expired ephemeral facts and trim session-only lists. Not a memory GC. */
export function decayConversationState(now = Date.now()): ConversationSession {
  session.facts = session.facts.filter((fact) => fact.expiresAt > now).slice(-MAX_FACTS);
  session.topicTransitions = session.topicTransitions.slice(-MAX_TRANSITIONS);
  session.threads = session.threads.slice(-MAX_THREADS);
  session.previousTopics = session.previousTopics.slice(-8);
  session.corrections = session.corrections.slice(-8);
  session.commitments = session.commitments.slice(-8);
  session.assumptions = session.assumptions.slice(-8);
  session.constraints = session.constraints.slice(-8);
  session.preferences = session.preferences.slice(-8);
  session.decisions = session.decisions.slice(-20);
  if (session.styleCue && now - session.updatedAt > EPHEMERAL_MS) session.styleCue = null;
  return session;
}

function derivePhase(text: string): ConversationPhase {
  if (session.correctionStreak > 0) return "repairing";
  if (looksLikeClosing(text)) return "closing";
  if (
    session.presentedOptions.some((item) => item.status === "selected") ||
    session.decisions.length
  ) {
    return "executing";
  }
  if (session.presentedOptions.some((item) => item.status === "presented")) return "deciding";
  if (session.activeTopic) return "exploring";
  return "opening";
}

/** Rebuild option lists from history; keep decisions. Empty history does not wipe. */
export function observeConversation(history: SessionTurn[] = []): ConversationSession {
  decayConversationState();
  if (!history.length) return session;
  const assistant = lastAssistantText(history);
  const listed = assistant ? extractPresentedOptions(assistant) : [];
  if (listed.length) {
    session.presentedOptions = listed;
    session.pendingDecisions = listed.map((item) => item.text);
  }
  const priorUser = lastUserText(history);
  if (priorUser && !looksLikeReferenceOnly(priorUser) && priorUser.length >= 8) {
    if (!session.activeTopic) {
      session.activeTopic = priorUser.slice(0, 240);
      ensureActiveThread(session.activeTopic);
    }
  }
  session.id = session.id === "session-boot" ? nextId("session") : session.id;
  session.phase = derivePhase(priorUser);
  touch();
  return session;
}

export function bindActiveGraph(id: string | null | undefined): void {
  const value = String(id || "").trim();
  if (!value) return;
  session.activeGraphId = value;
  markMeaningful();
  touch();
}

function pauseBoundGraph(): void {
  const id = session.activeGraphId;
  if (!id) return;
  try {
    const graph = taskGraph.get(id);
    if (
      graph &&
      (graph.state === "queued" || graph.state === "running" || graph.state === "paused")
    ) {
      taskGraph.pause(id);
    }
  } catch {
    /* task graph is optional in unit tests without runners */
  }
}

function resumeBoundOrMatchingGraph(cue: string): void {
  try {
    if (session.activeGraphId) {
      const bound = taskGraph.get(session.activeGraphId);
      if (bound?.state === "paused") {
        taskGraph.resume(bound.id);
        return;
      }
    }
    const topic = session.activeTopic || cue;
    const paused = taskGraph
      .list()
      .filter((graph) => graph.state === "paused" && graph.priority === "owner")
      .map((graph) => ({ graph, score: overlap(graph.request, topic) }))
      .sort((a, b) => b.score - a.score);
    const top = paused[0];
    if (top && top.score >= 0.3) {
      session.activeGraphId = top.graph.id;
      taskGraph.resume(top.graph.id);
    }
  } catch {
    /* optional */
  }
}

function liveItem(item: { title: string; text: string; context?: string }): {
  title: string;
  text: string;
  context?: string;
} {
  return item.context
    ? { title: item.title, text: item.text, context: item.context }
    : { title: item.title, text: item.text };
}

function liveSituationMemory(
  query: string,
): { title: string; text: string; context?: string } | null {
  try {
    const named = memory
      .search(query, { k: 8 })
      .filter(
        (item) =>
          item.tier !== "archived" &&
          !item.supersededAt &&
          item.source !== "first-run" &&
          (item.kind === "project" || item.kind === "decision" || item.title === SITUATION_TITLE),
      )
      .map((item) => ({
        item,
        score: overlap(`${item.title} ${item.context || ""} ${item.text}`, query),
      }))
      .sort((a, b) => b.score - a.score);
    const namedHit = named[0];
    if (namedHit && namedHit.score >= 0.12 && namedHit.item.title !== SITUATION_TITLE) {
      return liveItem(namedHit.item);
    }
    const sit = memory
      .getSnapshot()
      .items.find(
        (item) => item.title === SITUATION_TITLE && item.tier !== "archived" && !item.supersededAt,
      );
    if (sit) return liveItem(sit);
    if (namedHit && namedHit.item.title === SITUATION_TITLE) return liveItem(namedHit.item);
    return namedHit ? liveItem(namedHit.item) : null;
  } catch {
    return null;
  }
}

/**
 * Hydrate session topic from durable memory only when the owner asked to
 * continue prior work and this talk has no topic yet. Never on a greeting.
 */
export function restoreCompactIfContinuing(text: string): boolean {
  if (session.activeTopic) return false;
  if (!looksLikeContinueAcrossChats(text)) return false;
  const found = liveSituationMemory(text);
  const snap = (() => {
    try {
      return readLocalState<CompactSnap>(SNAP_KEY);
    } catch {
      return null;
    }
  })();
  const topic = String(found?.context || snap?.topic || found?.title || "").trim();
  if (!topic || topic === SITUATION_TITLE) return false;
  session.activeTopic = topic.slice(0, 240);
  session.userGoal = String(snap?.goal || found?.text || topic).slice(0, 240);
  if (snap?.graphId) session.activeGraphId = snap.graphId;
  ensureActiveThread(session.activeTopic);
  addSessionFact(`restored: ${(found?.text || topic).slice(0, 160)}`, "session");
  markMeaningful();
  touch();
  return true;
}

export function resumeMatchingThread(cue: string): ConversationThread | null {
  const paused = pausedThreads();
  if (!paused.length) {
    const prior = resumePreviousTopic();
    return prior ? activeThread() : null;
  }
  const scored = paused
    .map((item) => ({ item, score: overlap(item.topic, cue) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  if (top && second && top.score >= 0.22 && top.score - second.score < 0.08) {
    return null;
  }
  const target = top && top.score >= 0.22 ? top.item : null;
  if (!target) {
    if (/\b(wapas|go back|pehle wala|earlier one|previous topic)\b/i.test(cue)) {
      return resumePreviousTopic() ? activeThread() : null;
    }
    return activeThread();
  }
  pauseActiveThread();
  session.threads = session.threads.map((item) =>
    item.id === target.id ? { ...item, status: "active" as const } : item,
  );
  session.activeThreadId = target.id;
  if (session.activeTopic && session.activeTopic !== target.topic) {
    recordTopicTransition(session.activeTopic, target.topic, "resume");
  }
  session.activeTopic = target.topic;
  session.phase = "exploring";
  markMeaningful();
  touch();
  return { ...target, status: "active" };
}

function applyWorkUtterance(text: string): boolean {
  if (looksLikePauseWork(text)) {
    pauseActiveThread();
    pauseBoundGraph();
    addSessionFact("paused current thread", "session");
    markMeaningful();
    return true;
  }
  if (looksLikeCompleteWork(text)) {
    if (session.activeTopic) {
      addSessionFact(`Progress noted: ${session.activeTopic.slice(0, 80)}`, "session");
    }
    markMeaningful();
    return true;
  }
  if (looksLikeContinueAcrossChats(text)) {
    restoreCompactIfContinuing(text);
    const resumed = resumeMatchingThread(text);
    resumeBoundOrMatchingGraph(text);
    if (resumed || session.activeTopic) markMeaningful();
    return Boolean(session.activeTopic);
  }
  return false;
}

function persistCompactSnapshot(): void {
  try {
    writeState(SNAP_KEY, {
      topic: session.activeTopic,
      goal: session.userGoal,
      threadId: session.activeThreadId,
      graphId: session.activeGraphId,
      at: Date.now(),
    } satisfies CompactSnap);
  } catch {
    /* persist is a no-op in Node tests */
  }
}

/** Compact current-state line — not a transcript dump. */
export function compactSituation(): string {
  const bits: string[] = [];
  if (session.activeTopic) bits.push(`working on ${session.activeTopic.slice(0, 80)}`);
  if (session.userGoal && session.userGoal !== session.activeTopic) {
    bits.push(`want ${session.userGoal.slice(0, 60)}`);
  }
  const paused = pausedThreads();
  if (paused.length) bits.push(`${paused.length} paused thread(s)`);
  const decided = session.decisions[session.decisions.length - 1];
  if (decided) bits.push(`decided ${decided.selected.slice(0, 60)}`);
  if (session.presentedOptions.length) {
    const selected = session.presentedOptions.find((item) => item.status === "selected");
    bits.push(
      selected
        ? `chose option ${selected.index} (${selected.text.slice(0, 60)})`
        : `${session.presentedOptions.length} options presented`,
    );
  }
  if (session.activeGraphId) {
    try {
      const graph = taskGraph.get(session.activeGraphId);
      if (
        graph &&
        (graph.state === "queued" || graph.state === "running" || graph.state === "paused")
      ) {
        const progress = graphProgress(graph);
        bits.push(`task ${progress.done}/${progress.total} (${graph.state})`);
        if (progress.remaining[0]) bits.push(`next ${progress.remaining[0].slice(0, 40)}`);
      }
    } catch {
      /* optional */
    }
  }
  if (session.correctionStreak) bits.push(`${session.correctionStreak} correction(s)`);
  if (session.phase !== "opening") bits.push(`phase ${session.phase}`);
  if (session.styleCue) bits.push(`style ${session.styleCue}`);
  return bits.join("; ");
}

/** One working/project memory row for the latest compact state. */
export function snapshotCurrentSituation(): void {
  const compact = compactSituation();
  if (!compact || !session.activeTopic) return;
  if (/^(hi|hello|hey|thanks|thank you)\b/i.test(session.activeTopic)) return;
  try {
    memory.remember({
      tier: "semantic",
      title: SITUATION_TITLE,
      text: compact,
      source: "conversation-state",
      kind: "project",
      verified: true,
      confidence: 0.75,
      tags: ["continuity", "project"],
      context: session.activeTopic.slice(0, 120),
    });
  } catch {
    /* promotion must never break a turn */
  }
}

/** Persist compact state, promote the situation row, then start a clean talk. */
export function persistAndResetConversation(): void {
  persistCompactSnapshot();
  snapshotCurrentSituation();
  resetConversationSession();
}

export function noteUserTurn(
  text: string,
  endpoint: "chat" | "voice" | "system" = "chat",
): ConversationSession {
  const continuity = continuityKey(endpoint, session.id);
  if (!continuity.ok) return session;
  const value = String(text || "").trim();
  if (!value) return session;
  decayConversationState();

  if (/\b(thoda simple|keep it simple|be brief|short answer|simple batao)\b/i.test(value)) {
    session.styleCue = "simple";
  } else if (/\b(in detail|explain fully|zyada detail)\b/i.test(value)) {
    session.styleCue = "detailed";
  } else if (/\b(short|briefly|in short)\b/i.test(value)) {
    session.styleCue = "brief";
  } else if (
    /\b(is (answer|reply) mein bullets|use bullets (here|this time)|this answer in bullets)\b/i.test(
      value,
    )
  ) {
    session.styleCue = "brief";
  }

  restoreCompactIfContinuing(value);
  if (applyWorkUtterance(value)) {
    session.phase = derivePhase(value);
    touch();
    return session;
  }

  if (looksLikeReferenceOnly(value) || looksLikeFollowUpWork(value) || value.length < 8) {
    session.phase = derivePhase(value);
    touch();
    return session;
  }

  if (looksLikeSubtopicShift(value)) {
    const next = value.slice(0, 120);
    if (next && !session.subtopics.includes(next)) {
      session.subtopics = [...session.subtopics, next].slice(-8);
    }
    session.phase = derivePhase(value);
    touch();
    return session;
  }

  const clipped = value.slice(0, 240);
  if (session.activeTopic && session.activeTopic !== clipped) {
    const similar = overlap(session.activeTopic, clipped);
    if (similar < 0.22) {
      recordTopicTransition(session.activeTopic, clipped, "switch");
      if (!session.previousTopics.includes(session.activeTopic)) {
        session.previousTopics = [...session.previousTopics, session.activeTopic].slice(-8);
      }
      pauseActiveThread();
      session.subtopics = [];
      session.activeTopic = clipped;
      session.userGoal = clipped;
      ensureActiveThread(clipped);
      markMeaningful();
    } else {
      const next = value.slice(0, 120);
      if (!session.subtopics.includes(next) && next !== session.activeTopic.slice(0, 120)) {
        session.subtopics = [...session.subtopics, next].slice(-8);
      }
    }
  } else if (!session.activeTopic) {
    session.activeTopic = clipped;
    if (!session.userGoal) session.userGoal = clipped;
    ensureActiveThread(clipped);
  }

  session.phase = derivePhase(value);
  touch();
  return session;
}

export function recordTopicTransition(from: string, to: string, cue: string): void {
  const start = String(from || "").trim();
  const end = String(to || "").trim();
  if (!start || !end || start === end) return;
  session.topicTransitions = [
    ...session.topicTransitions,
    { from: start.slice(0, 160), to: end.slice(0, 160), at: Date.now(), cue: cue.slice(0, 40) },
  ].slice(-MAX_TRANSITIONS);
  touch();
}

export function setActiveTopic(topic: string): void {
  const value = String(topic || "").trim();
  if (!value) return;
  if (session.activeTopic && session.activeTopic !== value) {
    recordTopicTransition(session.activeTopic, value, "set");
  }
  session.activeTopic = value.slice(0, 240);
  ensureActiveThread(session.activeTopic);
  touch();
}

export function addSubtopic(topic: string): void {
  const value = String(topic || "")
    .trim()
    .slice(0, 120);
  if (!value || session.subtopics.includes(value)) return;
  session.subtopics = [...session.subtopics, value].slice(-8);
  touch();
}

/** Resume a paused thread by 1-based index in previousTopics / paused threads. */
export function resumeThreadByIndex(index: number): ConversationThread | null {
  const paused = session.threads.filter((item) => item.status === "paused");
  const fromPrevious = session.previousTopics[index - 1];
  const target =
    paused[index - 1] ??
    (fromPrevious
      ? session.threads.find((item) => overlap(item.topic, fromPrevious) >= 0.3)
      : undefined);
  if (!target && fromPrevious) {
    pauseActiveThread();
    session.activeTopic = fromPrevious;
    ensureActiveThread(fromPrevious);
    session.phase = "exploring";
    touch();
    return session.threads.find((item) => item.status === "active") ?? null;
  }
  if (!target) return null;
  pauseActiveThread();
  session.threads = session.threads.map((item) =>
    item.id === target.id ? { ...item, status: "active" as const } : item,
  );
  session.activeThreadId = target.id;
  session.activeTopic = target.topic;
  session.phase = "exploring";
  touch();
  return { ...target, status: "active" };
}

export function resumePreviousTopic(): string | null {
  const prior = session.previousTopics[session.previousTopics.length - 1];
  if (!prior) return resumeThreadByIndex(1)?.topic ?? null;
  pauseActiveThread();
  if (session.activeTopic && session.activeTopic !== prior) {
    recordTopicTransition(session.activeTopic, prior, "resume");
  }
  session.activeTopic = prior;
  ensureActiveThread(prior);
  session.phase = "exploring";
  touch();
  return prior;
}

export function noteUserGoal(goal: string, outcome = ""): void {
  const value = String(goal || "").trim();
  if (!value) return;
  session.userGoal = value.slice(0, 240);
  if (outcome.trim()) session.desiredOutcome = outcome.trim().slice(0, 240);
  touch();
}

export function noteConstraint(text: string): void {
  const value = String(text || "")
    .trim()
    .slice(0, 160);
  if (!value || session.constraints.includes(value)) return;
  session.constraints = [...session.constraints, value].slice(-8);
  touch();
}

export function noteCorrection(text: string): void {
  const value = String(text || "")
    .trim()
    .slice(0, 240);
  if (!value) return;
  session.corrections = [...session.corrections, value].slice(-8);
  session.correctionStreak += 1;
  session.phase = "repairing";
  addSessionFact(value, "correction");
  touch();
}

export function noteCommitment(text: string): void {
  const value = String(text || "")
    .trim()
    .slice(0, 160);
  if (!value) return;
  session.commitments = [...session.commitments, value].slice(-8);
  addSessionFact(value, "commitment", SESSION_FACT_MS);
  touch();
}

export function addSessionFact(
  text: string,
  kind: SessionFactKind,
  ttl = kind === "ephemeral" ? EPHEMERAL_MS : SESSION_FACT_MS,
): SessionFact | null {
  const value = String(text || "")
    .trim()
    .slice(0, 240);
  if (!value) return null;
  const fact: SessionFact = {
    id: nextId("fact"),
    text: value,
    kind,
    at: Date.now(),
    expiresAt: Date.now() + ttl,
  };
  session.facts = [...session.facts, fact].slice(-MAX_FACTS);
  if (kind === "assumption" && !session.assumptions.includes(value)) {
    session.assumptions = [...session.assumptions, value].slice(-8);
  }
  if (kind === "preference" && !session.preferences.includes(value)) {
    session.preferences = [...session.preferences, value].slice(-8);
  }
  touch();
  return fact;
}

export function setInterpretationConfidence(value: number): void {
  session.interpretationConfidence = Math.max(0, Math.min(1, value));
  touch();
}

export function clearCorrectionStreak(): void {
  session.correctionStreak = 0;
  if (session.phase === "repairing") session.phase = derivePhase("");
  touch();
}

export function selectPresentedOption(index: number): PresentedOption | null {
  const option = session.presentedOptions.find((item) => item.index === index);
  if (!option) return null;
  session.presentedOptions = session.presentedOptions.map((item) => ({
    ...item,
    status: item.index === index ? "selected" : "rejected",
  }));
  const rejected = session.presentedOptions
    .filter((item) => item.status === "rejected")
    .map((item) => item.text);
  const decision: SessionDecision = {
    id: nextId("decision"),
    summary: `chose option ${index}: ${option.text}`,
    selected: option.text,
    rejected,
    at: Date.now(),
  };
  session.decisions = [...session.decisions, decision].slice(-20);
  session.pendingDecisions = [];
  session.phase = "executing";
  session.userGoal = session.userGoal || `carry out ${option.text}`.slice(0, 240);
  addSessionFact(`selected: ${option.text}`, "session");
  touch();
  promoteDecision(decision);
  markMeaningful();
  return { ...option, status: "selected" };
}

function promoteDecision(decision: SessionDecision): void {
  const topic = session.activeTopic || "this session";
  const text = `Owner decided ${decision.summary} while discussing ${topic}.`;
  try {
    consolidateEvent({
      text,
      title: `Session decision: ${decision.selected}`.slice(0, 120),
      source: "conversation-state",
      kindHint: "decision",
      ok: true,
      confidence: 0.8,
      verified: true,
    });
  } catch {
    /* promotion must never break a turn */
  }
}

export function getConversationSession(): ConversationSession {
  return session;
}

export function lastDecision(): SessionDecision | null {
  return session.decisions[session.decisions.length - 1] ?? null;
}

export function activeThread(): ConversationThread | null {
  return session.threads.find((item) => item.status === "active") ?? null;
}

export function pausedThreads(): ConversationThread[] {
  return session.threads.filter((item) => item.status === "paused");
}

/** One-line digest for Core Brain notes — empty when the session is unused. */
export function conversationDigest(): string {
  return compactSituation();
}

export function resetConversationSession(): void {
  session = emptySession();
  seq = 0;
}
