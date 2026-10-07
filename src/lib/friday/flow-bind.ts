/**
 * FRIDAY · wires that write the existing stores.
 *
 * A binding names the module a wire changes. Balanced asks before a write
 * or an exec. Full applies and keeps a journal. Stopped refuses.
 */

import {
  emptyGraph,
  nodeOf,
  safeFlowId,
  type FlowBinding,
  type FlowBindingKind,
  type FlowGraph,
  type FlowGraphNode,
  type FlowRisk,
} from "./flow-graph";
import { ROUTE_STRATEGIES, type RouteStrategy } from "./model-routing-contract";
import { modelRegistry } from "./model-registry";
import { preferences } from "./preferences";
import { autonomy, type ApprovalLevel } from "./self/autonomy";

export type BindHost = {
  get(kind: FlowBindingKind, ref: string): string;
  set(kind: FlowBindingKind, ref: string, value: string): void;
};

export type JournalEntry = {
  id: string;
  at: number;
  actor: "owner" | "friday";
  why: string;
  kind: FlowBindingKind;
  ref: string;
  before: string;
  after: string;
  applied: boolean;
};

export type BindResult = {
  applied: boolean;
  needsApproval: boolean;
  stopped: boolean;
  reason: string;
  journal: JournalEntry[];
};

const fallbackMemory = memoryHost();

/** Writes a router strategy or a setting when the value is one the store already accepts. */
export function productionHost(): BindHost {
  return {
    get(kind, ref) {
      if (kind === "router") return modelRegistry.getSnapshot().strategy;
      if (kind === "voice" && ref === "wakeWord")
        return preferences.getSnapshot().voice.wakeWord || "";
      if (kind === "auto" && ref === "approvalLevel") return autonomy.getSnapshot().approvalLevel;
      if (kind === "setting" && ref.startsWith("toggle.")) {
        return preferences.getSnapshot().toggles[ref.slice("toggle.".length)] ? "true" : "false";
      }
      if (kind === "setting") return preferences.getSnapshot().fields[ref] || "";
      return fallbackMemory.get(kind, ref);
    },
    set(kind, ref, value) {
      if (
        kind === "router" &&
        ref !== "model" &&
        (ROUTE_STRATEGIES as readonly string[]).includes(value)
      ) {
        void modelRegistry.setStrategy(value as RouteStrategy);
        return;
      }
      if (kind === "voice" && ref === "wakeWord") {
        preferences.setVoice({ wakeWord: value });
        return;
      }
      if (
        kind === "auto" &&
        ref === "approvalLevel" &&
        (value === "strict" || value === "balanced" || value === "trusted" || value === "full")
      ) {
        autonomy.update({ approvalLevel: value });
        return;
      }
      if (kind === "setting" && ref.startsWith("toggle.")) {
        preferences.setToggle(ref.slice("toggle.".length), value === "true");
        return;
      }
      if (kind === "setting") {
        preferences.setField(ref, value);
        return;
      }
      fallbackMemory.set(kind, ref, value);
    },
  };
}

export function memoryHost(
  store = new Map<string, string>(),
): BindHost & { store: Map<string, string> } {
  return {
    store,
    get(kind, ref) {
      return store.get(`${kind}:${ref}`) || "";
    },
    set(kind, ref, value) {
      store.set(`${kind}:${ref}`, value);
    },
  };
}

function sealed(binding: FlowBinding): FlowBinding {
  if (binding.real) return { ...binding, bindable: true };
  const reason =
    binding.reason ||
    (binding.kind === "event"
      ? "This wire reports an event. It does not change a setting."
      : binding.kind === "update"
        ? "This wire reports a check. It does not start a run."
        : binding.ref === "vad"
          ? "The listening check is measured. This chart does not set it."
          : binding.ref === "halted"
            ? "The kill switch is the existing stop control. This wire does not change it."
            : "This wire only describes the code. No module on it can act.");
  return { ...binding, real: false, bindable: false, reason };
}

export function inferBinding(graph: FlowGraph, sourceId: string, targetId: string): FlowBinding {
  const source = graph.nodes.find((node) => node.id === sourceId);
  const target = graph.nodes.find((node) => node.id === targetId);
  const kind = kindFor(source) !== "descriptive" ? kindFor(source) : kindFor(target);
  const ref = source?.source.ref || target?.source.ref || `${sourceId}->${targetId}`;
  const blocked = ref === "vad" || ref === "halted";
  const real = !blocked && kind !== "descriptive" && kind !== "event" && kind !== "update";
  return sealed({
    kind: blocked ? "descriptive" : kind,
    ref,
    value: targetId,
    real,
  });
}

function kindFor(node: FlowGraphNode | undefined): FlowBindingKind {
  if (!node) return "descriptive";
  if (node.source.adapter === "option") return "setting";
  if (
    node.source.adapter === "ipc" ||
    node.source.adapter === "kernel" ||
    node.source.adapter === "message"
  )
    return "event";
  if (node.source.adapter === "capability") return "capability";
  if (node.source.adapter === "ci") return "update";
  if (node.kind === "model" || node.source.adapter === "router") return "router";
  if (node.layer === "voice" || node.source.ref.startsWith("voice")) return "voice";
  if (node.source.ref.startsWith("memory")) return "memory";
  if (node.source.ref.startsWith("auto")) return "auto";
  if (node.kind === "workflow" || node.source.adapter === "workflow") return "workflow";
  return "descriptive";
}

export function bindingCoverage(graph: FlowGraph): {
  real: number;
  descriptive: number;
  total: number;
} {
  let real = 0;
  let descriptive = 0;
  for (const edge of graph.edges) {
    if (edge.binding?.real) real += 1;
    else descriptive += 1;
  }
  return { real, descriptive, total: graph.edges.length };
}

export function feedBinding(node: FlowGraphNode): FlowBinding {
  return inferBinding(
    { ...emptyGraph("feed", "feed"), nodes: [node], edges: [], groups: [] },
    node.id,
    node.id,
  );
}

function asks(level: ApprovalLevel, risk: FlowRisk, approved: boolean): boolean {
  if (approved) return false;
  if (level === "full") return false;
  if (level === "strict") return true;
  return risk === "write" || risk === "exec";
}

export function applyWire(input: {
  binding: FlowBinding;
  risk: FlowRisk;
  level: ApprovalLevel;
  halted: boolean;
  host: BindHost;
  actor: "owner" | "friday";
  why: string;
  source?: "owner" | "data";
  approved?: boolean;
  at: number;
  journal: JournalEntry[];
}): BindResult {
  const journal = input.journal;
  if (input.source === "data") {
    return {
      applied: false,
      needsApproval: false,
      stopped: false,
      reason: "That text is data, not an instruction.",
      journal,
    };
  }
  if (input.halted) {
    return {
      applied: false,
      needsApproval: false,
      stopped: true,
      reason: "Stopped.",
      journal,
    };
  }
  if (!input.binding.real) {
    return {
      applied: false,
      needsApproval: false,
      stopped: false,
      reason:
        input.binding.reason ||
        "This wire only describes the code. Make it real before it can change FRIDAY.",
      journal,
    };
  }
  if (asks(input.level, input.risk, Boolean(input.approved))) {
    return {
      applied: false,
      needsApproval: true,
      stopped: false,
      reason: input.level === "strict" ? "Ask every time." : "Balanced asks before this change.",
      journal,
    };
  }
  const before = input.host.get(input.binding.kind, input.binding.ref);
  input.host.set(input.binding.kind, input.binding.ref, input.binding.value);
  const entry: JournalEntry = {
    id: `j.${input.at}.${journal.length}`,
    at: input.at,
    actor: input.actor,
    why: input.why,
    kind: input.binding.kind,
    ref: input.binding.ref,
    before,
    after: input.binding.value,
    applied: true,
  };
  return {
    applied: true,
    needsApproval: false,
    stopped: false,
    reason: "Applied.",
    journal: [...journal, entry],
  };
}

export function rollbackWire(
  host: BindHost,
  journal: JournalEntry[],
  at: number,
): { journal: JournalEntry[]; restored: boolean } {
  const last = [...journal].reverse().find((entry) => entry.applied);
  if (!last) return { journal, restored: false };
  host.set(last.kind, last.ref, last.before);
  return {
    restored: true,
    journal: [
      ...journal,
      {
        ...last,
        id: `j.${at}.undo`,
        at,
        why: `Roll back ${last.why}`,
        before: last.after,
        after: last.before,
        applied: true,
      },
    ],
  };
}

export function makeReal(
  binding: FlowBinding,
  forge: { stage: string; ok: boolean },
): { binding: FlowBinding; applied: boolean; reason: string } {
  if (!forge.ok || forge.stage !== "done") {
    return {
      binding,
      applied: false,
      reason: "The forge has not finished. Nothing was installed.",
    };
  }
  return {
    applied: true,
    reason: "The wire now points at the finished step. It stays disabled until you enable it.",
    binding: {
      ...binding,
      kind: binding.kind === "descriptive" ? "capability" : binding.kind,
      real: true,
    },
  };
}

export function packInternals(
  record: { id: string; kind: string; name: string; file?: string },
  body?: { steps?: { id?: string; label?: string }[]; permissions?: string[] },
): FlowGraph {
  const root = safeFlowId(`pack.${record.id}`);
  const nodes = [
    nodeOf({
      id: safeFlowId(`${root}.manifest`),
      label: record.name,
      kind: "module",
      module: record.file || "src/lib/friday/flow-bind.ts",
      detail: record.file || "unknown",
      source: { adapter: "capability", ref: record.id },
    }),
    nodeOf({
      id: safeFlowId(`${root}.input`),
      label: "Input",
      kind: "trigger",
      module: record.file || "src/lib/friday/flow-bind.ts",
      detail: "Typed input for this pack.",
      source: { adapter: "capability", ref: `${record.id}:in` },
    }),
    nodeOf({
      id: safeFlowId(`${root}.output`),
      label: "Output",
      kind: "note",
      detail: "Typed output for this pack.",
      source: { adapter: "capability", ref: `${record.id}:out` },
    }),
    nodeOf({
      id: safeFlowId(`${root}.permissions`),
      label: "Permissions",
      kind: "approval",
      module: record.file || "src/lib/friday/flow-bind.ts",
      detail: (body?.permissions || ["unknown"]).join(", "),
      source: { adapter: "capability", ref: `${record.id}:perm` },
    }),
    nodeOf({
      id: safeFlowId(`${root}.health`),
      label: "Health",
      kind: "module",
      module: record.file || "src/lib/friday/flow-bind.ts",
      status: "unknown",
      detail: "unknown",
      source: { adapter: "capability", ref: `${record.id}:health` },
    }),
    nodeOf({
      id: safeFlowId(`${root}.failure`),
      label: "Failure",
      kind: "error",
      module: record.file || "src/lib/friday/flow-bind.ts",
      detail: "unknown",
      source: { adapter: "capability", ref: `${record.id}:fail` },
    }),
  ];
  const steps = body?.steps?.length
    ? body.steps.map((step, index) =>
        nodeOf({
          id: safeFlowId(`${root}.step.${step.id || index}`),
          label: String(step.label || step.id || `Step ${index + 1}`),
          kind: "tool",
          module: record.file || "src/lib/friday/flow-bind.ts",
          source: { adapter: "capability", ref: `${record.id}:step:${index}` },
        }),
      )
    : [
        nodeOf({
          id: safeFlowId(`${root}.steps`),
          label: "Steps",
          kind: "tool",
          module: record.file || "src/lib/friday/flow-bind.ts",
          detail: "unknown",
          source: { adapter: "capability", ref: `${record.id}:steps` },
        }),
      ];
  const all = [...nodes, ...steps];
  const edges = [
    {
      id: safeFlowId(`${root}.e.in`),
      source: nodes[1]!.id,
      target: steps[0]!.id,
      kind: "data" as const,
      binding: { kind: "capability" as const, ref: record.id, value: "input", real: true },
    },
    {
      id: safeFlowId(`${root}.e.out`),
      source: steps[steps.length - 1]!.id,
      target: nodes[2]!.id,
      kind: "data" as const,
      binding: { kind: "capability" as const, ref: record.id, value: "output", real: true },
    },
  ];
  return {
    version: 1,
    id: root,
    title: record.name,
    trusted: true,
    enabled: true,
    nodes: all,
    edges,
    groups: [{ id: "pack", title: record.kind, nodeIds: all.map((node) => node.id) }],
  };
}

export function attachFeeds(graph: FlowGraph): FlowGraph {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const sinks = new Map<string, string>();
  const sinkFor = (key: string, label: string) => {
    const existing = sinks.get(key);
    if (existing) return existing;
    const id = safeFlowId(`feed.${key}`);
    sinks.set(key, id);
    nodes.push(
      nodeOf({
        id,
        label,
        kind: "module",
        module: "src/lib/friday/flow-bind.ts",
        layer: key,
        detail: "Wires in this group land here.",
        source: { adapter: "feed", ref: key },
      }),
    );
    return id;
  };
  graph.nodes.forEach((node, index) => {
    const sink = sinkFor(node.source.adapter || "other", node.source.adapter || "Other");
    const binding = inferBinding(graph, node.id, node.id);
    edges.push({
      id: safeFlowId(`feed.${index}.${node.id}`),
      source: node.id,
      target: sink,
      kind: binding.kind === "event" ? "event" : "data",
      binding,
    });
  });
  return { ...graph, nodes, edges };
}
