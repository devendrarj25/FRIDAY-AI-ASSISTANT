/**
 * FRIDAY · open loops
 *
 * Unresolved questions and pending tasks for this session. Lives on the
 * conversation-session object — not a second persistence layer.
 */

import { getConversationSession } from "./conversation-state";

export type OpenLoopKind = "question" | "task";
export type OpenLoopStatus = "open" | "resolved";

export type OpenLoop = {
  id: string;
  kind: OpenLoopKind;
  text: string;
  status: OpenLoopStatus;
  at: number;
};

let loops: OpenLoop[] = [];
let seq = 0;

function nextId(): string {
  seq += 1;
  return `loop-${seq}`;
}

export function listOpenLoops(): OpenLoop[] {
  return loops.filter((item) => item.status === "open");
}

export function listAllLoops(): OpenLoop[] {
  return [...loops];
}

export function addOpenLoop(kind: OpenLoopKind, text: string): OpenLoop | null {
  const value = String(text || "")
    .trim()
    .slice(0, 240);
  if (!value) return null;
  const existing = loops.find(
    (item) => item.status === "open" && item.kind === kind && item.text === value,
  );
  if (existing) return existing;
  const loop: OpenLoop = { id: nextId(), kind, text: value, status: "open", at: Date.now() };
  loops = [...loops, loop].slice(-24);
  return loop;
}

export function resolveOpenLoop(idOrText: string): OpenLoop | null {
  const needle = String(idOrText || "")
    .trim()
    .toLowerCase();
  const found = loops.find(
    (item) =>
      item.status === "open" && (item.id === idOrText || item.text.toLowerCase().includes(needle)),
  );
  if (!found) return null;
  found.status = "resolved";
  return found;
}

/** Pull questions from an assistant turn and pending asks from the owner. */
export function observeOpenLoops(history: { role: string; text: string }[]): OpenLoop[] {
  for (const turn of history) {
    const text = String(turn.text || "").trim();
    if (!text) continue;
    if (turn.role === "assistant" || turn.role === "friday") {
      for (const line of text.split(/\n+/)) {
        const trimmed = line.trim();
        if (trimmed.endsWith("?") && trimmed.length > 8) addOpenLoop("question", trimmed);
      }
    }
    if (turn.role === "user") {
      const pending = /\b(need to|still (need|have) to|don't forget|pending|unresolved)\b/i.exec(
        text,
      );
      if (pending) addOpenLoop("task", text.slice(0, 240));
    }
  }
  return listOpenLoops();
}

export function openLoopDigest(): string {
  const open = listOpenLoops();
  if (!open.length) return "";
  const questions = open.filter((item) => item.kind === "question").length;
  const tasks = open.filter((item) => item.kind === "task").length;
  const topic = getConversationSession().activeTopic;
  const bits = [
    questions ? `${questions} unanswered` : "",
    tasks ? `${tasks} pending task(s)` : "",
    topic ? `topic "${topic.slice(0, 60)}"` : "",
  ].filter(Boolean);
  return bits.join("; ");
}

export function resetOpenLoops(): void {
  loops = [];
  seq = 0;
}
