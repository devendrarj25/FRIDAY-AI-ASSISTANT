/**
 * FRIDAY · one flow graph.
 *
 * Renderer-agnostic. React Flow draws this model; it does not own it.
 * Workflow packs compile into the same steps[] the existing engine runs.
 */

import { load as loadYaml } from "js-yaml";
import { looksSensitive } from "./brain/memory-policy";
import { redactRunText } from "./self/run-receipt";

export const FLOW_GRAPH_VERSION = 1 as const;

/** Live events kept on this PC. Older lines are dropped. The owner can clear them. */
export const FLOW_RETENTION_CAP = 200;

export const NODE_KINDS = [
  "layer",
  "module",
  "skill",
  "tool",
  "agent",
  "plugin",
  "pack",
  "connector",
  "workflow",
  "model",
  "note",
  "approval",
  "condition",
  "parallel",
  "loop",
  "trigger",
  "subflow",
  "error",
] as const;

export const EDGE_KINDS = ["data", "control", "approval", "event"] as const;

export const NODE_STATUSES = [
  "idle",
  "queued",
  "running",
  "ok",
  "failed",
  "blocked",
  "awaiting-approval",
  "dry-run",
  "unknown",
  "unwired",
  "disabled",
] as const;

export const RISK_RANK = { safe: 0, write: 1, exec: 2 } as const;

export type FlowNodeKind = (typeof NODE_KINDS)[number];
export type FlowEdgeKind = (typeof EDGE_KINDS)[number];
export type FlowNodeStatus = (typeof NODE_STATUSES)[number];
export type FlowRisk = keyof typeof RISK_RANK;
export type FlowPrivacy = "public" | "standard" | "sensitive";
export type FlowWhen = "always" | "previous-ok" | "previous-failed";

export type FlowPort = { id: string; direction: "in" | "out"; type: string };

export type FlowGraphNode = {
  id: string;
  kind: FlowNodeKind;
  label: string;
  layer?: string;
  module?: string;
  status: FlowNodeStatus;
  risk: FlowRisk;
  privacy: FlowPrivacy;
  locked?: boolean;
  enabled?: boolean;
  approvesSelf?: boolean;
  ports: FlowPort[];
  detail: string;
  source: { adapter: string; ref: string };
};

export const BINDING_KINDS = [
  "workflow",
  "router",
  "auto",
  "capability",
  "setting",
  "event",
  "voice",
  "memory",
  "update",
  "descriptive",
] as const;

export type FlowBindingKind = (typeof BINDING_KINDS)[number];

/** A wire's link to a real FRIDAY module. `real` is false while the wire only describes the code. */
export type FlowBinding = {
  kind: FlowBindingKind;
  ref: string;
  value: string;
  real: boolean;
  /** False when this wire cannot change FRIDAY. A reason is shown on the canvas. */
  bindable?: boolean;
  reason?: string;
};

export type FlowGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: FlowEdgeKind;
  sourcePort?: string;
  targetPort?: string;
  when?: FlowWhen;
  label?: string;
  binding?: FlowBinding;
};

export type FlowGroup = { id: string; title: string; nodeIds: string[] };

export type FlowGraph = {
  version: typeof FLOW_GRAPH_VERSION;
  id: string;
  title: string;
  trusted: boolean;
  enabled?: boolean;
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  groups: FlowGroup[];
  budget?: { maxNodes: number; maxSteps: number };
};

export type FlowIssue = { code: string; nodeId?: string; message: string };

export type FlowRunEvent = {
  generation: number;
  nodeId: string;
  status: FlowNodeStatus;
  at: number;
  detail?: string;
  ms?: number;
  tokens?: number;
  cost?: number;
  /** Items moved across this step. Missing means the run did not count them. */
  transferred?: number;
};

export type CompiledStep = {
  id: string;
  label: string;
  kind: string;
  ref: string;
  risk: FlowRisk;
  when?: FlowWhen;
  parallel?: string;
  loopMax?: number;
  onError?: "stop" | "continue";
  approvesSelf?: boolean;
};

const ID_OK = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Stable short checksum for a flow pack. This is not a signature. */
export function flowHash(text: string): string {
  let hash = 0x811c9dc5;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function safeFlowId(raw: string): string {
  let id = String(raw || "node").replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (!/^[A-Za-z_]/.test(id)) id = `n_${id}`;
  if (id.length > 80) id = `${id.slice(0, 68)}_${flowHash(raw)}`.slice(0, 80);
  return id;
}

export type WatchStep = {
  kind: "click" | "type" | "launch" | "focus" | "hotkey" | "scroll";
  target: string;
  payload?: string;
  role?: string;
};

const SECRET_STEP = /password|payment|captcha|credential/i;

function watchLine(step: WatchStep): string {
  if (step.kind === "type") return `type ${step.payload || ""} into ${step.target}`;
  if (step.kind === "launch") return `launch ${step.target}`;
  if (step.kind === "focus") return `focus ${step.target}`;
  if (step.kind === "hotkey") return `press ${step.target}`;
  if (step.kind === "scroll") return `scroll ${step.target}`;
  return `click ${step.target}`;
}

function watchKeeps(step: WatchStep): boolean {
  if (SECRET_STEP.test(step.role || "") || SECRET_STEP.test(step.target)) return false;
  if (looksSensitive(step.payload || "")) return false;
  if (looksSensitive(watchLine(step))) return false;
  return true;
}

/**
 * An owner-started demonstration becomes one editable graph.
 * No consent, no graph. A password or secret step is left out.
 */
export type WatchSession = { consent: boolean; steps: WatchStep[] };

/** Owner-started. Consent is on until it is revoked, and a revoke drops the steps. */
export function openWatch(): WatchSession {
  return { consent: true, steps: [] };
}

export function pushWatch(session: WatchSession, step: WatchStep): WatchSession {
  if (!session.consent) return session;
  return { consent: true, steps: [...session.steps, step] };
}

export function revokeWatch(session: WatchSession): WatchSession {
  return { consent: false, steps: [] };
}

export function graphFromWatch(
  steps: WatchStep[],
  options: { consent: boolean; id?: string; title?: string },
): { ok: true; graph: FlowGraph; request: string } | { ok: false; reason: "consent" | "empty" } {
  if (!options.consent) return { ok: false, reason: "consent" };
  const kept = steps.filter(watchKeeps);
  if (!kept.length) return { ok: false, reason: "empty" };
  const graph = emptyGraph(options.id || "watch", options.title || "Watched steps");
  graph.trusted = false;
  kept.forEach((step, index) => {
    const id = safeFlowId(`step_${index + 1}`);
    const line = redactRunText(watchLine(step));
    graph.nodes.push(
      nodeOf({
        id,
        kind: "tool",
        label: redactRunText(step.target).slice(0, 68) || id,
        status: "idle",
        risk: step.kind === "click" || step.kind === "type" ? "write" : "safe",
        privacy: "standard",
        detail: line,
        source: { adapter: "demonstration", ref: id },
      }),
    );
    if (index > 0) {
      const prev = safeFlowId(`step_${index}`);
      graph.edges.push({ id: `e${index}`, source: prev, target: id, kind: "control" });
    }
  });
  return {
    ok: true,
    graph,
    request: kept.map((step) => redactRunText(watchLine(step))).join("\n"),
  };
}

export function emptyGraph(id: string, title: string): FlowGraph {
  return {
    version: FLOW_GRAPH_VERSION,
    id,
    title,
    trusted: true,
    enabled: true,
    nodes: [],
    edges: [],
    groups: [],
  };
}

export function nodeOf(
  partial: Partial<FlowGraphNode> & Pick<FlowGraphNode, "id" | "label" | "kind">,
): FlowGraphNode {
  return {
    status: "unknown",
    risk: "safe",
    privacy: "public",
    ports: [
      { id: "in", direction: "in", type: "any" },
      { id: "out", direction: "out", type: "any" },
    ],
    detail: "",
    source: { adapter: "manual", ref: partial.id },
    ...partial,
  };
}

function asRisk(value: unknown): FlowRisk {
  return value === "write" || value === "exec" ? value : "safe";
}

function asWhen(value: unknown): FlowWhen | undefined {
  return value === "previous-ok" || value === "previous-failed" || value === "always"
    ? value
    : undefined;
}

/** Older step lists become a version-1 graph. Unknown versions are refused. */
export function migrateFlowDocument(raw: unknown): {
  graph: FlowGraph | null;
  issues: FlowIssue[];
} {
  if (!raw || typeof raw !== "object") {
    return { graph: null, issues: [{ code: "empty", message: "Nothing to migrate." }] };
  }
  const doc = raw as Record<string, unknown>;
  if (doc["version"] === 1 && Array.isArray(doc["nodes"])) {
    const graph = doc as unknown as FlowGraph;
    return { graph, issues: validateFlowGraph(graph) };
  }
  const schemaVersion = Number(doc["schemaVersion"] || 1);
  if (schemaVersion > 2) {
    return {
      graph: null,
      issues: [{ code: "version", message: `Schema ${schemaVersion} is not supported.` }],
    };
  }
  if (!Array.isArray(doc["steps"])) {
    return { graph: null, issues: [{ code: "shape", message: "Expected nodes or steps." }] };
  }
  return {
    graph: stepsToGraph(
      doc["steps"],
      String(doc["id"] || "workflow"),
      String(doc["name"] || "Workflow"),
    ),
    issues: [],
  };
}

export function stepsToGraph(steps: unknown[], id: string, title: string): FlowGraph {
  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraphEdge[] = [];
  const list = Array.isArray(steps) ? steps : [];
  list.forEach((item, index) => {
    const rec = (item && typeof item === "object" ? item : { label: String(item) }) as Record<
      string,
      unknown
    >;
    const stepId = String(rec["id"] || `s${index + 1}`);
    const when = asWhen(rec["when"]);
    const modulePath = typeof rec["module"] === "string" ? rec["module"] : "";
    nodes.push(
      nodeOf({
        id: ID_OK.test(stepId) ? stepId : `s${index + 1}`,
        kind: kindOf(String(rec["kind"] || "note")),
        label: String(rec["label"] || stepId).slice(0, 200),
        status: "idle",
        risk: asRisk(rec["risk"]),
        ...(modulePath ? { module: modulePath } : {}),
        detail: String(rec["detail"] || ""),
        approvesSelf: rec["approvesSelf"] === true,
        source: { adapter: "workflow", ref: stepId },
      }),
    );
    if (index > 0) {
      const prev = nodes[index - 1]!;
      const edgeWhen = when && when !== "always" ? when : null;
      edges.push({
        id: `e-${prev.id}-${nodes[index]!.id}`,
        source: prev.id,
        target: nodes[index]!.id,
        kind: when === "previous-failed" ? "event" : "control",
        ...(edgeWhen ? { when: edgeWhen } : {}),
      });
    }
  });
  return {
    version: 1,
    id: id.slice(0, 80) || "workflow",
    title: title.slice(0, 160) || "Workflow",
    trusted: true,
    enabled: true,
    nodes,
    edges,
    groups: [{ id: "steps", title: "Steps", nodeIds: nodes.map((node) => node.id) }],
  };
}

function kindOf(value: string): FlowNodeKind {
  return (NODE_KINDS as readonly string[]).includes(value) ? (value as FlowNodeKind) : "note";
}

export function validateFlowGraph(graph: FlowGraph): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (graph.version !== 1)
    issues.push({ code: "version", message: "Only graph version 1 is supported." });
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!ID_OK.test(node.id))
      issues.push({ code: "id", nodeId: node.id, message: "Node id is not safe." });
    if (ids.has(node.id))
      issues.push({ code: "duplicate", nodeId: node.id, message: "Duplicate node id." });
    ids.add(node.id);
    if (node.approvesSelf && node.risk === "exec") {
      issues.push({
        code: "self-approve",
        nodeId: node.id,
        message: "An exec step cannot approve itself.",
      });
    }
    if (
      !node.module &&
      node.status !== "unwired" &&
      node.kind !== "note" &&
      node.source.adapter !== "workflow" &&
      node.source.adapter !== "mermaid"
    ) {
      issues.push({
        code: "unwired",
        nodeId: node.id,
        message: `${node.label} has no module. It stays unwired.`,
      });
    }
  }
  const budget = graph.budget?.maxNodes;
  if (budget && graph.nodes.length > budget) {
    issues.push({
      code: "budget",
      message: `Graph has ${graph.nodes.length} nodes; budget is ${budget}.`,
    });
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issues.push({ code: "dangling", message: `Edge ${edge.id} points at a missing node.` });
      continue;
    }
    const from = graph.nodes.find((node) => node.id === edge.source);
    const to = graph.nodes.find((node) => node.id === edge.target);
    const out = from?.ports.find((port) => port.id === (edge.sourcePort || "out"));
    const inn = to?.ports.find((port) => port.id === (edge.targetPort || "in"));
    if (out && inn && out.type !== "any" && inn.type !== "any" && out.type !== inn.type) {
      issues.push({
        code: "port",
        nodeId: edge.target,
        message: `${from?.label} outputs ${out.type}, but ${to?.label} expects ${inn.type}.`,
      });
    }
  }
  const cycles = findCycles(graph);
  for (const cycle of cycles) {
    issues.push({ code: "cycle", message: `Cycle: ${cycle.join(" → ")}.` });
  }
  const reachable = reachableFromRoots(graph);
  for (const node of graph.nodes) {
    if (graph.nodes.length > 1 && !reachable.has(node.id)) {
      issues.push({
        code: "unreachable",
        nodeId: node.id,
        message: `${node.label} is not reachable.`,
      });
    }
  }
  return issues;
}

function findCycles(graph: FlowGraph): string[][] {
  const next = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "event") continue;
    const list = next.get(edge.source) || [];
    list.push(edge.target);
    next.set(edge.source, list);
  }
  const seen = new Set<string>();
  const stack = new Set<string>();
  const found: string[][] = [];
  const walk = (id: string, path: string[]) => {
    if (stack.has(id)) {
      const at = path.indexOf(id);
      found.push(path.slice(at).concat(id));
      return;
    }
    if (seen.has(id)) return;
    stack.add(id);
    for (const child of next.get(id) || []) walk(child, path.concat(id));
    stack.delete(id);
    seen.add(id);
  };
  for (const node of graph.nodes) walk(node.id, []);
  return found.slice(0, 5);
}

function reachableFromRoots(graph: FlowGraph): Set<string> {
  const incoming = new Set(graph.edges.map((edge) => edge.target));
  const roots = graph.nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
  const start = roots.length ? roots : graph.nodes.slice(0, 1).map((node) => node.id);
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.edges) if (edge.source === id) queue.push(edge.target);
  }
  return seen;
}

export function riskTier(graph: FlowGraph): FlowRisk {
  return graph.nodes.reduce<FlowRisk>((tier, node) => {
    return RISK_RANK[node.risk] > RISK_RANK[tier] ? node.risk : tier;
  }, "safe");
}

/** A later graph may not drop a lock or quietly lower a risk. */
export function validateEdit(before: FlowGraph, after: FlowGraph): FlowIssue[] {
  const issues = validateFlowGraph(after);
  const prior = new Map(before.nodes.map((node) => [node.id, node]));
  for (const [id, node] of prior) {
    const next = after.nodes.find((item) => item.id === id);
    if (node.locked && !next) {
      issues.push({
        code: "locked",
        nodeId: id,
        message: `${node.label} is locked and cannot be removed.`,
      });
      continue;
    }
    if (!next) continue;
    if (
      node.locked &&
      (next.label !== node.label || next.module !== node.module || next.risk !== node.risk)
    ) {
      issues.push({ code: "locked", nodeId: id, message: `${node.label} is locked.` });
    }
    if (RISK_RANK[next.risk] < RISK_RANK[node.risk]) {
      issues.push({
        code: "invariant",
        nodeId: id,
        message: `${node.label} cannot drop from ${node.risk} to ${next.risk}.`,
      });
    }
  }
  return issues;
}

export type LaidOut = { id: string; x: number; y: number };

/** Swimlanes by group. One pass, no layout library. */
export function layoutFlowGraph(
  graph: FlowGraph,
  now = () => performance.now(),
): {
  positions: LaidOut[];
  ms: number;
} {
  const start = now();
  const columns = 6;
  const positions: LaidOut[] = [];
  const placed = new Set<string>();
  const groups = graph.groups.length
    ? graph.groups
    : [{ id: "all", title: graph.title, nodeIds: graph.nodes.map((node) => node.id) }];
  groups.forEach((group, lane) => {
    group.nodeIds.forEach((id, index) => {
      placed.add(id);
      const col = index % columns;
      const row = Math.floor(index / columns);
      positions.push({ id, x: 24 + col * 200, y: 24 + lane * 160 + row * 88 });
    });
  });
  graph.nodes.forEach((node, index) => {
    if (placed.has(node.id)) return;
    positions.push({ id: node.id, x: 24 + (index % columns) * 200, y: 24 + groups.length * 160 });
  });
  return { positions, ms: now() - start };
}

export function impactOf(
  graph: FlowGraph,
  nodeId: string,
): {
  callers: string[];
  calls: string[];
  breaks: string[];
} {
  const callers = graph.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  const calls = graph.edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target);
  return { callers, calls, breaks: calls };
}

export function redactFlowText(text: string): string {
  const value = String(text || "");
  if (!value) return "";
  if (looksSensitive(value)) return "SENSITIVE";
  return value;
}

export function applyRunEvents(
  graph: FlowGraph,
  events: FlowRunEvent[],
  activeGeneration: number,
): { graph: FlowGraph; ignored: number } {
  let ignored = 0;
  const nodes = graph.nodes.map((node) => ({ ...node }));
  for (const event of events) {
    if (event.generation !== activeGeneration) {
      ignored += 1;
      continue;
    }
    const node = nodes.find((item) => item.id === event.nodeId);
    if (!node) {
      ignored += 1;
      continue;
    }
    node.status = event.status;
    if (event.detail) node.detail = redactFlowText(event.detail);
  }
  return { graph: { ...graph, nodes }, ignored };
}

/** Read-only. This function has no host and cannot execute a step. */
export function replayRun(graph: FlowGraph, events: FlowRunEvent[], generation: number): FlowGraph {
  return applyRunEvents(graph, events, generation).graph;
}

/**
 * Walk a graph with fixture outcomes. No host is called.
 * `now` is a fake clock the caller owns.
 */
export function simulateFlow(
  graph: FlowGraph,
  outcomes: Record<string, boolean>,
  now: () => number = () => 0,
): Array<{ id: string; status: FlowNodeStatus; at: number }> {
  const steps = graphToSteps(graph);
  const log: Array<{ id: string; status: FlowNodeStatus; at: number }> = [];
  let previousOk = true;
  for (const step of steps) {
    if (step.when === "previous-ok" && !previousOk) {
      log.push({ id: step.id, status: "blocked", at: now() });
      continue;
    }
    if (step.when === "previous-failed" && previousOk) {
      log.push({ id: step.id, status: "blocked", at: now() });
      continue;
    }
    if (step.approvesSelf && step.risk === "exec") {
      log.push({ id: step.id, status: "failed", at: now() });
      previousOk = false;
      continue;
    }
    const ok = outcomes[step.id] !== false;
    log.push({ id: step.id, status: ok ? "dry-run" : "failed", at: now() });
    previousOk = ok;
  }
  return log;
}

export function graphToSteps(graph: FlowGraph): CompiledStep[] {
  const order = topo(graph);
  const parallelOf = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === "parallel") {
      for (const edge of graph.edges.filter((item) => item.source === node.id)) {
        parallelOf.set(edge.target, node.id);
      }
    }
  }
  return order.map((node) => {
    const incoming = graph.edges.find((edge) => edge.target === node.id && edge.when);
    const parallel = parallelOf.get(node.id);
    const step: CompiledStep = {
      id: node.id,
      label: node.label,
      kind: node.kind === "module" ? "note" : node.kind,
      ref: node.source.ref || node.id,
      risk: node.risk,
    };
    if (incoming?.when) step.when = incoming.when;
    if (parallel) step.parallel = parallel;
    if (node.approvesSelf) step.approvesSelf = true;
    return step;
  });
}

function topo(graph: FlowGraph): FlowGraphNode[] {
  const incoming = new Map<string, number>();
  for (const node of graph.nodes) incoming.set(node.id, 0);
  for (const edge of graph.edges) {
    if (edge.kind === "event") continue;
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
  }
  const queue = graph.nodes.filter((node) => (incoming.get(node.id) || 0) === 0);
  const out: FlowGraphNode[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  while (queue.length) {
    const node = queue.shift()!;
    out.push(node);
    for (const edge of graph.edges.filter(
      (item) => item.source === node.id && item.kind !== "event",
    )) {
      const left = (incoming.get(edge.target) || 1) - 1;
      incoming.set(edge.target, left);
      if (left === 0) {
        const next = byId.get(edge.target);
        if (next) queue.push(next);
      }
    }
  }
  for (const node of graph.nodes) if (!out.includes(node)) out.push(node);
  return out;
}

const MERMAID_BAD = /click\b|href\b|javascript:|<\/|classDef\b|<script|on\w+=/i;

export function exportMermaid(graph: FlowGraph): string {
  const lines = ["flowchart TD"];
  for (const node of graph.nodes) {
    lines.push(`  ${safeId(node.id)}["${escapeMermaid(node.label)}"]`);
  }
  for (const edge of graph.edges) {
    const mark = edge.when === "previous-failed" ? "-.->" : "-->";
    lines.push(`  ${safeId(edge.source)} ${mark} ${safeId(edge.target)}`);
  }
  return lines.join("\n");
}

function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n_${cleaned}`;
}

function escapeMermaid(label: string): string {
  return label.replace(/["\\<>]/g, "");
}

/** Imported text is untrusted and stays disabled until the owner enables it. */
export function importMermaid(text: string): { graph: FlowGraph; issues: FlowIssue[] } {
  const source = String(text || "");
  const issues: FlowIssue[] = [];
  if (MERMAID_BAD.test(source)) {
    issues.push({ code: "untrusted", message: "That diagram contains markup and was refused." });
  }
  const header = /^\s*(flowchart|graph)\s+(TD|LR|TB|BT|RL)\b/im.test(source);
  if (!header)
    issues.push({ code: "syntax", message: "Only a simple flowchart header is accepted." });
  const labels = new Map<string, string>();
  for (const match of source.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*"?([^\]"]+)"?\s*\]/g)) {
    labels.set(match[1]!, match[2]!.trim());
  }
  const links: Array<{ from: string; to: string }> = [];
  for (const match of source.matchAll(
    /([A-Za-z_][A-Za-z0-9_]*)\s*-+>+\s*([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    links.push({ from: match[1]!, to: match[2]! });
    if (!labels.has(match[1]!)) labels.set(match[1]!, match[1]!);
    if (!labels.has(match[2]!)) labels.set(match[2]!, match[2]!);
  }
  const nodes = [...labels.entries()].map(([id, label]) =>
    nodeOf({
      id: `m_${id}`.slice(0, 80),
      kind: "note",
      label: label.slice(0, 200),
      status: "disabled",
      enabled: false,
      detail: "Imported diagram. Disabled until you enable it.",
      source: { adapter: "mermaid", ref: id },
    }),
  );
  const idOf = (raw: string) => `m_${raw}`.slice(0, 80);
  const edges: FlowGraphEdge[] = links.map((link, index) => ({
    id: `me${index + 1}`,
    source: idOf(link.from),
    target: idOf(link.to),
    kind: "control",
  }));
  const graph: FlowGraph = {
    version: 1,
    id: "mermaid-import",
    title: "Imported flowchart",
    trusted: false,
    enabled: false,
    nodes,
    edges,
    groups: [{ id: "import", title: "Import", nodeIds: nodes.map((node) => node.id) }],
  };
  if (!nodes.length) issues.push({ code: "empty", message: "No nodes were found." });
  return { graph, issues };
}

export function exportSvg(graph: FlowGraph): string {
  const { positions } = layoutFlowGraph(graph, () => 0);
  const width = 1200;
  const height = Math.max(
    200,
    positions.reduce((max, item) => Math.max(max, item.y + 80), 0),
  );
  const byId = new Map(positions.map((item) => [item.id, item]));
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  for (const edge of graph.edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    parts.push(
      `<line x1="${a.x + 80}" y1="${a.y + 24}" x2="${b.x + 80}" y2="${b.y + 24}" fill="none" stroke="currentColor"/>`,
    );
  }
  for (const node of graph.nodes) {
    const at = byId.get(node.id);
    if (!at) continue;
    parts.push(
      `<g><rect x="${at.x}" y="${at.y}" width="160" height="48" fill="none" stroke="currentColor"/><text x="${at.x + 8}" y="${at.y + 28}">${escapeXml(node.label)} · ${node.status}</text></g>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function diffGraphs(
  before: FlowGraph,
  after: FlowGraph,
): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const prior = new Map(before.nodes.map((node) => [node.id, node]));
  const next = new Map(after.nodes.map((node) => [node.id, node]));
  const added = [...next.keys()].filter((id) => !prior.has(id));
  const removed = [...prior.keys()].filter((id) => !next.has(id));
  const changed = [...next.keys()].filter((id) => {
    const a = prior.get(id);
    const b = next.get(id);
    return a && b && (a.label !== b.label || a.risk !== b.risk || a.status !== b.status);
  });
  return { added, removed, changed };
}

export type FlowDraft = {
  base: FlowGraph;
  current: FlowGraph;
  past: FlowGraph[];
  future: FlowGraph[];
};

export function createDraft(graph: FlowGraph): FlowDraft {
  return { base: graph, current: graph, past: [], future: [] };
}

export function editDraft(
  draft: FlowDraft,
  next: FlowGraph,
): { draft: FlowDraft; issues: FlowIssue[] } {
  const issues = validateEdit(draft.base, next);
  if (
    issues.some(
      (issue) =>
        issue.code === "locked" || issue.code === "invariant" || issue.code === "self-approve",
    )
  ) {
    return { draft, issues };
  }
  return {
    draft: { ...draft, past: [...draft.past, draft.current], future: [], current: next },
    issues,
  };
}

export function undoDraft(draft: FlowDraft): FlowDraft {
  const previous = draft.past[draft.past.length - 1];
  if (!previous) return draft;
  return {
    ...draft,
    current: previous,
    past: draft.past.slice(0, -1),
    future: [draft.current, ...draft.future],
  };
}

export function redoDraft(draft: FlowDraft): FlowDraft {
  const next = draft.future[0];
  if (!next) return draft;
  return {
    ...draft,
    current: next,
    past: [...draft.past, draft.current],
    future: draft.future.slice(1),
  };
}

const FEATURE_WORDS: Record<string, RegExp> = {
  voice: /\b(voice|awaz|आवाज|bolna|microphone)\b/i,
  chat: /\b(chat|manual)\b/i,
  memory: /\b(memory|yaad|याद)\b/i,
  brain: /\b(brain|soch)\b/i,
  doctor: /\b(doctor|health)\b/i,
  models: /\b(model|router|routing)\b/i,
  skills: /\bskills?\b/i,
  tools: /\btools?\b/i,
  agents: /\bagents?\b/i,
  modules: /\bmodules?\b/i,
  plugins: /\bplugins?\b/i,
  connectors: /\bconnectors?\b/i,
  workflows: /\bworkflows?\b/i,
  update: /\b(update|install)\b/i,
  master: /\b(master|system|wiring|friday)\b/i,
  hub: /\bhub\b/i,
  projects: /\bprojects?\b/i,
  workspace: /\b(workspace|folder)\b/i,
  sandbox: /\bsandbox\b/i,
  terminal: /\bterminal\b/i,
  browser: /\bbrowser\b/i,
  devices: /\bdevices?\b/i,
  settings: /\bsettings?\b/i,
  logs: /\blogs?\b/i,
  tasks: /\btasks?\b/i,
  n8n: /\bn8n\b/i,
};

export function parseFlowCommand(text: string): {
  action: "show" | "explain" | "watch" | "none";
  feature: string;
} {
  const line = String(text || "").trim();
  const show = /\b(show|open|dikhao|dikha)\b/i.test(line);
  const explain = /\b(explain|how|kaise|कैसे|samjha)\b/i.test(line);
  const watch = /\b(watch|live|kya ho raha|what's happening|what is happening)\b/i.test(line);
  if (!show && !explain && !watch) return { action: "none", feature: "master" };
  if (!/\b(flow|wiring|chart|graph)\b/i.test(line) && !watch)
    return { action: "none", feature: "master" };
  let feature = "master";
  for (const [id, pattern] of Object.entries(FEATURE_WORDS)) {
    if (pattern.test(line)) feature = id;
  }
  if (watch && !show && !explain) return { action: "watch", feature };
  if (explain) return { action: "explain", feature };
  return { action: "show", feature };
}

export function explainGraph(graph: FlowGraph, question: string): string {
  const language = /[\u0900-\u097F]/.test(question)
    ? "hindi"
    : /\b(kya|kaise|hai|nahi)\b/i.test(question)
      ? "hinglish"
      : "english";
  const asked = question.toLowerCase();
  const hit = graph.nodes.find(
    (node) => asked.includes(node.label.toLowerCase()) || asked.includes(node.id.toLowerCase()),
  );
  const nodes = hit ? [hit] : graph.nodes.slice(0, 8);
  if (!nodes.length) {
    return language === "hindi"
      ? "इस प्रवाह का कोई बॉक्स दर्ज नहीं है।"
      : language === "hinglish"
        ? "Is flow ka koi box record nahi hai."
        : "This flow has no recorded boxes.";
  }
  const lines = nodes.map((node) => {
    const module = node.module || "unwired";
    const detail = node.detail || "unknown";
    if (language === "hindi") {
      return `${node.label}: स्थिति ${node.status}, जोखिम ${node.risk}, मॉड्यूल ${module}. ${detail}`;
    }
    if (language === "hinglish") {
      return `${node.label}: status ${node.status}, risk ${node.risk}, module ${module}. ${detail}`;
    }
    return `${node.label}: status ${node.status}, risk ${node.risk}, module ${module}. ${detail}`;
  });
  const head =
    language === "hindi"
      ? `${graph.title} के रिकॉर्ड बॉक्स:`
      : language === "hinglish"
        ? `${graph.title} ke recorded boxes:`
        : `${graph.title} recorded boxes:`;
  return [head, ...lines].join("\n");
}

export function motionAllowed(prefersReduced: boolean): boolean {
  return !prefersReduced;
}

export function toCode(graph: FlowGraph): string {
  return JSON.stringify(graph, null, 2);
}

export function fromCode(text: string): { graph: FlowGraph | null; issues: FlowIssue[] } {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { graph: null, issues: [{ code: "json", message: "That text is empty." }] };
  try {
    const parsed =
      trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(trimmed) : loadYaml(trimmed);
    return migrateFlowDocument(parsed);
  } catch {
    return {
      graph: null,
      issues: [{ code: "json", message: "That text is not valid JSON or YAML." }],
    };
  }
}
