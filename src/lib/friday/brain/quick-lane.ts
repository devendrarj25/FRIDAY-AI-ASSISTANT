/**
 * FRIDAY · a short question while a long task is running
 *
 * The Brain runs one turn at a time, so a new message used to be refused with "one moment". A short,
 * harmless question does not need the whole turn: it can be answered by a single plain model call that
 * goes through the same privacy and billing gates as any other, without touching the running task, the tools
 * or memory. Anything that looks like an order, mentions an attachment, or could be sensitive waits as before.
 */

import { isConsequential } from "./action-risk";
import { looksSensitive } from "./memory-policy";

export const QUICK_MAX_CHARS = 160;

const QUESTION_LEAD =
  /^\s*(what|who|when|where|why|how|which|is|are|was|were|can|could|does|do|did|will|kya|kaun|kab|kahan|kyun|kyu|kaise|kitna|kitne)\b/i;
const ORDER_WORD =
  /\b(open|run|start|stop|install|delete|remove|create|write|send|make|build|download|click|type|launch|close|kill|restart|shutdown|save|rename|move|copy|paste|buy|pay|order|book|schedule)\b/i;

export function quickLaneEligible(input: { text: string; busy: boolean; hasExtra?: boolean }): {
  ok: boolean;
  reason: string;
} {
  const text = String(input.text || "").trim();
  if (!input.busy) return { ok: false, reason: "nothing is running" };
  if (!text || text.length > QUICK_MAX_CHARS) return { ok: false, reason: "not short" };
  if (input.hasExtra) return { ok: false, reason: "has an attachment" };
  if (!text.endsWith("?") && !QUESTION_LEAD.test(text))
    return { ok: false, reason: "not a question" };
  if (ORDER_WORD.test(text) || isConsequential(text))
    return { ok: false, reason: "looks like an order" };
  if (looksSensitive(text) || /https?:\/\/|```/.test(text))
    return { ok: false, reason: "needs the full turn" };
  return { ok: true, reason: "short harmless question" };
}

export const QUICK_SYSTEM =
  "You are FRIDAY. A longer task is running for your owner right now. Answer this one short question in one or two sentences from what you know. Do not start tasks, do not use tools, and say plainly if you do not know.";
