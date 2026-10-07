/**
 * FRIDAY · chat and voice charts.
 *
 * Both charts are the same FlowGraph. Chat reads the turn trace and the
 * decision trace. Voice reads the voice state machine. A missing stage
 * says "not recorded".
 */

import type { TurnTraceStep } from "./brain/turn-trace";
import { applyWire, inferBinding, type BindHost, type JournalEntry } from "./flow-bind";
import {
  explainGraph,
  nodeOf,
  type FlowGraph,
  type FlowGraphNode,
  type FlowNodeStatus,
  type FlowRisk,
} from "./flow-graph";
import { flowStudio } from "./flow-studio-store";
import { ROUTE_STRATEGIES, type RouteStrategy } from "./model-routing-contract";
import type { ApprovalLevel } from "./self/autonomy";
import { nextVoiceState, type VoiceEvent, type VoiceState } from "./voice-state";

export const CHAT_TURN_ID = "chat-turn";
export const VOICE_AUTO_ID = "voice-auto";

const NOT_RECORDED = "not recorded";

const VOICE_STATES: VoiceState[] = [
  "OFF",
  "STARTING",
  "LISTENING",
  "SPEECH_DETECTED",
  "TRANSCRIBING",
  "WAKE_DETECTED",
  "COMMAND_LISTENING",
  "THINKING",
  "SPEAKING",
  "INTERRUPTED",
  "WAITING_CONFIRMATION",
  "PAUSED",
  "ERROR",
  "STOPPING",
];

const VOICE_EVENTS: VoiceEvent[] = [
  "session-start",
  "mic-opened",
  "mic-failed",
  "vad-speech",
  "vad-silence",
  "transcribe-start",
  "transcript",
  "wake-matched",
  "wake-missed",
  "command-accepted",
  "brain-replied",
  "confirm-required",
  "confirm-resolved",
  "tts-start",
  "tts-end",
  "tts-failed",
  "barge-in",
  "pause",
  "resume",
  "error",
  "session-stop",
  "stopped",
];

const TRACE_STAGE: Record<string, string> = {
  "thinking.intent": "chat.classify",
  "thinking.understand": "chat.classify",
  "thinking.voice-same-brain": "chat.classify",
  "thinking.context": "chat.route",
  "thinking.planner": "chat.route",
  "thinking.prepare": "chat.route",
  "thinking.cognition": "chat.route",
  "orchestrator.pipeline": "chat.route",
  "router.select": "chat.model",
  "orchestrator.collaboration": "chat.model",
  "agents.registry": "chat.tools",
  "agents.skills": "chat.tools",
  "agents.tools": "chat.tools",
  "execution.runners": "chat.tools",
  "memory.tiers": "chat.memory",
  "verify.answer": "chat.response",
  "orchestrator.report": "chat.response",
  "thinking.observe": "chat.response",
};

type StageSpec = {
  id: string;
  label: string;
  kind: FlowGraphNode["kind"];
  ref: string;
  module: string;
  traceIds: string[];
};

const CHAT_STAGES: StageSpec[] = [
  {
    id: "chat.message",
    label: "Message in",
    kind: "trigger",
    ref: "chat.message",
    module: "src/lib/friday/brain/turn-trace.ts",
    traceIds: [],
  },
  {
    id: "chat.classify",
    label: "Classification",
    kind: "condition",
    ref: "chat.classify",
    module: "src/lib/friday/brain/turn-trace.ts",
    traceIds: ["thinking.intent", "thinking.understand", "thinking.voice-same-brain"],
  },
  {
    id: "chat.route",
    label: "Routing",
    kind: "module",
    ref: "strategy",
    module: "src/lib/friday/model-routing-contract.ts",
    traceIds: [
      "thinking.context",
      "thinking.planner",
      "thinking.prepare",
      "thinking.cognition",
      "orchestrator.pipeline",
    ],
  },
  {
    id: "chat.model",
    label: "Model selection",
    kind: "model",
    ref: "model",
    module: "src/lib/friday/model-registry.ts",
    traceIds: ["router.select", "orchestrator.collaboration"],
  },
  {
    id: "chat.tools",
    label: "Tools and skills",
    kind: "tool",
    ref: "toggle.safeTools",
    module: "src/lib/friday/brain/capability-registry.ts",
    traceIds: ["agents.registry", "agents.skills", "agents.tools", "execution.runners"],
  },
  {
    id: "chat.memory",
    label: "Memory",
    kind: "module",
    ref: "toggle.rememberChats",
    module: "src/lib/friday/brain/memory-policy.ts",
    traceIds: ["memory.tiers"],
  },
  {
    id: "chat.response",
    label: "Response out",
    kind: "note",
    ref: "chat.response",
    module: "src/lib/friday/brain/turn-trace.ts",
    traceIds: ["verify.answer", "orchestrator.report", "thinking.observe"],
  },
];

export type ChatTurnFacts = {
  steps?: TurnTraceStep[];
  message?: string;
  response?: string;
  modelIds?: string[];
  routing?: string;
  strategy?: string;
  safeTools?: string;
  rememberChats?: string;
  /** The answered-by line stored on the message. Same text the chat shows. */
  answeredBy?: string;
};

export type VoiceAutoFacts = {
  voiceState: VoiceState;
  error?: string | null;
  paused?: boolean;
  wakeWord?: string;
  lastWake?: string;
  approvalLevel?: string;
  halted?: boolean;
  attentionWindow?: string;
  stt?: {
    engine?: string;
    ready?: boolean;
    lastTranscript?: string;
    lastError?: string | null;
  };
  tts?: {
    engine?: string | null;
    lastError?: string | null;
    lastSpokenAt?: number | null;
  };
};

type Fold = { status: FlowNodeStatus; detail: string };

function foldSteps(steps: TurnTraceStep[], ids: string[]): Fold {
  const hit = steps.filter((step) => ids.includes(step.nodeId));
  if (!hit.length) return { status: "unknown", detail: NOT_RECORDED };
  const failed = hit.find((step) => step.state === "failed");
  const running = hit.find((step) => step.state === "running");
  const detail =
    hit
      .map((step) => step.detail)
      .filter(Boolean)
      .join(" · ") || NOT_RECORDED;
  if (failed) return { status: "failed", detail: failed.detail || detail };
  if (running) return { status: "running", detail };
  return { status: "ok", detail };
}

function withValue(detail: string, value: string): string {
  if (!value) return detail;
  return `${detail}\nvalue: ${value}`;
}

function link(nodes: FlowGraphNode[], kind: "control" | "event" = "control"): FlowGraph["edges"] {
  const graph = {
    version: 1 as const,
    id: "link",
    title: "link",
    trusted: true,
    nodes,
    edges: [],
    groups: [],
  };
  const edges: FlowGraph["edges"] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const source = nodes[i - 1]!.id;
    const target = nodes[i]!.id;
    edges.push({
      id: `m-${source}-${target}`,
      source,
      target,
      kind,
      binding: inferBinding(graph, source, target),
    });
  }
  return edges;
}

export function modeValue(detail: string): string {
  const match = /(?:^|\n)\s*value:\s*(\S+)/i.exec(detail);
  return match?.[1] || "";
}

export function chatTurnGraph(facts: ChatTurnFacts = {}): FlowGraph {
  const steps = facts.steps || [];
  const nodes = CHAT_STAGES.map((stage) => {
    let folded = foldSteps(steps, stage.traceIds);
    if (stage.id === "chat.message") {
      folded = facts.message
        ? { status: "ok", detail: facts.message.slice(0, 180) }
        : { status: "unknown", detail: NOT_RECORDED };
    }
    if (stage.id === "chat.response" && facts.response && folded.status === "unknown") {
      folded = { status: "ok", detail: facts.response.slice(0, 180) };
    }
    if (stage.id === "chat.model" && folded.status === "unknown" && facts.modelIds?.length) {
      folded = {
        status: "ok",
        detail: `models ${facts.modelIds.join(", ")}. ${facts.routing || NOT_RECORDED}`,
      };
    }
    if (stage.id === "chat.model" && facts.routing && folded.detail === NOT_RECORDED) {
      folded = { ...folded, detail: facts.routing };
    }
    if (stage.id === "chat.model" && facts.answeredBy) {
      folded = {
        status: folded.status === "unknown" ? "ok" : folded.status,
        detail:
          folded.detail === NOT_RECORDED
            ? facts.answeredBy
            : `${facts.answeredBy}\n${folded.detail}`,
      };
    }
    let detail = folded.detail;
    if (stage.id === "chat.route" && facts.strategy) detail = withValue(detail, facts.strategy);
    if (stage.id === "chat.tools" && facts.safeTools) detail = withValue(detail, facts.safeTools);
    if (stage.id === "chat.memory" && facts.rememberChats)
      detail = withValue(detail, facts.rememberChats);
    if (stage.id === "chat.model" && folded.detail !== NOT_RECORDED) {
      detail = `${detail}\nPrivacy and billing firewalls run before this selection.`;
    }
    return nodeOf({
      id: stage.id,
      kind: stage.kind,
      label: stage.label,
      layer: "chat",
      module: stage.module,
      status: folded.status,
      detail,
      source: { adapter: "mode", ref: stage.ref },
    });
  });
  return {
    version: 1,
    id: CHAT_TURN_ID,
    title: "Chat / Manual turn",
    trusted: true,
    enabled: true,
    nodes,
    edges: link(nodes),
    groups: [{ id: "chat-turn", title: "Chat turn", nodeIds: nodes.map((node) => node.id) }],
  };
}

function voiceStatus(id: VoiceState, current: VoiceState, error: string): FlowNodeStatus {
  if (id === "ERROR" && (current === "ERROR" || error)) return "failed";
  if (id === "PAUSED" && current === "PAUSED") return "blocked";
  if (id === "OFF" && current === "OFF") return "disabled";
  if (id !== current) return "idle";
  if (current === "ERROR") return "failed";
  if (current === "PAUSED" || current === "OFF") return "disabled";
  return "running";
}

function pipelineNode(
  id: string,
  label: string,
  kind: FlowGraphNode["kind"],
  ref: string,
  module: string,
  status: FlowNodeStatus,
  detail: string,
): FlowGraphNode {
  return nodeOf({
    id,
    kind,
    label,
    layer: "voice",
    module,
    status,
    detail,
    source: { adapter: id.startsWith("auto.") ? "mode" : "voice-state", ref },
  });
}

export function voiceAutoGraph(facts: VoiceAutoFacts): FlowGraph {
  const error = facts.error || "";
  const stateNodes = VOICE_STATES.map((state) =>
    nodeOf({
      id: `voice.${state}`,
      kind: state === "ERROR" ? "error" : state === "WAITING_CONFIRMATION" ? "approval" : "module",
      label: state,
      layer: "voice",
      module: "src/lib/friday/voice-state.ts",
      status: voiceStatus(state, facts.voiceState, error),
      detail: state === facts.voiceState && error ? error : state,
      source: { adapter: "voice-state", ref: `voice.${state}` },
    }),
  );
  const edges: FlowGraph["edges"] = [];
  for (const state of VOICE_STATES) {
    for (const event of VOICE_EVENTS) {
      const next = nextVoiceState(state, event);
      if (!next || next === state) continue;
      const source = `voice.${state}`;
      const target = `voice.${next}`;
      const id = `vs-${state}-${event}-${next}`.slice(0, 80);
      if (edges.some((edge) => edge.id === id)) continue;
      edges.push({
        id,
        source,
        target,
        kind: "event",
        label: event,
        binding: {
          kind: "event",
          ref: source,
          value: event,
          real: false,
          bindable: false,
          reason: "This wire reports a voice state change. It does not change a setting.",
        },
      });
    }
  }
  const stt = facts.stt;
  const tts = facts.tts;
  const sttFold: Fold = stt?.lastError
    ? { status: "failed", detail: stt.lastError }
    : stt?.lastTranscript
      ? { status: "ok", detail: `${stt.engine || "stt"}: ${stt.lastTranscript}` }
      : { status: "unknown", detail: NOT_RECORDED };
  const ttsFold: Fold = tts?.lastError
    ? { status: "failed", detail: tts.lastError }
    : facts.voiceState === "SPEAKING"
      ? { status: "running", detail: tts?.engine || "speaking" }
      : typeof tts?.lastSpokenAt === "number"
        ? { status: "ok", detail: tts.engine || "spoken" }
        : { status: "unknown", detail: NOT_RECORDED };
  const wakeDetail = facts.lastWake
    ? facts.lastWake
    : facts.voiceState === "WAKE_DETECTED"
      ? "wake matched"
      : NOT_RECORDED;
  const pipeline = [
    pipelineNode(
      "voice.wake",
      "Wake",
      "trigger",
      "wakeWord",
      "src/lib/friday/assistant-mode.ts",
      facts.voiceState === "WAKE_DETECTED" ? "running" : facts.lastWake ? "ok" : "unknown",
      withValue(wakeDetail, facts.wakeWord || ""),
    ),
    pipelineNode(
      "voice.vad",
      "VAD / listening",
      "module",
      "vad",
      "src/lib/friday/voice-state.ts",
      facts.voiceState === "SPEECH_DETECTED" || facts.voiceState === "LISTENING"
        ? "running"
        : "unknown",
      facts.voiceState === "LISTENING" || facts.voiceState === "SPEECH_DETECTED"
        ? facts.voiceState
        : `${NOT_RECORDED}. No VAD threshold is stored.`,
    ),
    pipelineNode(
      "voice.stt",
      "Speech to text",
      "module",
      "stt",
      "src/lib/friday/assistant-mode.ts",
      sttFold.status,
      sttFold.detail,
    ),
    pipelineNode(
      "voice.intent",
      "Intent / routing",
      "condition",
      "intent",
      "src/lib/friday/brain/turn-trace.ts",
      facts.voiceState === "THINKING" || facts.voiceState === "COMMAND_LISTENING"
        ? "running"
        : "unknown",
      facts.voiceState === "THINKING" || facts.voiceState === "COMMAND_LISTENING"
        ? facts.voiceState
        : NOT_RECORDED,
    ),
    pipelineNode(
      "voice.tts",
      "Speaking",
      "note",
      "tts",
      "src/lib/friday/assistant-mode.ts",
      ttsFold.status,
      ttsFold.detail,
    ),
    pipelineNode(
      "auto.trigger",
      "Trigger",
      "trigger",
      "attentionWindow",
      "src/lib/friday/assistant-mode.ts",
      "unknown",
      withValue(NOT_RECORDED, facts.attentionWindow || ""),
    ),
    pipelineNode(
      "auto.plan",
      "Plan",
      "module",
      "auto.plan",
      "src/lib/friday/assistant-mode.ts",
      "unknown",
      NOT_RECORDED,
    ),
    pipelineNode(
      "auto.act",
      "Act",
      "tool",
      "auto.act",
      "src/lib/friday/assistant-mode.ts",
      "unknown",
      NOT_RECORDED,
    ),
    pipelineNode(
      "auto.verify",
      "Verify",
      "module",
      "auto.verify",
      "src/lib/friday/assistant-mode.ts",
      "unknown",
      NOT_RECORDED,
    ),
    pipelineNode(
      "auto.report",
      "Report",
      "note",
      "auto.report",
      "src/lib/friday/assistant-mode.ts",
      "unknown",
      NOT_RECORDED,
    ),
    pipelineNode(
      "auto.approval",
      "Approval",
      "approval",
      "approvalLevel",
      "src/lib/friday/self/autonomy.ts",
      facts.voiceState === "WAITING_CONFIRMATION" ? "awaiting-approval" : "idle",
      withValue(
        facts.voiceState === "WAITING_CONFIRMATION" ? "Waiting for confirmation" : NOT_RECORDED,
        facts.approvalLevel || "",
      ),
    ),
    pipelineNode(
      "auto.kill",
      "Kill switch",
      "error",
      "halted",
      "src/lib/friday/self/autonomy.ts",
      facts.halted ? "blocked" : "idle",
      facts.halted ? "Stopped." : "The existing stop control. This box does not change it.",
    ),
  ];
  const chainIds = [
    "voice.wake",
    "voice.vad",
    "voice.stt",
    "voice.intent",
    "voice.tts",
    "auto.trigger",
    "auto.plan",
    "auto.act",
    "auto.verify",
    "auto.report",
  ];
  const chainNodes = chainIds.map((id) => pipeline.find((node) => node.id === id)!);
  edges.push(...link(chainNodes));
  edges.push({
    id: "auto-approval-gate",
    source: "auto.trigger",
    target: "auto.approval",
    kind: "approval",
    binding: {
      kind: "auto",
      ref: "approvalLevel",
      value: "gate",
      real: false,
      bindable: false,
      reason: "This wire shows the approval gate. Change the level on the Approval box.",
    },
  });
  const nodes = [...stateNodes, ...pipeline];
  return {
    version: 1,
    id: VOICE_AUTO_ID,
    title: "Voice / Auto",
    trusted: true,
    enabled: true,
    nodes,
    edges,
    groups: [
      { id: "voice-states", title: "Voice states", nodeIds: stateNodes.map((node) => node.id) },
      { id: "voice-pipeline", title: "Voice pipeline", nodeIds: chainIds.slice(0, 5) },
      {
        id: "auto-stages",
        title: "Auto",
        nodeIds: [
          "auto.trigger",
          "auto.plan",
          "auto.act",
          "auto.verify",
          "auto.report",
          "auto.approval",
          "auto.kill",
        ],
      },
    ],
  };
}

const MODE_WRITES: Record<
  string,
  {
    kind: "router" | "setting" | "voice" | "auto";
    ref: string;
    risk: FlowRisk;
    real: boolean;
    reason?: string;
  }
> = {
  "chat.route": { kind: "router", ref: "strategy", risk: "write", real: true },
  "chat.tools": { kind: "setting", ref: "toggle.safeTools", risk: "write", real: true },
  "chat.memory": { kind: "setting", ref: "toggle.rememberChats", risk: "write", real: true },
  "voice.wake": { kind: "voice", ref: "wakeWord", risk: "write", real: true },
  "auto.approval": { kind: "auto", ref: "approvalLevel", risk: "write", real: true },
  "auto.trigger": { kind: "setting", ref: "attentionWindow", risk: "write", real: true },
  "voice.vad": {
    kind: "voice",
    ref: "vad",
    risk: "write",
    real: false,
    reason: "The listening check is measured. This chart does not set it.",
  },
};

function acceptValue(nodeId: string, value: string): string {
  if (nodeId === "chat.route") {
    return (ROUTE_STRATEGIES as readonly string[]).includes(value)
      ? ""
      : "That is not a routing strategy.";
  }
  if (nodeId === "chat.tools" || nodeId === "chat.memory") {
    return value === "true" || value === "false" ? "" : "Use true or false.";
  }
  if (nodeId === "voice.wake") {
    return /^[A-Za-z][A-Za-z '-]{0,39}$/.test(value) ? "" : "The wake phrase is not usable.";
  }
  if (nodeId === "auto.approval") {
    return value === "strict" || value === "balanced" || value === "trusted" || value === "full"
      ? ""
      : "That is not an autonomy level.";
  }
  if (nodeId === "auto.trigger")
    return /^\d{1,4}$/.test(value) ? "" : "The trigger window is seconds.";
  return "";
}

export function applyModeDraft(input: {
  graph: FlowGraph;
  level: ApprovalLevel;
  halted: boolean;
  host: BindHost;
  at: number;
  journal: JournalEntry[];
  approved?: boolean;
}): { journal: JournalEntry[]; applied: boolean; needsApproval: boolean; reason: string } {
  let journal = input.journal;
  const notes: string[] = [];
  let applied = false;
  let needsApproval = false;
  for (const node of input.graph.nodes) {
    const write = MODE_WRITES[node.id];
    if (!write) continue;
    const value = modeValue(node.detail);
    if (!value) continue;
    const refused = acceptValue(node.id, value);
    if (refused) {
      notes.push(refused);
      continue;
    }
    const result = applyWire({
      binding: {
        kind: write.kind,
        ref: write.ref,
        value,
        real: write.real,
        bindable: write.real,
        ...(write.real
          ? {}
          : {
              reason: write.reason || "This wire only describes the code. No module on it can act.",
            }),
      },
      risk: write.risk,
      level: input.level,
      halted: input.halted,
      host: input.host,
      actor: "owner",
      why: `Chart edit ${node.label}`,
      source: "owner",
      ...(input.approved ? { approved: true } : {}),
      at: input.at,
      journal,
    });
    journal = result.journal;
    notes.push(result.reason);
    if (result.applied) applied = true;
    if (result.needsApproval) needsApproval = true;
  }
  return {
    journal,
    applied,
    needsApproval,
    reason: notes.join(" ") || "Nothing on this chart was set.",
  };
}

let recorded: FlowGraph | null = null;
let offer: "voice" | "chat" | null = null;

export function rememberRun(graph: FlowGraph): FlowGraph {
  recorded = graph;
  return graph;
}

export function recordedRunGraph(): FlowGraph | null {
  return recorded;
}

export function explainRecorded(question: string): string {
  const graph = recorded || chatTurnGraph({});
  const body = explainGraph(graph, question);
  const shown = new Set(graph.nodes.slice(0, 8).map((node) => node.id));
  const rest = graph.nodes.filter((node) => {
    if (shown.has(node.id)) return false;
    const line = (node.detail.split("\n")[0] || "").trim();
    return Boolean(line) && line !== node.label && !line.startsWith("not recorded");
  });
  if (!rest.length) return body;
  return `${body}\n${explainGraph({ ...graph, nodes: rest }, question)}`;
}

export function openRecordedChart(
  mode: "chart" | "watch" = "chart",
  question = "explain this",
): string {
  const graph = recorded || chatTurnGraph({});
  flowStudio.openBoard(graph, mode);
  return explainGraph(graph, question);
}

export function armChartOffer(kind: "voice" | "chat", graph?: FlowGraph): string {
  offer = kind;
  if (graph) recorded = graph;
  return "Do you want me to show you how?";
}

export function chartOfferPending(): boolean {
  return offer !== null;
}

export function takeChartOffer(text: string): boolean {
  if (!offer) return false;
  if (/^\s*(yes|haan|ha|show me|dikhao)\b/i.test(text)) {
    offer = null;
    openRecordedChart("chart");
    return true;
  }
  return false;
}

export function clearChartOffer(): void {
  offer = null;
}

export function chatEvents(steps: TurnTraceStep[]): {
  nodeId: string;
  status: FlowNodeStatus;
  detail: string;
}[] {
  return steps.flatMap((step) => {
    const nodeId = TRACE_STAGE[step.nodeId];
    if (!nodeId) return [];
    const status: FlowNodeStatus =
      step.state === "failed" ? "failed" : step.state === "running" ? "running" : "ok";
    return [{ nodeId, status, detail: step.detail || NOT_RECORDED }];
  });
}

export function isRouteStrategy(value: string): value is RouteStrategy {
  return (ROUTE_STRATEGIES as readonly string[]).includes(value);
}
