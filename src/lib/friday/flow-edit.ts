/**
 * FRIDAY · canvas edits on the one graph.
 *
 * Drag, reconnect, delete, insert, group, and undo live here. The canvas
 * draws the result. It does not keep a second model.
 */

import {
  nodeOf,
  safeFlowId,
  type FlowEdgeKind,
  type FlowGraph,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowIssue,
} from "./flow-graph";
import { inferBinding } from "./flow-bind";

export type Point = { x: number; y: number };

export type BoxPlace = {
  x: number;
  y: number;
  w: number;
  h: number;
  locked?: boolean;
  pinned?: boolean;
  bookmarked?: boolean;
};

export type FlowPlacement = {
  positions: Record<string, BoxPlace>;
  waypoints: Record<string, Point[]>;
  collapsed: string[];
};

export type CanvasAction =
  | { type: "move"; ids: string[]; dx: number; dy: number }
  | { type: "place"; id: string; x: number; y: number }
  | { type: "resize"; id: string; w: number; h: number }
  | { type: "connect"; source: string; target: string; kind?: FlowEdgeKind }
  | { type: "reconnect"; edgeId: string; source: string; target: string }
  | { type: "delete-edge"; edgeId: string }
  | { type: "delete-nodes"; ids: string[] }
  | { type: "insert"; edgeId: string; label: string }
  | { type: "waypoints"; edgeId: string; points: Point[] }
  | { type: "kind"; edgeId: string; kind: FlowEdgeKind; label?: string }
  | { type: "group"; id: string; title: string; nodeIds: string[] }
  | { type: "collapse"; groupId: string; collapsed: boolean }
  | { type: "duplicate"; ids: string[] }
  | { type: "lock"; id: string; locked: boolean }
  | { type: "pin"; id: string; on: boolean }
  | { type: "bookmark"; id: string; on: boolean }
  | { type: "align"; ids: string[]; axis: "x" | "y" }
  | { type: "distribute"; ids: string[]; axis: "x" | "y" }
  | { type: "tidy"; grid?: number }
  | { type: "layout"; positions: Record<string, { x: number; y: number }> };

export type CanvasState = {
  graph: FlowGraph;
  placement: FlowPlacement;
  past: { graph: FlowGraph; placement: FlowPlacement }[];
  future: { graph: FlowGraph; placement: FlowPlacement }[];
};

const GRID = 16;

export function emptyPlacement(): FlowPlacement {
  return { positions: {}, waypoints: {}, collapsed: [] };
}

export function canvasState(graph: FlowGraph, placement = emptyPlacement()): CanvasState {
  return { graph, placement, past: [], future: [] };
}

function cloneNode(node: FlowGraphNode): FlowGraphNode {
  return {
    ...node,
    ports: node.ports.map((port) => ({ ...port })),
    source: { ...node.source },
  };
}

function cloneEdge(edge: FlowGraphEdge): FlowGraphEdge {
  return {
    ...edge,
    ...(edge.binding ? { binding: { ...edge.binding } } : {}),
  };
}

function cloneGraph(graph: FlowGraph): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(cloneNode),
    edges: graph.edges.map(cloneEdge),
    groups: graph.groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
    ...(graph.budget ? { budget: { ...graph.budget } } : {}),
  };
}

function copyPlacement(placement: FlowPlacement): FlowPlacement {
  const positions: FlowPlacement["positions"] = {};
  for (const [id, box] of Object.entries(placement.positions)) {
    positions[id] = {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      ...(box.locked ? { locked: true } : {}),
      ...(box.pinned ? { pinned: true } : {}),
      ...(box.bookmarked ? { bookmarked: true } : {}),
    };
  }
  const waypoints: FlowPlacement["waypoints"] = {};
  for (const [id, points] of Object.entries(placement.waypoints)) {
    waypoints[id] = points.map((point) => ({ ...point }));
  }
  return { positions, waypoints, collapsed: [...placement.collapsed] };
}

function box(placement: FlowPlacement, id: string): BoxPlace {
  return placement.positions[id] || { x: 0, y: 0, w: 160, h: 64 };
}

function putBox(placement: FlowPlacement, id: string, next: BoxPlace) {
  placement.positions[id] = next;
}

function nodeLocked(graph: FlowGraph, id: string): boolean {
  return Boolean(graph.nodes.find((node) => node.id === id)?.locked);
}

function remember(state: CanvasState, next: CanvasState): CanvasState {
  return {
    ...next,
    past: [
      ...state.past,
      { graph: cloneGraph(state.graph), placement: copyPlacement(state.placement) },
    ].slice(-40),
    future: [],
  };
}

export function canvasUndo(state: CanvasState): CanvasState {
  const previous = state.past[state.past.length - 1];
  if (!previous) return state;
  return {
    graph: previous.graph,
    placement: previous.placement,
    past: state.past.slice(0, -1),
    future: [{ graph: state.graph, placement: state.placement }, ...state.future].slice(0, 40),
  };
}

export function canvasRedo(state: CanvasState): CanvasState {
  const next = state.future[0];
  if (!next) return state;
  return {
    graph: next.graph,
    placement: next.placement,
    past: [...state.past, { graph: state.graph, placement: state.placement }].slice(-40),
    future: state.future.slice(1),
  };
}

export function canvasDo(
  state: CanvasState,
  action: CanvasAction,
): { state: CanvasState; issues: FlowIssue[] } {
  const issues: FlowIssue[] = [];
  const graph = cloneGraph(state.graph);
  const placement = copyPlacement(state.placement);

  if (action.type === "move") {
    for (const id of action.ids) {
      if (nodeLocked(graph, id) || box(placement, id).locked) {
        issues.push({ code: "locked", nodeId: id, message: "That box is locked." });
        continue;
      }
      const current = box(placement, id);
      putBox(placement, id, { ...current, x: current.x + action.dx, y: current.y + action.dy });
    }
  } else if (action.type === "place") {
    if (nodeLocked(graph, action.id) || box(placement, action.id).locked) {
      issues.push({ code: "locked", nodeId: action.id, message: "That box is locked." });
    } else {
      const current = box(placement, action.id);
      putBox(placement, action.id, { ...current, x: action.x, y: action.y });
    }
  } else if (action.type === "resize") {
    if (nodeLocked(graph, action.id)) {
      issues.push({ code: "locked", nodeId: action.id, message: "That box is locked." });
    } else {
      const current = box(placement, action.id);
      putBox(placement, action.id, {
        ...current,
        w: Math.max(96, action.w),
        h: Math.max(48, action.h),
      });
    }
  } else if (action.type === "connect") {
    if (nodeLocked(graph, action.source) || nodeLocked(graph, action.target)) {
      issues.push({ code: "locked", message: "A locked box cannot take a new wire." });
    } else if (action.source === action.target) {
      issues.push({ code: "loop", message: "A box cannot wire to itself." });
    } else {
      const id = safeFlowId(`w.${action.source}.${action.target}.${graph.edges.length}`);
      const kind = action.kind || "control";
      graph.edges.push({
        id,
        source: action.source,
        target: action.target,
        kind,
        binding: inferBinding(graph, action.source, action.target),
      });
    }
  } else if (action.type === "reconnect") {
    const edge = graph.edges.find((item) => item.id === action.edgeId);
    if (!edge) issues.push({ code: "missing", message: "That wire is gone." });
    else if (
      nodeLocked(graph, edge.source) ||
      nodeLocked(graph, edge.target) ||
      nodeLocked(graph, action.source) ||
      nodeLocked(graph, action.target)
    ) {
      issues.push({ code: "locked", message: "A locked box cannot be rewired." });
    } else {
      edge.source = action.source;
      edge.target = action.target;
      edge.binding = inferBinding(graph, action.source, action.target);
    }
  } else if (action.type === "delete-edge") {
    const edge = graph.edges.find((item) => item.id === action.edgeId);
    if (edge && (nodeLocked(graph, edge.source) || nodeLocked(graph, edge.target))) {
      issues.push({ code: "locked", message: "A locked box keeps its wires." });
    } else {
      graph.edges = graph.edges.filter((item) => item.id !== action.edgeId);
      delete placement.waypoints[action.edgeId];
    }
  } else if (action.type === "delete-nodes") {
    const blocked = action.ids.filter((id) => nodeLocked(graph, id));
    if (blocked.length) {
      issues.push({ code: "locked", message: "A locked box cannot be deleted." });
    }
    const drop = new Set(action.ids.filter((id) => !nodeLocked(graph, id)));
    graph.nodes = graph.nodes.filter((node) => !drop.has(node.id));
    graph.edges = graph.edges.filter((edge) => !drop.has(edge.source) && !drop.has(edge.target));
    graph.groups = graph.groups.map((group) => ({
      ...group,
      nodeIds: group.nodeIds.filter((id) => !drop.has(id)),
    }));
    for (const id of drop) delete placement.positions[id];
  } else if (action.type === "insert") {
    const edge = graph.edges.find((item) => item.id === action.edgeId);
    if (!edge) issues.push({ code: "missing", message: "That wire is gone." });
    else if (nodeLocked(graph, edge.source) || nodeLocked(graph, edge.target)) {
      issues.push({ code: "locked", message: "A locked box cannot take an inserted step." });
    } else {
      const id = safeFlowId(`ins.${action.label}.${graph.nodes.length}`);
      const node = nodeOf({
        id,
        label: action.label.slice(0, 80) || "Step",
        kind: "note",
        status: "idle",
        risk: "safe",
        source: { adapter: "canvas", ref: id },
      });
      graph.nodes.push(node);
      const left = safeFlowId(`${edge.id}.a`);
      const right = safeFlowId(`${edge.id}.b`);
      graph.edges = graph.edges.filter((item) => item.id !== edge.id);
      graph.edges.push(
        {
          id: left,
          source: edge.source,
          target: id,
          kind: edge.kind,
          binding: inferBinding(graph, edge.source, id),
        },
        {
          id: right,
          source: id,
          target: edge.target,
          kind: edge.kind,
          binding: inferBinding(graph, id, edge.target),
        },
      );
      const from = box(placement, edge.source);
      const to = box(placement, edge.target);
      putBox(placement, id, {
        x: Math.round((from.x + to.x) / 2),
        y: Math.round((from.y + to.y) / 2),
        w: 160,
        h: 64,
      });
    }
  } else if (action.type === "waypoints") {
    placement.waypoints[action.edgeId] = action.points.map((point) => ({ ...point }));
  } else if (action.type === "kind") {
    const edge = graph.edges.find((item) => item.id === action.edgeId);
    if (!edge) issues.push({ code: "missing", message: "That wire is gone." });
    else {
      edge.kind = action.kind;
      if (action.label) edge.label = action.label.slice(0, 80);
    }
  } else if (action.type === "group") {
    const id = safeFlowId(action.id);
    graph.groups = graph.groups.filter((group) => group.id !== id);
    graph.groups.push({
      id,
      title: action.title.slice(0, 80) || "Group",
      nodeIds: [...action.nodeIds],
    });
  } else if (action.type === "collapse") {
    placement.collapsed = placement.collapsed.filter((id) => id !== action.groupId);
    if (action.collapsed) placement.collapsed.push(action.groupId);
  } else if (action.type === "duplicate") {
    for (const id of action.ids) {
      const node = graph.nodes.find((item) => item.id === id);
      if (!node) continue;
      const copyId = safeFlowId(`${id}.copy.${graph.nodes.length}`);
      graph.nodes.push(nodeOf({ ...node, id: copyId, locked: false, label: `${node.label} copy` }));
      const current = box(placement, id);
      putBox(placement, copyId, {
        ...current,
        x: current.x + 24,
        y: current.y + 24,
        locked: false,
      });
    }
  } else if (action.type === "lock") {
    const current = box(placement, action.id);
    putBox(placement, action.id, { ...current, ...(action.locked ? { locked: true } : {}) });
    if (!action.locked) {
      const { locked: _locked, ...rest } = box(placement, action.id);
      putBox(placement, action.id, rest);
    }
  } else if (action.type === "pin") {
    const current = box(placement, action.id);
    putBox(placement, action.id, {
      x: current.x,
      y: current.y,
      w: current.w,
      h: current.h,
      ...(current.locked ? { locked: true } : {}),
      ...(action.on ? { pinned: true } : {}),
      ...(current.bookmarked ? { bookmarked: true } : {}),
    });
  } else if (action.type === "bookmark") {
    const current = box(placement, action.id);
    putBox(placement, action.id, {
      x: current.x,
      y: current.y,
      w: current.w,
      h: current.h,
      ...(current.locked ? { locked: true } : {}),
      ...(current.pinned ? { pinned: true } : {}),
      ...(action.on ? { bookmarked: true } : {}),
    });
  } else if (action.type === "align") {
    const boxes = action.ids.map((id) => box(placement, id));
    if (boxes.length) {
      const anchor = action.axis === "x" ? boxes[0]!.x : boxes[0]!.y;
      for (const id of action.ids) {
        if (nodeLocked(graph, id) || box(placement, id).locked) continue;
        const current = box(placement, id);
        putBox(placement, id, {
          ...current,
          ...(action.axis === "x" ? { x: anchor } : { y: anchor }),
        });
      }
    }
  } else if (action.type === "distribute") {
    const ids = action.ids.filter((id) => !nodeLocked(graph, id) && !box(placement, id).locked);
    const ordered = [...ids].sort((a, b) =>
      action.axis === "x"
        ? box(placement, a).x - box(placement, b).x
        : box(placement, a).y - box(placement, b).y,
    );
    if (ordered.length > 2) {
      const first = box(placement, ordered[0]!).x;
      const last = box(placement, ordered[ordered.length - 1]!);
      const span =
        (action.axis === "x" ? last.x : last.y) -
        (action.axis === "x" ? first : box(placement, ordered[0]!).y);
      const step = span / (ordered.length - 1);
      ordered.forEach((id, index) => {
        const current = box(placement, id);
        const value = (action.axis === "x" ? first : box(placement, ordered[0]!).y) + step * index;
        putBox(placement, id, {
          ...current,
          ...(action.axis === "x" ? { x: value } : { y: value }),
        });
      });
    }
  } else if (action.type === "tidy") {
    const grid = action.grid || GRID;
    graph.nodes.forEach((node, index) => {
      if (nodeLocked(graph, node.id)) return;
      const current = placement.positions[node.id];
      if (current?.locked) return;
      putBox(placement, node.id, {
        x: Math.round((current?.x ?? index * grid) / grid) * grid,
        y: Math.round((current?.y ?? 0) / grid) * grid,
        w: current?.w || 160,
        h: current?.h || 64,
        ...(current?.pinned ? { pinned: true } : {}),
        ...(current?.bookmarked ? { bookmarked: true } : {}),
      });
    });
  } else if (action.type === "layout") {
    for (const [id, point] of Object.entries(action.positions)) {
      if (nodeLocked(graph, id) || box(placement, id).locked) continue;
      const current = box(placement, id);
      putBox(placement, id, { ...current, x: point.x, y: point.y });
    }
  }

  if (issues.length) return { state, issues };
  return { state: remember(state, { graph, placement, past: [], future: [] }), issues };
}
