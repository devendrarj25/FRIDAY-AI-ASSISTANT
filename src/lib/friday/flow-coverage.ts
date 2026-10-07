/**
 * FRIDAY · Flow Studio coverage graph.
 *
 * The registry is generated from the checkout. This module only turns that
 * registry into the one graph model.
 */

import { attachFeeds } from "./flow-bind";
import {
  nodeOf,
  safeFlowId,
  type FlowGraph,
  type FlowGraphNode,
  type FlowNodeKind,
} from "./flow-graph";
import { FLOW_REGISTRY } from "./flow-registry.gen";

export type FlowRegistry = typeof FLOW_REGISTRY;

const NODE_KIND: Record<string, FlowNodeKind> = {
  skill: "skill",
  tool: "tool",
  agent: "agent",
  plugin: "plugin",
  module: "module",
  workflow: "workflow",
  connector: "connector",
  model: "model",
};

function uniqueId(raw: string, used: Set<string>): string {
  let id = safeFlowId(raw);
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let n = 2;
  while (used.has(safeFlowId(`${id}_${n}`))) n += 1;
  id = safeFlowId(`${id}_${n}`);
  used.add(id);
  return id;
}

function push(
  graph: { nodes: FlowGraphNode[]; groups: FlowGraph["groups"] },
  used: Set<string>,
  groupId: string,
  title: string,
  partial: Parameters<typeof nodeOf>[0],
) {
  const id = uniqueId(partial.id, used);
  const node = nodeOf({ ...partial, id });
  graph.nodes.push(node);
  let group = graph.groups.find((item) => item.id === groupId);
  if (!group) {
    group = { id: groupId, title, nodeIds: [] };
    graph.groups.push(group);
  }
  group.nodeIds.push(id);
}

export function coverageGraph(registry: FlowRegistry = FLOW_REGISTRY): FlowGraph {
  const used = new Set<string>();
  const graph = {
    version: 1 as const,
    id: "architecture",
    title: "Architecture map",
    trusted: true,
    enabled: true,
    nodes: [] as FlowGraphNode[],
    edges: [],
    groups: [] as FlowGraph["groups"],
  };

  for (const route of registry.routes) {
    push(graph, used, "routes", "Routes", {
      id: `route.${route.path}`,
      kind: "module",
      label: route.path,
      module: route.file,
      layer: "routes",
      status: route.feature || route.exempt ? "unknown" : "unwired",
      detail: route.feature
        ? `Flow view ${route.feature}.`
        : route.exempt
          ? "Exempt from a Flow view."
          : "No Flow view is mapped.",
      source: { adapter: "route", ref: route.path },
    });
  }

  for (const option of registry.options) {
    push(graph, used, "options", "Settings", {
      id: `option.${option}`,
      kind: "module",
      label: option,
      module: "src/lib/friday/preferences.ts",
      layer: "options",
      detail: "Setting. The stored value is not copied onto the chart.",
      source: { adapter: "option", ref: option },
    });
  }

  for (const item of registry.capabilities) {
    const kind = NODE_KIND[item.kind] || "module";
    push(graph, used, `cap-${item.kind}`, item.kind, {
      id: `cap.${item.id}`,
      kind,
      label: item.name,
      module: item.file,
      layer: item.kind,
      detail: `${item.kind}. Health is unknown until a scan runs.`,
      ports: [
        { id: "in", direction: "in", type: item.kind },
        { id: "out", direction: "out", type: item.kind },
      ],
      source: { adapter: "capability", ref: item.id },
    });
  }

  for (const item of registry.ipc) {
    push(graph, used, "ipc", "IPC", {
      id: `ipc.${item.channel}`,
      kind: "module",
      label: item.channel,
      module: item.file,
      layer: "ipc",
      detail: "Electron channel. Arguments are not shown.",
      source: { adapter: "ipc", ref: item.channel },
    });
  }

  for (const item of registry.kernel) {
    push(graph, used, "kernel", "Kernel", {
      id: `kernel.${item.method}.${item.path}`,
      kind: "module",
      label: `${item.method} ${item.path}`,
      module: item.file,
      layer: "kernel",
      detail: "Kernel route.",
      source: { adapter: "kernel", ref: `${item.method} ${item.path}` },
    });
  }

  for (const item of registry.messages) {
    push(graph, used, "messages", "Messages", {
      id: `message.${item.kind}`,
      kind: "module",
      label: item.kind,
      module: item.file,
      layer: "messages",
      detail: "Message kind read from the kernel source.",
      source: { adapter: "message", ref: item.kind },
    });
  }

  for (const name of registry.workflows) {
    push(graph, used, "ci", "GitHub workflows", {
      id: `ci.${name}`,
      kind: "workflow",
      label: name,
      module: `.github/workflows/${name}.yml`,
      layer: "ci",
      detail: "Workflow file. This map does not run it.",
      source: { adapter: "ci", ref: name },
    });
  }

  for (const item of registry.structures) {
    push(graph, used, item.group, item.group, {
      id: item.id,
      kind: "module",
      label: item.label,
      module: item.module,
      layer: item.group,
      status: item.present ? "unknown" : "unwired",
      detail: item.present ? "File is in this tree. Live health is unknown." : "unwired",
      source: { adapter: "structure", ref: item.id },
    });
  }

  return attachFeeds(graph);
}

export function coverageNumbers(registry: FlowRegistry = FLOW_REGISTRY) {
  return registry.counts;
}

export function covered(graph: FlowGraph, adapter: string, ref: string): FlowGraphNode | undefined {
  return graph.nodes.find((node) => node.source.adapter === adapter && node.source.ref === ref);
}
