/**
 * FRIDAY · Flow Studio panel state.
 *
 * This is the open/close switch for the one canvas. It is not a second graph
 * and not a second trace. Events are copies of stages the brain already recorded.
 */

import {
  FLOW_RETENTION_CAP,
  redactFlowText,
  type FlowGraph,
  type FlowNodeStatus,
  type FlowRunEvent,
} from "./flow-graph";

export type FlowStudioMode = "chart" | "watch";
export type FlowStudioView = "graph" | "list" | "code" | "blocks";

export type FlowStudioSnapshot = {
  open: boolean;
  feature: string;
  mode: FlowStudioMode;
  view: FlowStudioView;
  generation: number;
  runId: string;
  events: FlowRunEvent[];
  board: FlowGraph | null;
  boardStamp: number;
};

let retentionCap = FLOW_RETENTION_CAP;

const empty: FlowStudioSnapshot = {
  open: false,
  feature: "master",
  mode: "chart",
  view: "graph",
  generation: 0,
  runId: "",
  events: [],
  board: null,
  boardStamp: 0,
};

let state: FlowStudioSnapshot = empty;
let generation = 0;
const runs = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  state = { ...state };
  listeners.forEach((fn) => fn());
}

export const flowStudio = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): FlowStudioSnapshot {
    return state;
  },
  open(feature = "master", mode: FlowStudioMode = "chart") {
    state = { ...state, open: true, feature, mode, board: null };
    emit();
  },
  openBoard(graph: FlowGraph, mode: FlowStudioMode = "chart") {
    state = {
      ...state,
      open: true,
      feature: graph.id,
      mode,
      board: graph,
      boardStamp: state.boardStamp + 1,
    };
    emit();
  },
  showWork() {
    state = { ...state, open: true, mode: "watch" };
    emit();
  },
  setRetention(cap: number) {
    retentionCap = Math.max(20, Math.min(2000, Math.floor(cap) || FLOW_RETENTION_CAP));
  },
  retention(): number {
    return retentionCap;
  },
  close() {
    state = { ...state, open: false, board: null };
    emit();
  },
  setView(view: FlowStudioView) {
    state = { ...state, view };
    emit();
  },
  beginRun(runId: string) {
    if (!runs.has(runId)) {
      generation += 1;
      runs.set(runId, generation);
      if (runs.size > 20) {
        const oldest = runs.keys().next().value;
        if (oldest) runs.delete(oldest);
      }
    }
    state = {
      ...state,
      runId,
      generation: runs.get(runId) || generation,
      events: state.runId === runId ? state.events : [],
    };
    emit();
  },
  noteMany(
    runId: string,
    rows: { nodeId: string; status: FlowNodeStatus; detail?: string }[],
    at = 0,
  ) {
    if (!runs.has(runId)) this.beginRun(runId);
    const gen = runs.get(runId) || generation;
    const added: FlowRunEvent[] = rows.map((row, index) => {
      const safeDetail = redactFlowText(row.detail || "");
      return {
        generation: gen,
        nodeId: row.nodeId,
        status: row.status,
        at: at + index,
        ...(safeDetail ? { detail: safeDetail } : {}),
      };
    });
    const events = (state.runId === runId ? [...state.events, ...added] : added).slice(
      -retentionCap,
    );
    state = { ...state, runId, generation: gen, events };
    emit();
  },
  note(runId: string, nodeId: string, status: FlowNodeStatus, detail: string) {
    const gen = runs.get(runId);
    if (!gen) this.beginRun(runId);
    const safeDetail = redactFlowText(detail);
    const event: FlowRunEvent = {
      generation: runs.get(runId) || generation,
      nodeId,
      status,
      at: Date.now(),
      ...(safeDetail ? { detail: safeDetail } : {}),
    };
    const events = state.runId === runId ? [...state.events, event].slice(-retentionCap) : [event];
    state = { ...state, runId, generation: event.generation, events };
    emit();
  },
  clearEvents() {
    state = { ...state, events: [] };
    emit();
  },
};

export function activeFlowGeneration(): number {
  return state.generation;
}
