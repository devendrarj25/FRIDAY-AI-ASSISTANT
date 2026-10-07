/**
 * FRIDAY · brain observability
 *
 * Internal diagnostic snapshot. No private chain-of-thought. No UI change —
 * callers (tests, doctor, future debug panels) read this object.
 */

import { affect } from "./affect";
import { lastDecision } from "./decision-trace";
import { currentPolicy } from "./cost-policy";
import { memory } from "../self/memory-engine";
import { taskGraph } from "../self/task-graph";
import { modelRegistry } from "./model-registry";
import type { UnderstoodIntent } from "./intent-engine";
import type { ActionDecision } from "./decision-engine";
import type { BrainError } from "./errors";

export type BrainObserve = {
  at: number;
  intent: { kind: string; label: string; confidence: number } | null;
  goal: string | null;
  tasks: { id: string; status: string; title: string }[];
  model: { ids: string[]; routing: string } | null;
  reason: string | null;
  tool: string | null;
  memoryUsed: number;
  confidence: number | null;
  mood: string;
  errors: BrainError[];
  latencyMs: number | null;
  fallbacks: string[];
  policy: string;
};

let lastIntent: UnderstoodIntent | null = null;
let lastDecisionLocal: ActionDecision | null = null;
let lastError: BrainError | null = null;
let lastLatency: number | null = null;
let lastTool: string | null = null;

export function noteObserve(input: {
  intent?: UnderstoodIntent | null;
  decision?: ActionDecision | null;
  error?: BrainError | null;
  latencyMs?: number | null;
  tool?: string | null;
}): void {
  if (input.intent !== undefined) lastIntent = input.intent;
  if (input.decision !== undefined) lastDecisionLocal = input.decision;
  if (input.error !== undefined) lastError = input.error;
  if (input.latencyMs !== undefined) lastLatency = input.latencyMs;
  if (input.tool !== undefined) lastTool = input.tool;
}

export function observeBrain(): BrainObserve {
  const trace = lastDecision();
  const graph = taskGraph.getSnapshot();
  const mem = memory.getSnapshot();
  let cooling: string[];
  try {
    cooling = modelRegistry
      .list()
      .filter((record) => record.coolingDown)
      .slice(0, 3)
      .map((record) => `${record.name} cooling down`);
  } catch {
    cooling = [];
  }
  return {
    at: Date.now(),
    intent: lastIntent
      ? {
          kind: lastIntent.kind,
          label: lastIntent.catalogLabel,
          confidence: lastIntent.catalogScore,
        }
      : null,
    goal: lastIntent?.goals[0] ?? null,
    tasks: graph.graphs
      .flatMap((g) => g.nodes.map((n) => ({ id: n.id, status: n.state, title: n.title })))
      .slice(0, 12),
    model: trace ? { ids: trace.modelIds, routing: trace.routing } : null,
    reason: lastDecisionLocal?.reason ?? trace?.routing ?? null,
    tool: lastTool,
    memoryUsed: mem.items.filter((i) => i.tier === "working" || i.tier === "semantic").length,
    confidence: lastDecisionLocal?.confidence ?? trace?.confidence?.score ?? null,
    mood: affect.getSnapshot().mood,
    errors: lastError ? [lastError] : [],
    latencyMs: lastLatency,
    fallbacks: [
      ...(lastDecisionLocal?.paidBlocked ? ["paid models blocked by policy"] : []),
      ...cooling,
    ],
    policy: currentPolicy(),
  };
}
