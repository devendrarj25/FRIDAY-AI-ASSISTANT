/**
 * FRIDAY · flow view model.
 *
 * Plain nodes and edges for the canvas and the list. Not a second graph.
 */
import type { FlowPlacement } from "./flow-edit";
import { layoutFlowGraph, type FlowGraph, type FlowRunEvent } from "./flow-graph";

export type FlowViewNode = {
  id: string;
  type: "flow";
  position: { x: number; y: number };
  width?: number;
  height?: number;
  hidden: boolean;
  draggable: boolean;
  ariaLabel: string;
  data: {
    label: string;
    status: string;
    risk: string;
    kind: string;
    locked: boolean;
    pinned: boolean;
    bookmarked: boolean;
    detail: string;
    privacy: string;
  };
};

export type FlowViewEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  animated: boolean;
  data: { waypoints: { x: number; y: number }[] };
};

export function flowElements(
  graph: FlowGraph,
  query = "",
  placement?: FlowPlacement,
): {
  nodes: FlowViewNode[];
  edges: FlowViewEdge[];
} {
  const { positions } = layoutFlowGraph(graph, () => 0);
  const at = new Map(positions.map((item) => [item.id, item]));
  const collapsed = new Set(placement?.collapsed || []);
  const hiddenGroups = new Set<string>();
  for (const group of graph.groups) {
    if (collapsed.has(group.id)) for (const id of group.nodeIds) hiddenGroups.add(id);
  }
  const needle = query.trim().toLowerCase();
  const nodes = graph.nodes.map((node) => {
    const stored = placement?.positions[node.id];
    const pos = stored || at.get(node.id) || { x: 0, y: 0 };
    const hidden =
      hiddenGroups.has(node.id) ||
      (needle
        ? !`${node.label} ${node.id} ${node.module || ""}`.toLowerCase().includes(needle)
        : false);
    return {
      id: node.id,
      type: "flow" as const,
      position: { x: pos.x, y: pos.y },
      ...(stored ? { width: stored.w, height: stored.h } : {}),
      hidden,
      draggable: !node.locked && !stored?.locked,
      ariaLabel: `${node.label}, ${node.status}, ${node.risk}, ${node.kind}${node.locked ? ", locked" : ""}`,
      data: {
        label: node.label,
        status: node.status,
        risk: node.risk,
        kind: node.kind,
        locked: Boolean(node.locked || stored?.locked),
        pinned: Boolean(stored?.pinned),
        bookmarked: Boolean(stored?.bookmarked),
        detail: node.detail,
        privacy: node.privacy,
      },
    };
  });
  const edges = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label || edge.when || edge.kind,
    kind: edge.kind,
    animated: false,
    data: { waypoints: placement?.waypoints[edge.id] || [] },
  }));
  return { nodes, edges };
}

/** A live wire shows a count from the run. Missing counts stay unknown. */
export function wireMotion(
  edge: { source: string; target: string },
  events: FlowRunEvent[],
): { active: boolean; label: string } {
  let active = false;
  let counted: number | null = null;
  for (const event of events) {
    if (event.status !== "running") continue;
    if (event.nodeId !== edge.source && event.nodeId !== edge.target) continue;
    active = true;
    if (typeof event.transferred === "number") counted = event.transferred;
  }
  if (!active) return { active: false, label: "" };
  return { active: true, label: counted === null ? "—" : String(counted) };
}
