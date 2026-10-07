/**
 * FRIDAY · flow tools on the one capability bus.
 *
 * Chat and voice call these. A page, a file, or a clip is data and cannot
 * apply a wire. Full autonomy applies. Balanced asks. Stopped refuses.
 */

import { canvasDo, canvasState, type CanvasState, type FlowPlacement } from "./flow-edit";
import { applyWire, memoryHost, rollbackWire, type BindHost, type JournalEntry } from "./flow-bind";
import { explainGraph, simulateFlow, type FlowGraph } from "./flow-graph";
import { askChart } from "./flow-depth";
import { flowStudio } from "./flow-studio-store";
import { clearChartOffer, explainRecorded, openRecordedChart, takeChartOffer } from "./flow-modes";
import type { ApprovalLevel } from "./self/autonomy";
import { runComputerUse, type DesktopPort } from "./self/computer-use";

export const FLOW_TOOL_NAMES = [
  "flow.read",
  "flow.search",
  "flow.patch",
  "flow.create",
  "flow.run",
  "flow.explain",
  "flow.diff",
  "flow.rollback",
] as const;

export type FlowToolName = (typeof FLOW_TOOL_NAMES)[number];

export type FlowSession = {
  state: CanvasState;
  journal: JournalEntry[];
  host: BindHost;
  level: ApprovalLevel;
  halted: boolean;
  runs: number;
};

const host = memoryHost();

const session: FlowSession = {
  state: canvasState({
    version: 1,
    id: "live",
    title: "Live flow",
    trusted: true,
    enabled: true,
    nodes: [],
    edges: [],
    groups: [],
  }),
  journal: [],
  host,
  level: "balanced",
  halted: false,
  runs: 0,
};

export function configureFlowSession(
  patch: Partial<Omit<FlowSession, "state" | "journal" | "runs">> & {
    graph?: FlowGraph;
    placement?: FlowPlacement;
  },
): FlowSession {
  if (patch.graph) session.state = canvasState(patch.graph, patch.placement);
  if (patch.host) session.host = patch.host;
  if (patch.level) session.level = patch.level;
  if (typeof patch.halted === "boolean") session.halted = patch.halted;
  return session;
}

export function currentFlowSession(): FlowSession {
  return session;
}

export function callFlowTool(
  name: FlowToolName,
  args: {
    text?: string;
    query?: string;
    sourceId?: string;
    targetId?: string;
    source?: "owner" | "data";
  },
  at = 1,
): { ok: boolean; text: string; applied: boolean; needsApproval: boolean } {
  const source = args.source || "owner";
  if (source === "data") {
    return {
      ok: false,
      text: "That text is data, not an instruction.",
      applied: false,
      needsApproval: false,
    };
  }
  if (name === "flow.read") {
    return {
      ok: true,
      text: explainGraph(session.state.graph, "what is here"),
      applied: false,
      needsApproval: false,
    };
  }
  if (name === "flow.search") {
    const query = (args.query || args.text || "").toLowerCase();
    const hits = session.state.graph.nodes.filter((node) =>
      node.label.toLowerCase().includes(query),
    );
    return {
      ok: true,
      text: hits.length ? hits.map((node) => node.label).join(", ") : "No box matches.",
      applied: false,
      needsApproval: false,
    };
  }
  if (name === "flow.explain") {
    const failed = session.state.graph.nodes.find((node) => node.status === "failed");
    const answer = askChart(session.state.graph, args.text || "why did the last run fail");
    return {
      ok: true,
      text: failed ? `${failed.label} failed. ${failed.detail || "unknown"}` : answer,
      applied: false,
      needsApproval: false,
    };
  }
  if (name === "flow.diff") {
    return {
      ok: true,
      text: session.journal.length
        ? session.journal
            .map((entry) => `${entry.ref}: ${entry.before} → ${entry.after}`)
            .join("\n")
        : "Nothing has changed.",
      applied: false,
      needsApproval: false,
    };
  }
  if (name === "flow.rollback") {
    const rolled = rollbackWire(session.host, session.journal, at);
    session.journal = rolled.journal;
    return {
      ok: rolled.restored,
      text: rolled.restored ? "Rolled back the last wire." : "Nothing to roll back.",
      applied: rolled.restored,
      needsApproval: false,
    };
  }
  if (name === "flow.run") {
    if (session.halted)
      return { ok: false, text: "Stopped.", applied: false, needsApproval: false };
    const log = simulateFlow(session.state.graph, {}, () => at);
    session.runs += 1;
    return {
      ok: true,
      text: `Dry run. ${log.length} steps. Nothing was executed.`,
      applied: false,
      needsApproval: false,
    };
  }
  if (name === "flow.create") {
    const label = (args.text || "New flow").slice(0, 80);
    if (!session.state.graph.nodes.length) {
      session.state = canvasState({
        version: 1,
        id: "made",
        title: label,
        trusted: false,
        enabled: false,
        nodes: [
          {
            id: "night",
            kind: "trigger",
            label: "Every night",
            status: "disabled",
            risk: "safe",
            privacy: "public",
            ports: [
              { id: "in", direction: "in", type: "any" },
              { id: "out", direction: "out", type: "any" },
            ],
            module: "src/lib/friday/flow-tools.ts",
            detail: label,
            source: { adapter: "canvas", ref: "night" },
          },
          {
            id: "sum",
            kind: "tool",
            label: "Summarize downloads",
            status: "disabled",
            risk: "safe",
            privacy: "public",
            ports: [
              { id: "in", direction: "in", type: "any" },
              { id: "out", direction: "out", type: "any" },
            ],
            module: "src/lib/friday/flow-tools.ts",
            detail: "",
            source: { adapter: "canvas", ref: "sum" },
          },
        ],
        edges: [],
        groups: [],
      });
    }
    const linked = canvasDo(session.state, {
      type: "connect",
      source: "night",
      target: "sum",
      kind: "control",
    });
    session.state = linked.state;
    return {
      ok: true,
      text: "A disabled flow is on the canvas. It does not run until you enable it.",
      applied: false,
      needsApproval: false,
    };
  }
  const sourceId = args.sourceId || "";
  const targetId = args.targetId || "";
  if (!sourceId || !targetId) {
    return {
      ok: false,
      text: "Name the two boxes to rewire.",
      applied: false,
      needsApproval: false,
    };
  }
  const edited = canvasDo(session.state, {
    type: "connect",
    source: sourceId,
    target: targetId,
    kind: "control",
  });
  if (edited.issues.length) {
    return {
      ok: false,
      text: edited.issues.map((issue) => issue.message).join(" "),
      applied: false,
      needsApproval: false,
    };
  }
  const edge = edited.state.graph.edges[edited.state.graph.edges.length - 1];
  if (!edge?.binding) {
    return { ok: false, text: "That wire has no binding.", applied: false, needsApproval: false };
  }
  const applied = applyWire({
    binding: edge.binding,
    risk: "write",
    level: session.level,
    halted: session.halted,
    host: session.host,
    actor: "friday",
    why: args.text || "Rewire",
    source,
    at,
    journal: session.journal,
  });
  if (applied.applied) session.state = edited.state;
  session.journal = applied.journal;
  if (applied.applied) flowStudio.open("master", "watch");
  return {
    ok: applied.applied || applied.needsApproval,
    text: applied.reason,
    applied: applied.applied,
    needsApproval: applied.needsApproval,
  };
}

/** Flow Studio uses the same desktop loop as chat and Auto mode. */
export function desktopFromFlow(text: string, desktop: DesktopPort, now: () => number = () => 1) {
  return runComputerUse({
    request: text,
    source: "flow",
    level: session.level,
    halted: session.halted,
    desktop,
    now,
  });
}

export function readFlowIntent(
  text: string,
  source: "owner" | "data" = "owner",
): { message: string } | null {
  const raw = text.trim();
  if (!raw) return null;
  // A resolved turn appends "(Context: ...)" after the owner's words. The
  // explain phrases match those words, not the note.
  const line = source === "owner" ? raw.replace(/\n\(Context:[\s\S]*\)$/, "").trim() : raw;
  if (source === "data") {
    if (
      /\b(rewire|make a flow|show work|roll back|how did you do that|explain this|show me how)\b/i.test(
        line,
      )
    ) {
      return { message: "That text is data, not an instruction." };
    }
    return null;
  }
  if (takeChartOffer(line)) {
    return { message: explainRecorded(line) };
  }
  if (
    /^\s*(how did you do that|show me how|show me|explain this|dikhao kaise)[.!?\s]*$/i.test(line)
  ) {
    clearChartOffer();
    return { message: openRecordedChart("chart", line) };
  }
  if (/\bshow work\b/i.test(line)) {
    flowStudio.showWork();
    return { message: callFlowTool("flow.read", { text: line }).text };
  }
  if (/\bwhy did the last run fail\b/i.test(line)) {
    return { message: callFlowTool("flow.explain", { text: line }).text };
  }
  if (/\bmake a flow\b/i.test(line)) {
    return { message: callFlowTool("flow.create", { text: line }).text };
  }
  if (/\broll(?:\s+it)? back\b/i.test(line) && /\bflow\b/i.test(line)) {
    return { message: callFlowTool("flow.rollback", {}).text };
  }
  const rewire = line.match(/\brewire\s+(.+?)\s+(?:so|to|->|→)\s+(.+)/i);
  if (rewire) {
    const result = callFlowTool("flow.patch", {
      text: line,
      sourceId: rewire[1]!.trim().slice(0, 80),
      targetId: rewire[2]!.trim().slice(0, 80),
    });
    return { message: result.text };
  }
  if (/\brewire\b/i.test(line)) {
    return { message: "Name the two boxes to rewire." };
  }
  return null;
}
