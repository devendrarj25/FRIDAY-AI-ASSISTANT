/**
 * FRIDAY · layered layout.
 *
 * Auto-layout is explicit. It does not run on every paint, and a locked
 * box keeps the coordinates the owner set.
 */

import ElkBundled from "elkjs/lib/elk.bundled.js";
import { layoutFlowGraph, type FlowGraph, type LaidOut } from "./flow-graph";

type ElkNode = { id: string; x?: number; y?: number; width?: number; height?: number };
type ElkApi = {
  layout: (graph: {
    id: string;
    layoutOptions?: Record<string, string>;
    children: { id: string; width: number; height: number }[];
    edges: { id: string; sources: string[]; targets: string[] }[];
  }) => Promise<{ children?: ElkNode[] }>;
};

async function loadElk(): Promise<ElkApi> {
  return new ElkBundled();
}

export async function layoutWithElk(
  graph: FlowGraph,
  now = () => performance.now(),
): Promise<{ positions: LaidOut[]; ms: number; engine: "elk" | "swimlane" }> {
  const start = now();
  try {
    const elk = await loadElk();
    const laid = await elk.layout({
      id: graph.id || "flow",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": "24",
      },
      children: graph.nodes.map((node) => ({ id: node.id, width: 168, height: 64 })),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    });
    const positions = (laid.children || [])
      .filter((child) => graph.nodes.some((node) => node.id === child.id))
      .map((child) => ({ id: child.id, x: child.x || 0, y: child.y || 0 }));
    if (positions.length !== graph.nodes.length) throw new Error("Layout missed a box.");
    return { positions, ms: now() - start, engine: "elk" };
  } catch {
    const fallback = layoutFlowGraph(graph, now);
    return { positions: fallback.positions, ms: now() - start, engine: "swimlane" };
  }
}
