/**
 * FRIDAY · flow adapters.
 *
 * Every graph is built from a real registry. A box with no file is unwired.
 */

import { inferBinding } from "./flow-bind";
import { FLOW_CHART, flowNodes, type FlowNode } from "./flow-chart";
import {
  explainGraph,
  nodeOf,
  parseFlowCommand,
  type FlowGraph,
  type FlowGraphNode,
  type FlowRisk,
} from "./flow-graph";
import { LOCKED_WIRING_NODE_IDS } from "./wiring";

export type CapabilityFlowItem = {
  id: string;
  name: string;
  kind: FlowGraphNode["kind"];
  module?: string;
  risk?: FlowRisk;
  summary?: string;
  permissions?: string[];
  inputs?: string[];
  outputs?: string[];
  health?: string;
};

const locked = new Set<string>(LOCKED_WIRING_NODE_IDS);

export function graphFromFlowChart(
  fileExists: (modulePath: string) => boolean = () => true,
): FlowGraph {
  const nodes: FlowGraphNode[] = [];
  const groups = FLOW_CHART.map((layer) => ({
    id: layer.id,
    title: layer.title,
    nodeIds: layer.nodes.map((item) => item.id),
  }));
  for (const layer of FLOW_CHART) {
    for (const item of layer.nodes) {
      const present = Boolean(item.module) && fileExists(item.module);
      nodes.push(
        nodeOf({
          id: item.id,
          kind: "module",
          label: item.label,
          layer: layer.id,
          module: item.module,
          status: present ? "unknown" : "unwired",
          locked: locked.has(item.id),
          detail: present
            ? item.detail
            : "unwired — the chart names a file that is not in this tree",
          source: { adapter: "flow-chart", ref: item.id },
        }),
      );
    }
  }
  const edges = chainEdges(nodes);
  return {
    version: 1,
    id: "master",
    title: "Master flow",
    trusted: true,
    enabled: true,
    nodes,
    edges,
    groups,
  };
}

function chainGraph(nodes: FlowGraphNode[]): FlowGraph {
  return {
    version: 1,
    id: "chain",
    title: "chain",
    trusted: true,
    enabled: true,
    nodes,
    edges: [],
    groups: [],
  };
}

function chainEdges(nodes: FlowGraphNode[]): FlowGraph["edges"] {
  const edges: FlowGraph["edges"] = [];
  const layers = new Map<string, FlowGraphNode[]>();
  for (const node of nodes) {
    const key = node.layer || "default";
    const list = layers.get(key) || [];
    list.push(node);
    layers.set(key, list);
  }
  const order = [...layers.keys()];
  order.forEach((key, index) => {
    const list = layers.get(key) || [];
    for (let i = 1; i < list.length; i += 1) {
      const source = list[i - 1]!.id;
      const target = list[i]!.id;
      edges.push({
        id: `c-${source}-${target}`,
        source,
        target,
        kind: "control",
        binding: inferBinding(chainGraph(nodes), source, target),
      });
    }
    const next = layers.get(order[index + 1] || "");
    if (list[0] && next?.[0]) {
      edges.push({
        id: `l-${list[0].id}-${next[0].id}`,
        source: list[0].id,
        target: next[0].id,
        kind: "control",
        binding: inferBinding(chainGraph(nodes), list[0].id, next[0].id),
      });
    }
  });
  return edges;
}

const FEATURE_LAYERS: Record<string, string[]> = {
  master: [],
  voice: ["voice-runtime", "experience"],
  chat: ["entry", "experience"],
  memory: ["memory"],
  brain: ["thinking", "supervisor", "orchestrator"],
  doctor: ["verification"],
  models: ["model-router"],
  skills: ["capability-bus", "agents"],
  tools: ["capability-bus", "execution"],
  agents: ["agents"],
  modules: ["capability-bus"],
  plugins: ["capability-bus"],
  connectors: ["capability-bus"],
  workflows: ["task-runtime"],
  update: ["improvement"],
  install: ["improvement"],
  logs: ["experience"],
  status: ["verification"],
  tasks: ["task-runtime"],
  settings: ["owner"],
  n8n: ["task-runtime"],
  browser: ["experience"],
  devices: ["capability-bus"],
  hub: ["improvement"],
  import: ["improvement"],
  projects: ["task-runtime"],
  workspace: ["task-runtime"],
  sandbox: ["execution"],
  terminal: ["execution"],
  governance: ["permission", "owner"],
};

export function graphForFeature(
  feature: string,
  fileExists?: (modulePath: string) => boolean,
): FlowGraph {
  const full = graphFromFlowChart(fileExists);
  if (feature === "master") return full;
  const layers = FEATURE_LAYERS[feature];
  if (!layers?.length) {
    return {
      version: 1,
      id: feature,
      title: feature,
      trusted: true,
      enabled: true,
      nodes: [
        nodeOf({
          id: "page.unwired",
          kind: "note",
          label: feature,
          status: "unwired",
          detail: "No chart box is bound to this page yet.",
          source: { adapter: "feature", ref: feature },
        }),
      ],
      edges: [],
      groups: [],
    };
  }
  const nodes = full.nodes.filter((node) => layers.includes(node.layer || ""));
  if (!nodes.length) {
    return graphForFeature("unbound", fileExists);
  }
  return {
    ...full,
    id: feature,
    title: `${feature} flow`,
    nodes,
    edges: full.edges.filter(
      (edge) =>
        nodes.some((node) => node.id === edge.source) &&
        nodes.some((node) => node.id === edge.target),
    ),
    groups: full.groups.filter((group) => layers.includes(group.id)),
  };
}

export function graphFromCapabilities(kind: string, items: CapabilityFlowItem[]): FlowGraph {
  const used = new Set<string>();
  const nodes = items.map((item, index) => {
    const present = Boolean(item.module);
    let id = item.id.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 72) || "item";
    if (used.has(id)) id = `${id}_${index}`.slice(0, 80);
    used.add(id);
    return nodeOf({
      id,
      kind: item.kind,
      label: item.name,
      ...(item.module ? { module: item.module } : {}),
      status: present ? "unknown" : "unwired",
      risk: item.risk || "safe",
      detail: [
        item.summary || "unknown",
        item.permissions?.length
          ? `permissions ${item.permissions.join(", ")}`
          : "permissions unknown",
        item.inputs?.length ? `inputs ${item.inputs.join(", ")}` : "inputs unknown",
        item.health ? `health ${item.health}` : "health unknown",
      ].join(". "),
      source: { adapter: kind, ref: item.id },
    });
  });
  return {
    version: 1,
    id: kind,
    title: `${kind} flow`,
    trusted: true,
    enabled: true,
    nodes,
    edges: chainEdges(nodes.map((node) => ({ ...node, layer: kind }))),
    groups: [{ id: kind, title: kind, nodeIds: nodes.map((node) => node.id) }],
  };
}

export function unresolvedNodes(
  graph: FlowGraph,
  fileExists: (modulePath: string) => boolean,
): string[] {
  return graph.nodes
    .filter((node) => node.module && !fileExists(node.module))
    .map((node) => node.id);
}

export const FLOW_PAGE_FEATURES: Record<string, string> = {
  "/": "master",
  "/memory": "memory",
  "/library": "memory",
  "/system": "status",
  "/browser": "browser",
  "/devices": "devices",
  "/skills": "skills",
  "/tools": "tools",
  "/agents": "agents",
  "/modules": "modules",
  "/plugins": "plugins",
  "/connectors": "connectors",
  "/workflows": "workflows",
  "/workflow-visual": "workflows",
  "/n8n": "n8n",
  "/brain": "brain",
  "/logs": "logs",
  "/status": "status",
  "/tasks": "tasks",
  "/models": "models",
  "/install-manager": "install",
  "/doctor": "doctor",
  "/settings": "settings",
  "/self-management": "governance",
  "/character": "voice",
  "/hub": "hub",
  "/import": "import",
  "/projects": "projects",
  "/workspace": "workspace",
  "/sandbox": "sandbox",
  "/terminal": "terminal",
};

/** A route may omit a Flow view only with a reason. None are exempt. */
export const ROUTE_FLOW_EXEMPTIONS: { path: string; reason: string }[] = [];

export function featureForPath(pathname: string): string {
  return FLOW_PAGE_FEATURES[pathname] || "master";
}

export function answerFlowCommand(
  text: string,
  fileExists: (modulePath: string) => boolean = () => true,
): { feature: string; action: string; text: string } {
  const command = parseFlowCommand(text);
  if (command.action === "none") {
    return { feature: "master", action: "none", text: "" };
  }
  const graph = graphForFeature(command.feature, fileExists);
  const body = explainGraph(graph, text);
  const watch =
    command.action === "watch"
      ? "\nLive marks appear only after a turn records them. Until then the status stays unknown."
      : "";
  return { feature: command.feature, action: command.action, text: `${body}${watch}` };
}

export function chartNode(id: string): FlowNode | undefined {
  return flowNodes().find((node) => node.id === id);
}
