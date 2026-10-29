/**
 * FRIDAY · Flow Studio depth.
 *
 * Modes, ports, live retention, drafts, forge stages, doctor findings,
 * and text export all read the one graph. Nothing here calls a host.
 */

import { stepsFor, type DoctorCheck } from "./doctor-engine";
import {
  createDraft,
  diffGraphs,
  editDraft,
  explainGraph,
  flowHash,
  graphToSteps,
  nodeOf,
  redactFlowText,
  replayRun,
  safeFlowId,
  simulateFlow,
  undoDraft,
  validateEdit,
  validateFlowGraph,
  type CompiledStep,
  type FlowDraft,
  type FlowGraph,
  type FlowGraphNode,
  type FlowIssue,
  type FlowRisk,
  type FlowRunEvent,
} from "./flow-graph";
export { exportPdf } from "./flow-pdf";

export const CANVAS_MODES = [
  "flowchart",
  "dataflow",
  "state",
  "timeline",
  "architecture",
  "tree",
  "network",
  "sankey",
  "heatmap",
] as const;

export type CanvasMode = (typeof CANVAS_MODES)[number];
export type ZoomBand = "overview" | "layer" | "node" | "internals";
export type FlowOverlay = "latency" | "cost" | "errors" | "privacy" | "risk" | "usage";

export const FLOW_STRINGS = {
  english: {
    locked: "Locked. No switch.",
    untrusted: "Imported flows stay disabled until you enable them.",
    dryRun: "Dry run. Nothing was executed.",
  },
  hindi: {
    locked: "यह बंद है। स्विच नहीं है।",
    untrusted: "आयातित प्रवाह तब तक बंद रहता है जब तक आप उसे चालू नहीं करते।",
    dryRun: "सूखा अभ्यास। कुछ चलाया नहीं गया।",
  },
  hinglish: {
    locked: "Yeh locked hai. Switch nahi.",
    untrusted: "Imported flow tab tak disabled rehta hai jab tak aap enable nahi karte.",
    dryRun: "Dry run. Kuch execute nahi hua.",
  },
} as const;

export type FlowLanguage = keyof typeof FLOW_STRINGS;

const BAD = /<|javascript:|onerror|onload|<script/i;
const HOSTILE = /javascript:|onerror|onload|<script/i;

function textLanguage(question: string): FlowLanguage {
  if (/[\u0900-\u097F]/.test(question)) return "hindi";
  if (/\b(kya|kaise|hai|nahi)\b/i.test(question)) return "hinglish";
  return "english";
}

function chain(nodes: FlowGraphNode[]): FlowGraph["edges"] {
  const edges: FlowGraph["edges"] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    edges.push({
      id: `t-${nodes[i - 1]!.id}-${nodes[i]!.id}`,
      source: nodes[i - 1]!.id,
      target: nodes[i]!.id,
      kind: "event",
    });
  }
  return edges;
}

export function projectMode(graph: FlowGraph, mode: CanvasMode): FlowGraph {
  if (mode === "timeline" || mode === "state") {
    if (
      graph.id === "voice-auto" ||
      graph.nodes.some((node) => node.source.adapter === "voice-state")
    ) {
      return graph;
    }
    return { ...graph, edges: chain(graph.nodes) };
  }
  if (mode === "dataflow" || mode === "sankey") {
    return {
      ...graph,
      edges: graph.edges.map((edge) => ({ ...edge, kind: "data" as const })),
    };
  }
  if (mode === "tree" && graph.groups.length) {
    const edges: FlowGraph["edges"] = [];
    for (const group of graph.groups) {
      const [head, ...rest] = group.nodeIds;
      if (!head) continue;
      for (const id of rest) {
        edges.push({ id: `tree-${head}-${id}`, source: head, target: id, kind: "control" });
      }
    }
    return { ...graph, edges };
  }
  if (mode === "flowchart") {
    const control = graph.edges.filter(
      (edge) => edge.kind === "control" || edge.kind === "approval",
    );
    return { ...graph, edges: control.length ? control : graph.edges };
  }
  return graph;
}

export function semanticZoom(graph: FlowGraph, band: ZoomBand, focusId = ""): FlowGraph {
  if (band === "overview") {
    const groups = graph.groups.length
      ? graph.groups
      : [
          {
            id: graph.id || "all",
            title: graph.title,
            nodeIds: graph.nodes.map((node) => node.id),
          },
        ];
    const nodes = groups.map((group) =>
      nodeOf({
        id: safeFlowId(`group.${group.id}`),
        kind: "layer",
        label: group.title,
        module: "src/lib/friday/flow-graph.ts",
        detail: `${group.nodeIds.length} boxes`,
        source: { adapter: "zoom", ref: group.id },
      }),
    );
    return {
      ...graph,
      nodes,
      edges: chain(nodes),
      groups: [],
    };
  }
  if ((band === "node" || band === "internals") && focusId) {
    const node = graph.nodes.find((item) => item.id === focusId);
    if (!node) return graph;
    if (band === "internals") {
      const ports = node.ports.map((port) =>
        nodeOf({
          id: safeFlowId(`${node.id}.${port.id}`),
          kind: "note",
          label: `${port.direction} ${port.id}`,
          detail: port.type,
          ...(node.module ? { module: node.module } : {}),
          source: { adapter: "port", ref: `${node.id}:${port.id}` },
        }),
      );
      return { ...graph, nodes: [node, ...ports], edges: chain([node, ...ports]), groups: [] };
    }
    const near = new Set<string>([node.id]);
    for (const edge of graph.edges) {
      if (edge.source === node.id) near.add(edge.target);
      if (edge.target === node.id) near.add(edge.source);
    }
    const nodes = graph.nodes.filter((item) => near.has(item.id));
    return {
      ...graph,
      nodes,
      edges: graph.edges.filter((edge) => near.has(edge.source) && near.has(edge.target)),
    };
  }
  return graph;
}

export function applyOverlay(
  graph: FlowGraph,
  events: FlowRunEvent[],
  overlay: FlowOverlay,
): FlowGraph {
  const nodes = graph.nodes.map((node) => {
    const mine = events.filter((event) => event.nodeId === node.id);
    let extra: string;
    if (overlay === "latency") {
      const ms = mine.find((event) => typeof event.ms === "number")?.ms;
      extra = ms == null ? "latency unknown" : `latency ${ms} ms`;
    } else if (overlay === "cost") {
      const cost = mine.find((event) => typeof event.cost === "number")?.cost;
      extra = cost == null ? "cost unknown" : `cost ${cost}`;
    } else if (overlay === "errors") {
      extra = mine.some((event) => event.status === "failed")
        ? "error recorded"
        : mine.length
          ? "no error recorded"
          : "errors unknown";
    } else if (overlay === "privacy") extra = `privacy ${node.privacy}`;
    else if (overlay === "risk") extra = `risk ${node.risk}`;
    else extra = mine.length ? `usage ${mine.length}` : "usage unknown";
    return { ...node, detail: `${node.detail ? `${node.detail} ` : ""}${extra}`.trim() };
  });
  return { ...graph, nodes };
}

export function lineageOf(graph: FlowGraph, nodeId: string): string[] {
  const seen = new Set<string>();
  const walk = (id: string) => {
    for (const edge of graph.edges) {
      if (edge.target !== id || seen.has(edge.source)) continue;
      seen.add(edge.source);
      walk(edge.source);
    }
  };
  walk(nodeId);
  return [...seen];
}

export function pinData(value: string): { text: string; redacted: boolean } {
  const text = redactFlowText(value);
  return { text, redacted: text === "SENSITIVE" };
}

export function compareRuns(
  left: FlowRunEvent[],
  right: FlowRunEvent[],
): { nodeId: string; left: string; right: string }[] {
  const status = (events: FlowRunEvent[], id: string) =>
    [...events].reverse().find((event) => event.nodeId === id)?.status || "unknown";
  const ids = new Set([
    ...left.map((event) => event.nodeId),
    ...right.map((event) => event.nodeId),
  ]);
  return [...ids]
    .map((nodeId) => ({ nodeId, left: status(left, nodeId), right: status(right, nodeId) }))
    .filter((row) => row.left !== row.right);
}

export function runFromHere(
  graph: FlowGraph,
  nodeId: string,
): { dryRun: true; executed: false; needsApproval: boolean; steps: CompiledStep[] } {
  const steps = graphToSteps(graph);
  const index = steps.findIndex((step) => step.id === nodeId);
  const slice = index < 0 ? [] : steps.slice(index);
  return {
    dryRun: true,
    executed: false,
    needsApproval: slice.some((step) => step.risk === "write" || step.risk === "exec"),
    steps: slice,
  };
}

export function scrubWithBreaks(
  graph: FlowGraph,
  events: FlowRunEvent[],
  generation: number,
  stopBefore: string[],
): { graph: FlowGraph; stoppedBefore: string | null } {
  const kept: FlowRunEvent[] = [];
  let stoppedBefore: string | null = null;
  for (const event of events) {
    if (stopBefore.includes(event.nodeId)) {
      stoppedBefore = event.nodeId;
      break;
    }
    kept.push(event);
  }
  return { graph: replayRun(graph, kept, generation), stoppedBefore };
}

export function batchEvents(events: FlowRunEvent[], size = 25): FlowRunEvent[][] {
  const step = Math.max(1, size);
  const out: FlowRunEvent[][] = [];
  for (let i = 0; i < events.length; i += step) out.push(events.slice(i, i + step));
  return out;
}

export function retainEvents(events: FlowRunEvent[], cap = 200): FlowRunEvent[] {
  return events.slice(-cap).map((event) => {
    const detail = event.detail ? redactFlowText(event.detail) : "";
    if (!detail) {
      const { detail: _drop, ...rest } = event;
      void _drop;
      return rest;
    }
    return { ...event, detail };
  });
}

export type OptionField = {
  key: string;
  label: string;
  value: string;
  help: string;
  kind: "text" | "boolean";
};

export function optionFields(node: FlowGraphNode): OptionField[] {
  return [
    {
      key: "label",
      label: "Label",
      value: node.label,
      help: "Shown as text. Markup is not rendered.",
      kind: "text",
    },
    {
      key: "detail",
      label: "Detail",
      value: node.detail,
      help: "Plain text from the registry or the draft.",
      kind: "text",
    },
    {
      key: "risk",
      label: "Risk",
      value: node.risk,
      help: "safe, write, or exec. A draft cannot lower this.",
      kind: "text",
    },
    {
      key: "enabled",
      label: "Enabled",
      value: node.enabled === false ? "false" : "true",
      help: "A disabled node stays on the chart and does not run.",
      kind: "boolean",
    },
  ];
}

export function applyOption(
  graph: FlowGraph,
  nodeId: string,
  key: string,
  value: string,
): { graph: FlowGraph; issues: FlowIssue[] } {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node)
    return { graph, issues: [{ code: "missing", message: "That box is not on this chart." }] };
  if (node.locked) {
    return { graph, issues: [{ code: "locked", nodeId, message: "Locked. No switch." }] };
  }
  const nextNode: FlowGraphNode = { ...node };
  if (key === "label") nextNode.label = redactFlowText(value) === "SENSITIVE" ? node.label : value;
  else if (key === "detail") nextNode.detail = redactFlowText(value);
  else if (key === "risk") {
    if (value !== "safe" && value !== "write" && value !== "exec") {
      return {
        graph,
        issues: [{ code: "risk", nodeId, message: "Risk must be safe, write, or exec." }],
      };
    }
    nextNode.risk = value;
  } else if (key === "enabled") nextNode.enabled = value !== "false";
  else return { graph, issues: [{ code: "field", message: "That field is not on this box." }] };
  if (key === "label" && redactFlowText(value) === "SENSITIVE") {
    return {
      graph,
      issues: [
        { code: "sensitive", nodeId, message: "A sensitive value is not written onto the chart." },
      ],
    };
  }
  const next = {
    ...graph,
    nodes: graph.nodes.map((item) => (item.id === nodeId ? nextNode : item)),
  };
  const issues = validateEdit(graph, next);
  if (
    issues.some(
      (issue) =>
        issue.code === "locked" || issue.code === "invariant" || issue.code === "self-approve",
    )
  ) {
    return { graph, issues };
  }
  return { graph: next, issues };
}

export function copyNodes(graph: FlowGraph, ids: string[]): FlowGraphNode[] {
  return graph.nodes
    .filter((node) => ids.includes(node.id))
    .map((node) => ({ ...node, ports: [...node.ports] }));
}

export function pasteNodes(graph: FlowGraph, nodes: FlowGraphNode[]): FlowGraph {
  const used = new Set(graph.nodes.map((node) => node.id));
  const copies = nodes.map((node, index) => {
    let id = safeFlowId(`${node.id}_copy`);
    while (used.has(id)) id = safeFlowId(`${node.id}_copy_${index}_${used.size}`);
    used.add(id);
    const { locked, ...rest } = node;
    return {
      ...rest,
      id,
      ports: [...node.ports],
      source: { adapter: "paste", ref: node.id },
      ...(locked ? { locked: true } : {}),
    };
  });
  return { ...graph, nodes: [...graph.nodes, ...copies] };
}

export function addNote(graph: FlowGraph, text: string): FlowGraph {
  const body = redactFlowText(text);
  const node = nodeOf({
    id: safeFlowId(`note.${flowHash(body)}`),
    kind: "note",
    label: "Note",
    detail: body || "empty",
    module: "src/lib/friday/flow-graph.ts",
    source: { adapter: "note", ref: "note" },
  });
  return { ...graph, nodes: [...graph.nodes, node] };
}

export function reconcileDisk(
  draft: FlowDraft,
  disk: FlowGraph,
): { draft: FlowDraft; conflict: boolean } {
  if (JSON.stringify(draft.base) === JSON.stringify(disk)) return { draft, conflict: false };
  if (JSON.stringify(draft.current) === JSON.stringify(draft.base))
    return { draft: createDraft(disk), conflict: false };
  return { draft, conflict: true };
}

export function rollbackDraft(draft: FlowDraft): FlowDraft {
  if (draft.current === draft.base) return draft;
  return { ...draft, past: [...draft.past, draft.current], future: [], current: draft.base };
}

export function commitDraft(
  draft: FlowDraft,
  approved: boolean,
): { draft: FlowDraft; applied: boolean; reason: string } {
  if (!approved) return { draft, applied: false, reason: "Not approved." };
  const issues = validateEdit(draft.base, draft.current);
  if (
    issues.some(
      (issue) =>
        issue.code === "locked" || issue.code === "invariant" || issue.code === "self-approve",
    )
  ) {
    return { draft, applied: false, reason: issues.map((issue) => issue.message).join(" ") };
  }
  return {
    draft: createDraft(draft.current),
    applied: true,
    reason:
      "Applied in this session. A workflow pack still saves through the existing install path.",
  };
}

export type WiringFinding = {
  code: string;
  nodeId?: string;
  severity: "red" | "amber";
  message: string;
  proposal: string;
};

export function wiringDoctor(input: {
  graph: FlowGraph;
  routes: string[];
  features: Record<string, string>;
}): WiringFinding[] {
  const findings: WiringFinding[] = [];
  for (const node of input.graph.nodes) {
    if (node.status === "unwired") {
      findings.push({
        code: "unwired",
        nodeId: node.id,
        severity: "red",
        message: `${node.label} is unwired`,
        proposal: "Bind this box to a file that exists.",
      });
    }
  }
  for (const issue of validateFlowGraph(input.graph)) {
    if (issue.code === "cycle" || issue.code === "unreachable") {
      findings.push({
        code: issue.code,
        ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
        severity: issue.code === "cycle" ? "red" : "amber",
        message: issue.message,
        proposal: "Fix the link, or leave the box out of the run.",
      });
    }
  }
  const modules = new Map<string, string[]>();
  for (const node of input.graph.nodes) {
    if (node.source.adapter !== "capability" || !node.module) continue;
    const list = modules.get(node.module) || [];
    list.push(node.id);
    modules.set(node.module, list);
  }
  for (const [module, ids] of modules) {
    if (ids.length < 2) continue;
    findings.push({
      code: "duplicate",
      severity: "amber",
      message: `${module} is listed ${ids.length} times`,
      proposal: "Keep one implementation.",
    });
  }
  for (const route of input.routes) {
    if (!input.features[route]) {
      findings.push({
        code: "dead-route",
        severity: "red",
        message: `${route} has no Flow view`,
        proposal: "Map the route or record an exemption with a reason.",
      });
    }
  }
  return findings;
}

export function findingCheck(finding: WiringFinding): DoctorCheck {
  return {
    id: `flow.${finding.code}.${finding.nodeId || "graph"}`.slice(0, 80),
    label: finding.message,
    group: "Flow",
    status: finding.severity === "red" ? "Error" : "Warning",
    detail: finding.message,
    cause: finding.message,
    fix: finding.proposal,
    fixable: false,
  };
}

export function proposeFinding(finding: WiringFinding): { applied: false; steps: string[] } {
  return { applied: false, steps: stepsFor(findingCheck(finding)) };
}

export function explainTour(graph: FlowGraph, language: FlowLanguage): string[] {
  const ask = language === "hindi" ? "कैसे" : language === "hinglish" ? "kaise hai" : "explain";
  return graph.nodes.map((node) =>
    explainGraph({ ...graph, nodes: [node], title: node.label }, ask),
  );
}

export function askChart(graph: FlowGraph, question: string): string {
  const body = explainGraph(graph, question);
  const quoted = /"([^"]+)"/.exec(question);
  if (
    quoted?.[1] &&
    !graph.nodes.some((node) => node.label === quoted[1] || node.id === quoted[1])
  ) {
    const language = textLanguage(question);
    const missing =
      language === "hindi"
        ? "वह नाम इस चार्ट पर नहीं है।"
        : language === "hinglish"
          ? "Woh naam is chart par nahi hai."
          : "That name is not on this chart.";
    return `${body}\n${missing}`;
  }
  return body;
}

export type ForgeStage = "plan" | "code" | "verify" | "approval" | "install" | "done" | "failed";

export type ForgeHost = {
  plan: (label: string) => { ok: boolean; detail: string };
  code: (label: string) => { ok: boolean; detail: string; source?: string };
  verify: (source: string) => { ok: boolean; detail: string };
  approve: (source: string) => boolean;
  install: (source: string) => { ok: boolean; detail: string; id?: string };
};

export function forgeCustomStep(
  label: string,
  host: ForgeHost,
): {
  stage: ForgeStage;
  stoppedAt: ForgeStage;
  log: string[];
  node: FlowGraphNode | null;
  calls: { verify: number; approve: number; install: number };
} {
  const calls = { verify: 0, approve: 0, install: 0 };
  const log: string[] = [];
  const planned = host.plan(label);
  log.push(planned.detail || "plan");
  if (!planned.ok) return { stage: "failed", stoppedAt: "plan", log, node: null, calls };
  const coded = host.code(label);
  log.push(coded.detail || "code");
  if (!coded.ok || !coded.source)
    return { stage: "failed", stoppedAt: "code", log, node: null, calls };
  calls.verify += 1;
  const verified = host.verify(coded.source);
  log.push(verified.detail || "verify");
  if (!verified.ok) return { stage: "failed", stoppedAt: "verify", log, node: null, calls };
  calls.approve += 1;
  if (!host.approve(coded.source)) {
    log.push("approval refused");
    return { stage: "failed", stoppedAt: "approval", log, node: null, calls };
  }
  log.push("approval");
  calls.install += 1;
  const installed = host.install(coded.source);
  log.push(installed.detail || "install");
  if (!installed.ok) return { stage: "failed", stoppedAt: "install", log, node: null, calls };
  const node = nodeOf({
    id: safeFlowId(`forge.${label}`),
    kind: "workflow",
    label,
    status: "disabled",
    enabled: false,
    module: "src/lib/friday/brain/workflow-forge.ts",
    detail: "Disabled until you enable it.",
    source: { adapter: "forge", ref: installed.id || label },
  });
  return { stage: "done", stoppedAt: "done", log, node, calls };
}

export function subflowLibrary(): { id: string; title: string; graph: FlowGraph }[] {
  return [
    {
      id: "approval-gate",
      title: "Approval gate",
      graph: instantiateTemplate("approval-gate", { name: "Ship" }),
    },
    {
      id: "retry-once",
      title: "Retry once",
      graph: instantiateTemplate("retry-once", { name: "Try" }),
    },
  ];
}

export function instantiateTemplate(id: string, params: Record<string, string>): FlowGraph {
  const name = params["name"] || "Step";
  if (id === "approval-gate") {
    return stepsGraph(`${safeFlowId(name)}-gate`, name, [
      { id: "ask", label: name, kind: "trigger", risk: "safe" },
      { id: "allow", label: "Ask the owner", kind: "approval", risk: "safe" },
      { id: "act", label: "Do the step", kind: "tool", risk: "exec" },
    ]);
  }
  if (id === "retry-once") {
    return stepsGraph(`${safeFlowId(name)}-retry`, name, [
      { id: "try", label: name, kind: "tool", risk: "safe" },
      { id: "again", label: "Try again", kind: "loop", risk: "safe" },
    ]);
  }
  return {
    version: 1,
    id: "empty",
    title: "Unknown template",
    trusted: true,
    enabled: false,
    nodes: [],
    edges: [],
    groups: [],
  };
}

function stepsGraph(
  id: string,
  title: string,
  steps: { id: string; label: string; kind: FlowGraphNode["kind"]; risk: FlowRisk }[],
): FlowGraph {
  const nodes = steps.map((step) =>
    nodeOf({
      id: step.id,
      kind: step.kind,
      label: step.label,
      risk: step.risk,
      module: "src/lib/friday/brain/workflow-forge.ts",
      source: { adapter: "template", ref: step.id },
    }),
  );
  const edges = nodes.slice(1).map((node, index) => ({
    id: `s-${nodes[index]!.id}-${node.id}`,
    source: nodes[index]!.id,
    target: node.id,
    kind: "control" as const,
  }));
  return { version: 1, id, title, trusted: true, enabled: true, nodes, edges, groups: [] };
}

export function goldenWorkflows(): FlowGraph[] {
  return subflowLibrary().map((item) => item.graph);
}

export function runGolden(
  graph: FlowGraph,
  now: () => number = () => 1,
): {
  ok: boolean;
  issues: FlowIssue[];
  log: ReturnType<typeof simulateFlow>;
} {
  const issues = validateFlowGraph(graph);
  const log = simulateFlow(graph, {}, now);
  return {
    ok: !issues.some((issue) => issue.code === "self-approve" || issue.code === "cycle"),
    issues,
    log,
  };
}

export const EVOLUTION_LEVELS = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"] as const;

export function proposeEvolution(
  graph: FlowGraph,
  level: string,
): {
  level: string;
  applied: false;
  labOnly: boolean;
  proposal: FlowGraph;
  diff: ReturnType<typeof diffGraphs>;
} {
  const note = nodeOf({
    id: safeFlowId(`evolution.${level}`),
    kind: "note",
    label: `Proposal ${level}`,
    status: "disabled",
    module: "src/lib/friday/flow-graph.ts",
    detail:
      level === "E2"
        ? "Workflow topology change. Lab replay is read-only."
        : "Recorded proposal. Not applied.",
    source: { adapter: "evolution", ref: level },
  });
  const proposal = { ...graph, nodes: [...graph.nodes, note] };
  return {
    level,
    applied: false,
    labOnly: level === "E0" || level === "E1" || level === "E2",
    proposal,
    diff: diffGraphs(graph, proposal),
  };
}

export function decideEvolution(
  before: FlowGraph,
  proposal: FlowGraph,
  approved: boolean,
): { graph: FlowGraph; applied: boolean; rollback: FlowGraph } {
  if (!approved) return { graph: before, applied: false, rollback: before };
  return { graph: proposal, applied: true, rollback: before };
}

export function labReplay(graph: FlowGraph): {
  readOnly: true;
  executed: false;
  log: ReturnType<typeof simulateFlow>;
} {
  return { readOnly: true, executed: false, log: simulateFlow(graph, {}, () => 1) };
}

export function companionSnapshot(
  graph: FlowGraph,
  session: { authenticated: boolean },
): { readOnly: true; mutations: false; reason: string; graph: FlowGraph } {
  if (!session.authenticated) {
    return {
      readOnly: true,
      mutations: false,
      reason: "no live authenticated session",
      graph: {
        ...graph,
        nodes: [
          nodeOf({
            id: "companion.offline",
            kind: "note",
            label: "No live session",
            detail: "The phone does not replay or change a flow without a live sign-in.",
            module: "kernel/companion.py",
            source: { adapter: "companion", ref: "offline" },
          }),
        ],
        edges: [],
      },
    };
  }
  return { readOnly: true, mutations: false, reason: "read-only snapshot", graph };
}

function escapeLabel(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function exportDot(graph: FlowGraph): string {
  const lines = ["digraph friday {"];
  for (const node of graph.nodes) {
    lines.push(`  "${node.id}" [label="${escapeLabel(node.label).replace(/"/g, "'")}"];`);
  }
  for (const edge of graph.edges) lines.push(`  "${edge.source}" -> "${edge.target}";`);
  lines.push("}");
  return lines.join("\n");
}

export function exportD2(graph: FlowGraph): string {
  const lines = ["direction: right"];
  for (const node of graph.nodes)
    lines.push(`${node.id}: "${escapeLabel(node.label).replace(/"/g, "'")}"`);
  for (const edge of graph.edges) lines.push(`${edge.source} -> ${edge.target}`);
  return lines.join("\n");
}

export function exportJsonCanvas(graph: FlowGraph): string {
  return JSON.stringify({
    nodes: graph.nodes.map((node, index) => ({
      id: node.id,
      type: "text",
      x: (index % 4) * 220,
      y: Math.floor(index / 4) * 100,
      width: 200,
      height: 70,
      text: node.label,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      fromNode: edge.source,
      toNode: edge.target,
    })),
  });
}

export function exportN8n(graph: FlowGraph): string {
  const connections: Record<string, { main: { node: string; type: string; index: number }[][] }> =
    {};
  for (const edge of graph.edges) {
    const source = graph.nodes.find((node) => node.id === edge.source);
    const target = graph.nodes.find((node) => node.id === edge.target);
    if (!source || !target) continue;
    const bucket = connections[source.label] || { main: [[]] };
    bucket.main[0]!.push({ node: target.label, type: "main", index: 0 });
    connections[source.label] = bucket;
  }
  return JSON.stringify({
    nodes: graph.nodes.map((node, index) => ({
      id: node.id,
      name: node.label,
      type: "n8n-nodes-base.noOp",
      position: [index * 220, 0],
    })),
    connections,
  });
}

export function exportNodeRed(graph: FlowGraph): string {
  const wires = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = wires.get(edge.source) || [];
    list.push(edge.target);
    wires.set(edge.source, list);
  }
  return JSON.stringify(
    graph.nodes.map((node) => ({
      id: node.id,
      type: "function",
      name: node.label,
      wires: [wires.get(node.id) || []],
    })),
  );
}

function disabledImport(
  id: string,
  title: string,
  nodes: FlowGraphNode[],
  edges: FlowGraph["edges"],
  message: string,
): { graph: FlowGraph; issues: FlowIssue[] } {
  return {
    graph: {
      version: 1,
      id,
      title,
      trusted: false,
      enabled: false,
      nodes,
      edges,
      groups: [],
    },
    issues: [{ code: "untrusted", message }],
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);
  return out;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function storedZlib(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let offset = 0;
  do {
    const last = offset + 65535 >= data.length;
    const take = Math.min(65535, data.length - offset);
    const header = new Uint8Array(5);
    header[0] = last ? 1 : 0;
    header[1] = take & 0xff;
    header[2] = (take >> 8) & 0xff;
    const nlen = ~take & 0xffff;
    header[3] = nlen & 0xff;
    header[4] = (nlen >> 8) & 0xff;
    blocks.push(header, data.subarray(offset, offset + take));
    offset += take;
  } while (offset < data.length);
  const adler = adler32(data);
  const tail = new Uint8Array(4);
  tail[0] = (adler >>> 24) & 0xff;
  tail[1] = (adler >>> 16) & 0xff;
  tail[2] = (adler >>> 8) & 0xff;
  tail[3] = adler & 0xff;
  blocks.push(tail);
  const size = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

export function exportPng(graph: FlowGraph): Uint8Array {
  const width = 32;
  const height = 32;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const cell = row + 1 + x * 3;
      raw[cell] = 12;
      raw[cell + 1] = 16;
      raw[cell + 2] = 20;
    }
  }
  const boxes = Math.min(graph.nodes.length, 12);
  for (let i = 0; i < boxes; i += 1) {
    const x0 = 2 + (i % 4) * 8;
    const y0 = 2 + Math.floor(i / 4) * 10;
    for (let y = y0; y < y0 + 6 && y < height; y += 1) {
      for (let x = x0; x < x0 + 6 && x < width; x += 1) {
        const cell = y * (1 + width * 3) + 1 + x * 3;
        raw[cell] = 220;
        raw[cell + 1] = 220;
        raw[cell + 2] = 220;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", storedZlib(raw)),
    pngChunk("IEND", new Uint8Array()),
  ];
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

export function importDot(text: string): { graph: FlowGraph; issues: FlowIssue[] } {
  if (BAD.test(text)) {
    return {
      graph: emptyDisabled("dot"),
      issues: [{ code: "untrusted", message: "The diagram text was refused." }],
    };
  }
  const nodes = new Map<string, string>();
  const edges: FlowGraph["edges"] = [];
  for (const line of text.split("\n")) {
    const node = /"([^"]+)"\s*\[label="([^"]*)"\]/.exec(line);
    if (node?.[1]) nodes.set(node[1], node[2] || node[1]);
    const edge = /"([^"]+)"\s*->\s*"([^"]+)"/.exec(line);
    if (edge?.[1] && edge[2]) {
      if (!nodes.has(edge[1])) nodes.set(edge[1], edge[1]);
      if (!nodes.has(edge[2])) nodes.set(edge[2], edge[2]);
      edges.push({
        id: `d-${edges.length}`,
        source: safeFlowId(edge[1]),
        target: safeFlowId(edge[2]),
        kind: "control",
      });
    }
  }
  const graphNodes = [...nodes.entries()].map(([id, label]) =>
    nodeOf({
      id: safeFlowId(id),
      kind: "note",
      label,
      status: "disabled",
      module: "src/lib/friday/flow-graph.ts",
      source: { adapter: "dot", ref: id },
    }),
  );
  return {
    graph: {
      version: 1,
      id: "dot-import",
      title: "DOT import",
      trusted: false,
      enabled: false,
      nodes: graphNodes,
      edges,
      groups: [],
    },
    issues: [{ code: "untrusted", message: "Imported text stays disabled." }],
  };
}

export function importExternal(
  kind: "n8n" | "node-red" | "json",
  text: string,
): { graph: FlowGraph; issues: FlowIssue[]; readOnly: true } {
  if (BAD.test(text)) {
    return {
      graph: emptyDisabled(kind),
      readOnly: true,
      issues: [{ code: "untrusted", message: "The import was refused." }],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      graph: emptyDisabled(kind),
      readOnly: true,
      issues: [{ code: "json", message: "The text is not JSON." }],
    };
  }
  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraph["edges"] = [];
  if (
    kind === "n8n" &&
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { nodes?: unknown }).nodes)
  ) {
    for (const item of (parsed as { nodes: { name?: string; type?: string }[] }).nodes) {
      nodes.push(
        nodeOf({
          id: safeFlowId(item.name || item.type || "n8n"),
          kind: "workflow",
          label: String(item.name || item.type || "n8n"),
          status: "disabled",
          module: "src/routes/n8n.tsx",
          source: { adapter: "n8n", ref: String(item.type || item.name || "n8n") },
        }),
      );
    }
    const connections = (
      parsed as { connections?: Record<string, { main?: { node?: string }[][] }> }
    ).connections;
    if (connections) {
      for (const [from, bundle] of Object.entries(connections)) {
        for (const link of bundle.main?.[0] || []) {
          if (!link?.node) continue;
          edges.push({
            id: `n8n-${edges.length}`,
            source: safeFlowId(from),
            target: safeFlowId(link.node),
            kind: "control",
          });
        }
      }
    }
  } else if (kind === "node-red" && Array.isArray(parsed)) {
    for (const item of parsed as {
      id?: string;
      name?: string;
      type?: string;
      wires?: string[][];
    }[]) {
      if (!item || item.type === "tab") continue;
      nodes.push(
        nodeOf({
          id: safeFlowId(item.id || item.name || "red"),
          kind: "workflow",
          label: String(item.name || item.type || "node"),
          status: "disabled",
          module: "src/routes/n8n.tsx",
          source: { adapter: "node-red", ref: String(item.id || "red") },
        }),
      );
      for (const target of item.wires?.[0] || []) {
        edges.push({
          id: `red-${edges.length}`,
          source: safeFlowId(item.id || item.name || "red"),
          target: safeFlowId(target),
          kind: "control",
        });
      }
    }
  }
  return {
    graph: {
      version: 1,
      id: `${kind}-import`,
      title: `${kind} import`,
      trusted: false,
      enabled: false,
      nodes,
      edges,
      groups: [],
    },
    readOnly: true,
    issues: [{ code: "untrusted", message: "Imported flows stay disabled and are not executed." }],
  };
}

export function importD2(text: string): { graph: FlowGraph; issues: FlowIssue[] } {
  if (BAD.test(text)) {
    return disabledImport("d2-import", "D2 import", [], [], "The diagram text was refused.");
  }
  const nodes = new Map<string, string>();
  const edges: FlowGraph["edges"] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("direction:")) continue;
    const node = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*"([^"]*)"/.exec(trimmed);
    if (node?.[1]) nodes.set(node[1], node[2] || node[1]);
    const edge = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*->\s*([A-Za-z_][A-Za-z0-9_.-]*)/.exec(trimmed);
    if (edge?.[1] && edge[2]) {
      if (!nodes.has(edge[1])) nodes.set(edge[1], edge[1]);
      if (!nodes.has(edge[2])) nodes.set(edge[2], edge[2]);
      edges.push({
        id: `d2-${edges.length}`,
        source: safeFlowId(edge[1]),
        target: safeFlowId(edge[2]),
        kind: "control",
      });
    }
  }
  return disabledImport(
    "d2-import",
    "D2 import",
    [...nodes.entries()].map(([id, label]) =>
      nodeOf({
        id: safeFlowId(id),
        kind: "note",
        label,
        status: "disabled",
        module: "src/lib/friday/flow-depth.ts",
        source: { adapter: "d2", ref: id },
      }),
    ),
    edges,
    "Imported text stays disabled.",
  );
}

export function importJsonCanvas(text: string): { graph: FlowGraph; issues: FlowIssue[] } {
  if (BAD.test(text)) {
    return disabledImport(
      "canvas-import",
      "Canvas import",
      [],
      [],
      "The diagram text was refused.",
    );
  }
  let parsed: {
    nodes?: { id?: string; text?: string }[];
    edges?: { id?: string; fromNode?: string; toNode?: string }[];
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    return disabledImport("canvas-import", "Canvas import", [], [], "The text is not JSON.");
  }
  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const nodes = rawNodes
    .filter((item) => item && (item.text || item.id))
    .map((item) =>
      nodeOf({
        id: safeFlowId(item.id || item.text || "canvas"),
        kind: "note",
        label: String(item.text || item.id),
        status: "disabled",
        module: "src/lib/friday/flow-depth.ts",
        source: { adapter: "canvas", ref: String(item.id || item.text) },
      }),
    );
  const ids = new Set(nodes.map((node) => node.id));
  const edges: FlowGraph["edges"] = [];
  for (const edge of parsed.edges || []) {
    const source = safeFlowId(edge.fromNode || "");
    const target = safeFlowId(edge.toNode || "");
    if (!ids.has(source) || !ids.has(target)) continue;
    edges.push({
      id: safeFlowId(edge.id || `canvas-${edges.length}`),
      source,
      target,
      kind: "control",
    });
  }
  return disabledImport(
    "canvas-import",
    "Canvas import",
    nodes,
    edges,
    "Imported text stays disabled.",
  );
}

function xmlAttr(source: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(source);
  return match?.[1] || "";
}

export function importDrawio(text: string): { graph: FlowGraph; issues: FlowIssue[] } {
  if (HOSTILE.test(text)) {
    return disabledImport(
      "drawio-import",
      "draw.io import",
      [],
      [],
      "The diagram text was refused.",
    );
  }
  if (!/<mxCell\b/i.test(text)) {
    return disabledImport(
      "drawio-import",
      "draw.io import",
      [],
      [],
      "Compressed draw.io was not expanded.",
    );
  }
  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraph["edges"] = [];
  for (const cell of text.matchAll(/<mxCell\b([^>]*?)\/?>/gi)) {
    const attrs = cell[1] || "";
    const id = xmlAttr(attrs, "id");
    if (!id || id === "0" || id === "1") continue;
    if (xmlAttr(attrs, "edge") === "1") {
      const source = safeFlowId(xmlAttr(attrs, "source"));
      const target = safeFlowId(xmlAttr(attrs, "target"));
      if (!source || !target) continue;
      edges.push({ id: safeFlowId(`drawio-${id}`), source, target, kind: "control" });
      continue;
    }
    if (xmlAttr(attrs, "vertex") !== "1") continue;
    const label = xmlAttr(attrs, "value") || id;
    nodes.push(
      nodeOf({
        id: safeFlowId(id),
        kind: "note",
        label: label.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
        status: "disabled",
        module: "src/lib/friday/flow-depth.ts",
        source: { adapter: "drawio", ref: id },
      }),
    );
  }
  return disabledImport(
    "drawio-import",
    "draw.io import",
    nodes,
    edges,
    "Imported text stays disabled.",
  );
}

export function importSvg(text: string): { graph: FlowGraph; issues: FlowIssue[] } {
  if (HOSTILE.test(text)) {
    return disabledImport("svg-import", "SVG import", [], [], "The diagram text was refused.");
  }
  const texts = [...text.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/gi)].map((match, index) => ({
    id: safeFlowId(`svg.${index}`),
    label: (match[2] || "").trim() || `text ${index}`,
    x: Number(xmlAttr(match[1] || "", "x")) || 0,
    y: Number(xmlAttr(match[1] || "", "y")) || 0,
  }));
  const nodes = texts.map((item) =>
    nodeOf({
      id: item.id,
      kind: "note",
      label: item.label,
      status: "disabled",
      module: "src/lib/friday/flow-depth.ts",
      detail: item.label,
      source: { adapter: "svg", ref: item.id },
    }),
  );
  const uncertain = new Set<string>();
  const edges: FlowGraph["edges"] = [];
  for (const line of text.matchAll(/<line\b([^>]*?)\/?>/gi)) {
    const attrs = line[1] || "";
    const ends = [
      { x: Number(xmlAttr(attrs, "x1")) || 0, y: Number(xmlAttr(attrs, "y1")) || 0 },
      { x: Number(xmlAttr(attrs, "x2")) || 0, y: Number(xmlAttr(attrs, "y2")) || 0 },
    ];
    const nearest = ends.map((end) => {
      const ranked = texts
        .map((item) => ({ item, distance: Math.hypot(item.x - end.x, item.y - end.y) }))
        .filter((item) => item.distance <= 40)
        .sort((a, b) => a.distance - b.distance);
      return ranked;
    });
    if (nearest.some((list) => list.length > 1)) {
      for (const list of nearest) for (const hit of list) uncertain.add(hit.item.id);
      continue;
    }
    const from = nearest[0]?.[0]?.item;
    const to = nearest[1]?.[0]?.item;
    if (!from || !to || from.id === to.id) continue;
    edges.push({ id: `svg-${edges.length}`, source: from.id, target: to.id, kind: "control" });
  }
  for (const node of nodes) {
    if (!uncertain.has(node.id)) continue;
    node.detail = `uncertain: ${node.label}`;
    node.source = { adapter: "svg", ref: `uncertain:${node.id}` };
  }
  return disabledImport("svg-import", "SVG import", nodes, edges, "Imported text stays disabled.");
}

export function importFlowPack(
  text: string,
  checksum: string,
): { graph: FlowGraph; issues: FlowIssue[] } {
  if (flowHash(text) !== checksum) {
    return {
      graph: emptyDisabled("pack"),
      issues: [{ code: "checksum", message: "Checksum does not match." }],
    };
  }
  if (BAD.test(text)) {
    return {
      graph: emptyDisabled("pack"),
      issues: [{ code: "untrusted", message: "The pack was refused." }],
    };
  }
  let parsed: { nodes?: { id?: string; label?: string }[] };
  try {
    parsed = JSON.parse(text) as { nodes?: { id?: string; label?: string }[] };
  } catch {
    return {
      graph: emptyDisabled("pack"),
      issues: [{ code: "json", message: "The pack is not JSON." }],
    };
  }
  const nodes = (parsed.nodes || []).map((item) =>
    nodeOf({
      id: safeFlowId(item.id || item.label || "pack"),
      kind: "workflow",
      label: String(item.label || item.id || "pack"),
      status: "disabled",
      enabled: false,
      module: "src/lib/friday/flow-graph.ts",
      source: { adapter: "pack", ref: String(item.id || "pack") },
    }),
  );
  return {
    graph: {
      version: 1,
      id: "pack-import",
      title: "Pack import",
      trusted: false,
      enabled: false,
      nodes,
      edges: [],
      groups: [],
    },
    issues: [{ code: "untrusted", message: "The pack stays disabled until you enable it." }],
  };
}

function emptyDisabled(id: string): FlowGraph {
  return {
    version: 1,
    id,
    title: id,
    trusted: false,
    enabled: false,
    nodes: [],
    edges: [],
    groups: [],
  };
}

export function exportLocalTrace(events: FlowRunEvent[], optedIn: boolean): string | null {
  if (!optedIn) return null;
  return JSON.stringify({
    localTrace: true,
    network: false,
    events: events.map((event) => ({
      generation: event.generation,
      nodeId: event.nodeId,
      status: event.status,
      at: event.at,
      ...(event.detail ? { detail: redactFlowText(event.detail) } : {}),
    })),
  });
}

export function optionalExporterReady(which: "graphviz" | "d2"): {
  installed: false;
  core: true;
  which: string;
} {
  return { installed: false, core: true, which };
}

export function flowStrings(language: FlowLanguage) {
  return FLOW_STRINGS[language];
}

export { undoDraft };
