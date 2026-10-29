/**
 * FRIDAY · per-turn reasoning trace (chat, one assistant message)
 *
 * Not the system-wiring visualizer. This maps a single chat turn onto the
 * existing FLOW_CHART node ids and groups them into the owner-facing lanes
 * (Thinking / Searching / Inspecting / Analysing / Summarising / Calculating).
 *
 * Only stages that actually ran are recorded. Unknown node ids are dropped.
 * Labels here must stay identical to `flow-chart.ts` — `turn-trace.test.ts`
 * checks that contract so this file does not import `flow-chart.ts` (that
 * import would cycle through `brain-engine`).
 */

export const TRACE_LANES = [
  "Thinking",
  "Searching",
  "Inspecting",
  "Analysing",
  "Summarising",
  "Calculating",
] as const;

export type TraceLane = (typeof TRACE_LANES)[number];

export type TurnTraceStep = {
  id: string;
  /** FLOW_CHART node id. */
  nodeId: string;
  /** FLOW_CHART node label. */
  label: string;
  lane: TraceLane;
  state: "running" | "done" | "failed";
  startedAt: number;
  /** Elapsed ms once the step left `running`. */
  ms?: number;
  /** Real detail from the stage that ran. Never filler copy. */
  detail: string;
};

export type TraceLaneView = {
  lane: TraceLane;
  steps: TurnTraceStep[];
  running: boolean;
  failed: boolean;
  ms: number;
};

/** FLOW_CHART id → chart label + default lane. Searching is assigned when the detail is a real web search. */
export const TRACE_NODES: Record<string, { label: string; lane: TraceLane }> = {
  "thinking.intent": { label: "Command / intent", lane: "Thinking" },
  "thinking.understand": { label: "Intent (live)", lane: "Thinking" },
  "thinking.voice-same-brain": { label: "Anti-repetition", lane: "Thinking" },
  "thinking.context": { label: "Context", lane: "Inspecting" },
  "thinking.observe": { label: "Observability", lane: "Inspecting" },
  "memory.tiers": {
    label: "Conversation / task / preference / knowledge memory",
    lane: "Inspecting",
  },
  "thinking.planner": { label: "Planner", lane: "Analysing" },
  "thinking.prepare": { label: "Context + reasoning", lane: "Analysing" },
  "thinking.cognition": { label: "Cognition", lane: "Analysing" },
  "orchestrator.pipeline": { label: "Pipeline", lane: "Analysing" },
  "orchestrator.collaboration": { label: "Multi-model collaboration", lane: "Analysing" },
  "router.select": { label: "Selection", lane: "Analysing" },
  "orchestrator.report": { label: "Report", lane: "Summarising" },
  "verify.answer": { label: "Answer verification", lane: "Summarising" },
  "agents.registry": { label: "Agents", lane: "Calculating" },
  "agents.skills": { label: "Skill routing", lane: "Calculating" },
  "agents.tools": { label: "Tool routing", lane: "Calculating" },
  "execution.runners": { label: "Execution", lane: "Calculating" },
};

export function isTraceNode(nodeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(TRACE_NODES, nodeId);
}

export function laneForNode(nodeId: string, detail = ""): TraceLane | null {
  if (/\bweb search\b/i.test(detail)) return "Searching";
  return TRACE_NODES[nodeId]?.lane ?? null;
}

export function labelForNode(nodeId: string): string | null {
  return TRACE_NODES[nodeId]?.label ?? null;
}

export type StageReporter = (nodeId: string, detail: string) => void;

export function completeRunningStep(
  steps: TurnTraceStep[],
  state: "done" | "failed" = "done",
  extra?: string,
): void {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step && step.state === "running") {
      step.state = state;
      step.ms = Math.max(0, Date.now() - step.startedAt);
      if (extra) step.detail = step.detail ? `${step.detail} · ${extra}` : extra;
      return;
    }
  }
}

export function appendTraceStep(
  steps: TurnTraceStep[],
  input: {
    id: string;
    nodeId: string;
    detail: string;
    startedAt?: number;
    ms?: number;
    state?: TurnTraceStep["state"];
  },
): TurnTraceStep | null {
  const meta = TRACE_NODES[input.nodeId];
  const lane = laneForNode(input.nodeId, input.detail);
  if (!meta || !lane) return null;
  completeRunningStep(steps, "done");
  const step: TurnTraceStep = {
    id: input.id,
    nodeId: input.nodeId,
    label: meta.label,
    lane,
    state: input.state ?? "running",
    startedAt: input.startedAt ?? Date.now(),
    detail: input.detail,
    ...(input.ms != null ? { ms: input.ms } : {}),
  };
  steps.push(step);
  return step;
}

/** Group real steps into owner-facing lanes. Empty lanes are omitted. */
export function lanesFromSteps(steps: TurnTraceStep[], now = Date.now()): TraceLaneView[] {
  const grouped = new Map<TraceLane, TurnTraceStep[]>();
  for (const step of steps) {
    const list = grouped.get(step.lane) ?? [];
    list.push(step);
    grouped.set(step.lane, list);
  }
  return TRACE_LANES.filter((lane) => grouped.has(lane)).map((lane) => {
    const items = grouped.get(lane)!;
    const running = items.some((step) => step.state === "running");
    const failed = items.some((step) => step.state === "failed");
    const ms = items.reduce((sum, step) => {
      if (typeof step.ms === "number") return sum + step.ms;
      if (step.state === "running") return sum + Math.max(0, now - step.startedAt);
      return sum;
    }, 0);
    return { lane, steps: items, running, failed, ms };
  });
}
