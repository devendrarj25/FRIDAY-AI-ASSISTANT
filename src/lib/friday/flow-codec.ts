/**
 * FRIDAY · graph to text and back.
 *
 * The canonical JSON is the round trip. Mermaid, DOT, D2, and JSON Canvas
 * stay strict: bad markup does not become a live flow.
 */

import Ajv from "ajv";
import {
  exportD2,
  exportDot,
  exportJsonCanvas,
  exportN8n,
  exportNodeRed,
  importD2,
  importDot,
  importDrawio,
  importExternal,
  importJsonCanvas,
  importSvg,
} from "./flow-depth";
import {
  exportMermaid,
  exportSvg,
  importMermaid,
  nodeOf,
  safeFlowId,
  type FlowGraph,
  type FlowGraphEdge,
  type FlowGraphNode,
  type FlowIssue,
} from "./flow-graph";

function edgeKind(value: string): FlowGraphEdge["kind"] {
  if (value === "data" || value === "event" || value === "approval") return value;
  return "control";
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile({
  type: "object",
  required: ["version", "id", "title", "nodes", "edges"],
  properties: {
    version: { const: 1 },
    id: { type: "string", minLength: 1 },
    title: { type: "string" },
    nodes: { type: "array" },
    edges: { type: "array" },
  },
});

export type CanonicalNode = { id: string; kind: string; label: string };
export type CanonicalEdge = { id: string; source: string; target: string; kind: string };

export function canonical(graph: FlowGraph): {
  id: string;
  title: string;
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
} {
  return {
    id: graph.id,
    title: graph.title,
    nodes: graph.nodes
      .map((node) => ({ id: node.id, kind: node.kind, label: node.label }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: graph.edges
      .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, kind: edge.kind }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function graphToSource(graph: FlowGraph): string {
  return JSON.stringify({ version: 1 as const, ...canonical(graph) });
}

export function validateGraphText(text: string): { ok: boolean; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["That text is not valid JSON."] };
  }
  if (!validateShape(parsed)) {
    return {
      ok: false,
      errors: (validateShape.errors || []).map(
        (error) => `${error.instancePath || "/"} ${error.message}`,
      ),
    };
  }
  return { ok: true, errors: [] };
}

export function sourceToGraph(text: string): { graph: FlowGraph | null; issues: FlowIssue[] } {
  const checked = validateGraphText(text);
  if (!checked.ok)
    return { graph: null, issues: checked.errors.map((message) => ({ code: "schema", message })) };
  const raw = JSON.parse(text) as {
    id: string;
    title: string;
    nodes: CanonicalNode[];
    edges: CanonicalEdge[];
  };
  const nodes: FlowGraphNode[] = raw.nodes.map((node) =>
    nodeOf({
      id: safeFlowId(node.id),
      label: String(node.label || node.id),
      kind: (node.kind as FlowGraphNode["kind"]) || "note",
      source: { adapter: "code", ref: node.id },
    }),
  );
  const ids = new Set(nodes.map((node) => node.id));
  const issues: FlowIssue[] = [];
  const edges = raw.edges.flatMap((edge) => {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issues.push({ code: "dangling", message: `Edge ${edge.id} points at a missing node.` });
      return [];
    }
    return [
      {
        id: safeFlowId(edge.id),
        source: edge.source,
        target: edge.target,
        kind: edgeKind(edge.kind),
      },
    ];
  });
  return {
    graph: {
      version: 1,
      id: safeFlowId(raw.id),
      title: raw.title,
      trusted: true,
      enabled: true,
      nodes,
      edges,
      groups: [],
    },
    issues,
  };
}

/** The owner accepts a disabled import. The import itself stays off until this runs. */
export function acceptImport(graph: FlowGraph): FlowGraph {
  return { ...graph, enabled: true, trusted: false };
}

export function roundTrip(graph: FlowGraph): { same: boolean; issues: FlowIssue[] } {
  const back = sourceToGraph(graphToSource(graph));
  if (!back.graph) return { same: false, issues: back.issues };
  return { same: graphToSource(back.graph) === graphToSource(graph), issues: back.issues };
}

export function importChecked(
  format: "mermaid" | "dot" | "d2" | "json" | "canvas" | "n8n" | "node-red" | "drawio" | "svg",
  text: string,
): { graph: FlowGraph; issues: FlowIssue[] } {
  if (format === "mermaid") return importMermaid(text);
  if (format === "dot") return importDot(text);
  if (format === "d2") return importD2(text);
  if (format === "canvas") return importJsonCanvas(text);
  if (format === "drawio") return importDrawio(text);
  if (format === "svg") return importSvg(text);
  if (format === "json") {
    const own = sourceToGraph(text);
    if (own.graph)
      return { graph: { ...own.graph, trusted: false, enabled: false }, issues: own.issues };
    return importExternal("json", text);
  }
  return importExternal(format, text);
}

export function exportChecked(
  format: "mermaid" | "dot" | "d2" | "canvas" | "json" | "n8n" | "node-red" | "svg",
  graph: FlowGraph,
): string {
  if (format === "mermaid") return exportMermaid(graph);
  if (format === "dot") return exportDot(graph);
  if (format === "d2") return exportD2(graph);
  if (format === "canvas") return exportJsonCanvas(graph);
  if (format === "n8n") return exportN8n(graph);
  if (format === "node-red") return exportNodeRed(graph);
  if (format === "svg") return exportSvg(graph);
  return graphToSource(graph);
}

export async function renderDot(
  dot: string,
): Promise<{ ok: boolean; svg: string; reason: string }> {
  try {
    const viz = await import("@viz-js/viz");
    const engine = await viz.instance();
    const result = engine.render(dot, { format: "svg" });
    if (result.status !== "success" || typeof result.output !== "string") {
      return { ok: false, svg: "", reason: "Graphviz could not draw that DOT." };
    }
    if (result.output.includes("<script"))
      return { ok: false, svg: "", reason: "The drawing contained a script." };
    return { ok: true, svg: result.output, reason: "" };
  } catch (error) {
    return {
      ok: false,
      svg: "",
      reason: error instanceof Error ? error.message : "Graphviz did not load.",
    };
  }
}
