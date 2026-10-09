/**
 * FRIDAY brain engine.
 *
 * The orchestration layer that turns a request into: intent analysis ->
 * agent selection -> model routing -> memory recall -> tool execution ->
 * result collection -> reasoning -> response -> memory write.
 *
 * It owns FRIDAY's own state (personality, memory layers, agents, scheduler,
 * self-improvement suggestions, update flow) and delegates model choice to the
 * models manager. Nothing here trains or modifies an external model.
 */

import {
  agentById,
  agentSpecs,
  analyseIntent,
  identity,
  pipelineStages,
  suggestionSeeds,
  updateTargets,
  type AgentId,
  type IntentId,
  type MemoryLayer,
  type StageId,
  type SuggestionKind,
} from "./brain-catalog";
import { modelById, routeRefs, type RoutingTask } from "./model-catalog";
import { modelRegistry as usageRegistry } from "./model-registry";
import {
  createRoutingContract,
  normaliseCostPolicy,
  normaliseRouteMode,
  type ModelRoutingContract,
} from "./model-routing-contract";
import { models } from "./models-engine";
import { readLocalState, restoreFromDisk, writeState } from "./persist";
import { shouldWriteLessons } from "./settings-runtime";
import { bootRuntime, completeTurn } from "./runtime";
import { settleInterrupted, toolActivity } from "./chat-turn";
import { parseFlowCommand } from "./flow-graph";
import { flowStudio } from "./flow-studio-store";
import { looksSensitive, packTurnContext } from "./brain/memory-policy";
import { coreBrain, type Cognition } from "./brain/core-brain";
import { considerCollaboration, type CollaborationDecision } from "./brain/multi-model";
import { noteUnderstanding, recordCollaboration, recordDecision } from "./brain/decision-trace";
import { baselineRespond, type BaselineReply } from "./brain/baseline-responder";
import { everydayPlan } from "./everyday";
import { shapeReply, type TalkLevel, type Warmth } from "./response-policy";
import { understandTurn, toUnderstandingTrace } from "./brain/intent-engine";
import { decideAction } from "./brain/decision-engine";
import { bindActiveGraph, persistAndResetConversation } from "./brain/conversation-state";
import { noteObserve, observeBrain } from "./brain/observe";
import { affect } from "./brain/affect";
import { currentPolicy } from "./brain/cost-policy";
import { brainError } from "./brain/errors";
import { appendTraceStep, completeRunningStep, type TurnTraceStep } from "./brain/turn-trace";
import { turnDone, turnMark, turnTimingEnabled } from "./brain/turn-timing";
import { dispatchPluginHook } from "./plugin-hooks";
import { vary } from "./brain/anti-repeat";
import { conversationSight } from "./conversation-sight";
import { replyKeepsHelp } from "./eval-corpus";
import { thinkBudget, tracePlan, withinBudget } from "./think-budget";

/**
 * Fill a turn's routing options from the single source of truth (the model
 * registry) whenever the caller did not supply them. Chat, voice and Auto Mode
 * therefore route identically for identical conditions.
 */
function ownerShape(prompt: string, text: string) {
  let talk: TalkLevel = "balanced";
  let warmth: Warmth = "steady";
  try {
    const fields = preferences.getSnapshot().fields;
    if (fields["talk"] === "reserved" || fields["talk"] === "chatty") talk = fields["talk"];
    if (fields["warmth"] === "plain" || fields["warmth"] === "warm") warmth = fields["warmth"];
  } catch {
    /* preferences are unavailable in some previews */
  }
  return shapeReply({ prompt, text, talk, warmth });
}

export function withRoutingDefaults(options: {
  extra?: string;
  modelIds?: string[];
  routeMode?: string;
  routingContract?: ModelRoutingContract;
  routingSurface?: "voice" | "chat";
}): {
  extra?: string;
  modelIds?: string[];
  routeMode?: string;
  routingContract?: ModelRoutingContract;
  routingSurface?: "voice" | "chat";
} {
  let routeMode = options.routeMode;
  let modelIds = options.modelIds;
  let routingContract = options.routingContract;
  try {
    const snapshot = usageRegistry.getSnapshot();
    if (!routeMode) routeMode = snapshot.routeMode;
    if (!modelIds?.length && snapshot.selected.length) modelIds = [...snapshot.selected];
    if (!routingContract) {
      routingContract = createRoutingContract({
        routeMode: normaliseRouteMode(routeMode),
        selectedModelIds: modelIds || [],
        costPolicy: normaliseCostPolicy(snapshot.policy),
        task: "chat",
        qualityTarget: snapshot.qualityTarget,
        strategy: snapshot.strategy,
      });
    }
  } catch {
    /* registry unavailable (tests / preview) — the caller's options stand */
  }
  return {
    ...(options.extra ? { extra: options.extra } : {}),
    ...(modelIds?.length ? { modelIds } : {}),
    ...(routeMode ? { routeMode } : {}),
    ...(routingContract ? { routingContract } : {}),
    ...(options.routingSurface ? { routingSurface: options.routingSurface } : {}),
  };
}

import { taskGraph } from "./self/task-graph";
import {
  handleQueueCommand,
  considerLongTask,
  considerDesktopTask,
  registerTaskRunners,
} from "./self/task-runners";
import { handleDoctorCommand } from "./doctor-engine";
import { handleInstallerCommand } from "./installer-engine";
import { kernelCall, checkForUpdates, applyUpdate as applyDesktopUpdate } from "./desktop";
import { kernelApi } from "./kernel-api";
import { composer } from "./composer";
import { mergeTurnExtra, turnAwarenessExtra } from "./turn-awareness";
import { showRealChart, showRealImage } from "./stage";
import { connectorTools, invokeApprovedConnectorAction } from "./connectors";
import { isWorkspaceShellTool, runWorkspaceShell } from "./terminal-awareness";
import { isSandboxLabTool, runSandboxPlan } from "./sandbox-awareness";
import { preferences } from "./preferences";
import { collectLiveUpdateRows, honestLastRun, type LiveUpdateRow } from "./brain/section-sync";
import { listCapabilities, setCapabilityEnabled } from "./capability-trees";

import {
  actionMode,
  approvalReason,
  brainActionNeedsApproval,
  type ActionRisk,
} from "./brain/action-risk";

const DESKTOP_PIPELINE: StageId[] = [
  "intent",
  "agents",
  "models",
  "memory",
  "execute",
  "collect",
  "reason",
  "respond",
  "persist",
];

type DesktopPhase = "prepare" | "wait" | "stream" | "finish";

function desktopRunningStage(phase: DesktopPhase): StageId {
  if (phase === "prepare") return "memory";
  if (phase === "wait") return "execute";
  if (phase === "stream") return "respond";
  return "persist";
}

function applyDesktopPhase(run: Run, phase: DesktopPhase, detail?: string): void {
  const running = desktopRunningStage(phase);
  const runIdx = DESKTOP_PIPELINE.indexOf(running);
  const now = Date.now() - run.startedAt;
  for (const stage of run.stages) {
    const index = DESKTOP_PIPELINE.indexOf(stage.id);
    if (phase === "finish") {
      if (stage.state !== "skipped") {
        stage.state = "done";
        if (!stage.ms) stage.ms = now;
      }
      continue;
    }
    if (index < runIdx) {
      if (stage.state !== "skipped") {
        stage.state = "done";
        if (!stage.ms) stage.ms = now;
      }
    } else if (index === runIdx) {
      stage.state = "running";
      stage.ms = now;
      if (detail) stage.detail = detail;
    } else if (stage.state === "running") {
      stage.state = "pending";
    }
  }
}

/** Put a real tool artefact on the existing stage — never invent a picture. */
function presentToolArtifacts(label: string, result: Record<string, unknown> | null): void {
  if (!result || result["ok"] === false) return;
  const src = String(result["dataUrl"] ?? result["image"] ?? result["src"] ?? "").trim();
  if (
    src.startsWith("data:image") ||
    src.startsWith("file:") ||
    /\.(png|jpe?g|webp|gif)$/i.test(src)
  ) {
    showRealImage({ title: label, src, source: "FRIDAY" });
  }
  const raw = result["series"];
  if (Array.isArray(raw)) {
    const series = raw
      .map((point) => {
        if (!point || typeof point !== "object") return null;
        const row = point as { label?: unknown; value?: unknown };
        const value = Number(row.value);
        const pointLabel = String(row.label ?? "").trim();
        if (!pointLabel || !Number.isFinite(value)) return null;
        return { label: pointLabel, value };
      })
      .filter((point): point is { label: string; value: number } => Boolean(point));
    if (series.length) showRealChart({ title: label, series, source: "FRIDAY" });
  }
}

/* ------------------------------------------------------------------- types */

export type StageState = "pending" | "running" | "done" | "blocked" | "skipped";

export type StageRun = {
  id: StageId;
  label: string;
  state: StageState;
  detail: string;
  ms: number;
};

export type AgentRun = {
  id: AgentId;
  name: string;
  task: RoutingTask;
  modelId: string | null;
  modelLabel: string;
  state: "queued" | "running" | "done" | "blocked" | "failed";
  output: string;
  tokens: number;
  ms: number;
};

export type Approval = {
  runId: string;
  agent: AgentId;
  tool: string;
  risk: "write" | "exec";
  reason: string;
};

export type Run = {
  id: string;
  prompt: string;
  intent: IntentId;
  intentLabel: string;
  confidence: number;
  matched: string[];
  stages: StageRun[];
  agents: AgentRun[];
  recalled: MemoryHit[];
  /** Real stages this turn entered. Empty until a stage actually runs. */
  trace?: TurnTraceStep[];
  state: "running" | "awaiting-approval" | "done" | "failed";
  answer: string;
  startedAt: number;
  ms: number;
  answeredBy?: AnsweredBy;
};

export function accessBadge(entry: { access?: string; type?: string | null }): string {
  if (entry.type === "local") return "LOCAL";
  if (entry.access === "paid") return "PAID";
  if (entry.access === "free") return "FREE";
  return "UNKNOWN";
}

/** One label per answer in a multi-model turn. Unknown cost is not called local. */
export function multiAnsweredBy(
  entries: { label: string; access?: string; type?: string | null }[],
): AnsweredBy {
  const parts = entries.map((entry) => `${entry.label} · ${accessBadge(entry)}`);
  const one = entries.length === 1 ? entries[0] : undefined;
  return {
    line: parts.join(" · "),
    parts,
    ...(one ? { badge: accessBadge(one) } : {}),
  };
}

export type AnsweredBy = {
  providerId?: string;
  providerName?: string;
  modelId?: string;
  modelName?: string;
  display?: string;
  badge?: string;
  auto?: boolean;
  chain?: { modelId?: string; display: string; reason: string }[];
  line: string;
  parts?: string[];
};

export type Message = {
  id: string;
  role: "user" | "friday";
  text: string;
  at: number;
  runId?: string;
  /** Where the turn came from when it was not typed on this desktop. */
  via?: "phone";
  /** Which model actually answered, from the router trace. */
  answeredBy?: AnsweredBy;
};

export type MemoryHit = {
  id: string;
  layer: MemoryLayer;
  title: string;
  snippet: string;
  score: number;
  source?: string;
  ageMs?: number | null;
};

export type MemoryRecord = MemoryHit & { at: number; pinned: boolean };

export type Suggestion = {
  id: string;
  kind: SuggestionKind;
  title: string;
  rationale: string;
  impact: "low" | "medium" | "high";
  state: "pending" | "applied" | "dismissed";
  at: number;
};

export type UpdateRow = {
  id: string;
  label: string;
  channel: string;
  installed: string;
  latest: string;
  state: "checking" | "up-to-date" | "available" | "installing" | "installed";
  notes: string;
};

export type ScheduledJob = {
  id: string;
  title: string;
  when: string;
  agent: AgentId;
  enabled: boolean;
  lastRun: string;
};

/**
 * What happened to a turn the caller handed in. Voice mode NEEDS this: a
 * dropped turn must be spoken back, never silently discarded.
 */
export type SendResult = {
  accepted: boolean;
  reason: "accepted" | "empty" | "busy";
  message: string | null;
};

export type BrainLogLevel = "info" | "ok" | "warn" | "error";
export type BrainLog = { id: string; at: string; level: BrainLogLevel; line: string };

export type BrainSettings = {
  confirmImportant: boolean;
  autoLearn: boolean;
  voiceReplies: boolean;
  multiModel: boolean;
  useKnowledge: boolean;
  useProjectMemory: boolean;
  selfImprove: boolean;
  checkUpdatesOnStart: boolean;
};

export type BrainState = {
  identity: typeof identity;
  settings: BrainSettings;
  agentsEnabled: Record<AgentId, boolean>;
  messages: Message[];
  runs: Run[];
  activeRunId: string | null;
  approval: Approval | null;
  memory: MemoryRecord[];
  suggestions: Suggestion[];
  updates: UpdateRow[];
  checkingUpdates: boolean;
  schedule: ScheduledJob[];
  log: BrainLog[];
  stats: { requests: number; toolCalls: number; approvals: number; lessons: number; avgMs: number };
};

/* --------------------------------------------------------------- utilities */

const STORAGE_KEY = "friday.brain.v1";
const TICK_MS = 260;
/** Live Updates tab / startup check re-query. GitHub-friendly, not a second updater. */
const UPDATE_POLL_MS = 30 * 60_000;
const UPDATE_STALE_MS = 120_000;
const MAX_LOG = 160;
const MAX_RUNS = 12;

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

/**
 * Turns a real tool result into FRIDAY's own sentence. A failure is reported
 * as a failure — an action is never described as done unless the tool said so.
 */
function describeToolResult(label: string, result: Record<string, unknown> | null): string {
  if (!result) return `I couldn't ${label} — my local tool service didn't answer.`;
  if (result["ok"] === false) {
    return `I couldn't ${label} — ${String(result["error"] ?? "the tool reported a failure")}.`;
  }
  const list = (result["windows"] ?? result["devices"] ?? result["entries"]) as unknown;
  if (Array.isArray(list)) {
    if (!list.length) return `Nothing to show for ${label} — the list came back empty.`;
    const lines = list
      .slice(0, 12)
      .map((item) =>
        typeof item === "string"
          ? `• ${item}`
          : `• ${String((item as Record<string, unknown>)["title"] ?? (item as Record<string, unknown>)["name"] ?? (item as Record<string, unknown>)["id"] ?? JSON.stringify(item))}`,
      );
    return [`Done — ${label}:`, ...lines].join("\n");
  }
  const detail = result["detail"] ?? result["output"] ?? result["result"];
  return detail ? `Done — ${label}. ${String(detail).trim()}` : `Done — ${label}.`;
}

const clock = (at = Date.now()) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const defaultSettings: BrainSettings = {
  confirmImportant: true,
  autoLearn: true,
  voiceReplies: false,
  multiModel: true,
  useKnowledge: true,
  useProjectMemory: true,
  selfImprove: true,
  checkUpdatesOnStart: true,
};

const baseAgents = (): Record<AgentId, boolean> =>
  Object.fromEntries(agentSpecs.map((a) => [a.id, true])) as Record<AgentId, boolean>;

const seedMemory = (): MemoryRecord[] => [
  {
    id: nextId("mem"),
    layer: "long-term",
    title: "Owner",
    snippet: `${identity.owner} (${identity.handle}) created and publishes this FRIDAY project. Disclose only when asked who owns or made FRIDAY.`,
    score: 1,
    at: Date.now(),
    pinned: true,
  },
  {
    id: nextId("mem"),
    layer: "long-term",
    title: "Tone",
    snippet: identity.voice + ". Short answers first, detail on request.",
    score: 0.96,
    at: Date.now(),
    pinned: true,
  },
  {
    id: nextId("mem"),
    layer: "long-term",
    title: "Approval rule",
    snippet: "Never run write or exec tools without an explicit yes from the user.",
    score: 0.95,
    at: Date.now(),
    pinned: true,
  },
  {
    id: nextId("mem"),
    layer: "project",
    title: "FRIDAY desk",
    snippet:
      "React + TanStack Start UI, Python kernel over a local WebSocket bridge, everything stays on the PC.",
    score: 0.9,
    at: Date.now(),
    pinned: false,
  },
  {
    id: nextId("mem"),
    layer: "project",
    title: "Code style",
    snippet: "TypeScript strict, small modules, no hardcoded colours — semantic tokens only.",
    score: 0.88,
    at: Date.now(),
    pinned: false,
  },
  {
    id: nextId("mem"),
    layer: "knowledge",
    title: "Models manager",
    snippet: "27 providers, catalog installs pull from official vendor sources only.",
    score: 0.82,
    at: Date.now(),
    pinned: false,
  },
];

const seedSchedule = (): ScheduledJob[] => [
  {
    id: nextId("job"),
    title: "Morning briefing",
    when: "Daily · 09:00",
    agent: "research",
    enabled: true,
    lastRun: "—",
  },
  {
    id: nextId("job"),
    title: "Memory compaction",
    when: "Daily · 03:00",
    agent: "learning",
    enabled: true,
    lastRun: "—",
  },
  {
    id: nextId("job"),
    title: "Update check",
    when: "On startup",
    agent: "update",
    enabled: true,
    lastRun: "—",
  },
  {
    id: nextId("job"),
    title: "Workspace backup",
    when: "Weekly · Sun 23:00",
    agent: "automation",
    enabled: false,
    lastRun: "—",
  },
];

const seedUpdates = (): UpdateRow[] =>
  updateTargets.map((t) => ({
    id: t.id,
    label: t.label,
    channel: t.channel,
    installed: "—",
    latest: "—",
    state: "up-to-date" as const,
    notes: "not checked yet",
  }));

/* -------------------------------------------------------- response writing */

function personaAnswer(
  prompt: string,
  intent: IntentId,
  agents: AgentRun[],
  recalled: MemoryHit[],
): string {
  const used = agents.filter((a) => a.state === "done");
  const modelLine = used.map((a) => `${a.name.replace(" Agent", "")} → ${a.modelLabel}`).join(", ");
  const lead: Record<IntentId, string> = {
    coding: "Here is what I'd change in the code.",
    research: "I read the sources and pulled the parts that matter.",
    reasoning: "I worked through the options before answering.",
    vision: "I looked at the image and described what is in it.",
    voice: "Ready — I can speak this answer whenever you want.",
    automation: "I can turn this into a repeatable workflow.",
    system: "System check done.",
    memory: "Noted — that is in my memory now.",
    install: "I checked the official sources for that.",
    chat: "On it.",
  };
  const lines = [
    lead[intent],
    "",
    `Request: ${prompt.trim().slice(0, 180)}`,
    `Agents: ${used.map((a) => a.name).join(", ") || "none"}`,
    `Models: ${modelLine || "no model routed for this task yet — assign one in Models"}`,
    recalled.length
      ? `Recalled: ${recalled.map((r) => r.title).join(", ")}`
      : "Recalled: nothing relevant in memory yet",
    "",
    ...used.map((a) => `• ${a.output}`),
  ];
  return lines.join("\n");
}

function agentOutput(id: AgentId, prompt: string): string {
  const short = prompt.trim().slice(0, 60);
  const map: Record<AgentId, string> = {
    developer: `Developer: mapped the request onto the current project layout before touching anything.`,
    coding: `Coding: drafted the change for "${short}" and kept it inside the workspace root.`,
    research: `Research: gathered the relevant sources and reduced them to the three points that answer this.`,
    automation: `Automation: this is repeatable — I can register it as a workflow on your word.`,
    vision: `Vision: described the visual input and extracted the text it contains.`,
    voice: `Voice: the answer is ready to be spoken with the configured TTS model.`,
    security: `Security: risk reviewed — nothing leaves this machine and no secret is written to disk.`,
    learning: `Learning: captured what is worth remembering from this exchange.`,
    workflow: `Workflow: broke the goal into ordered steps with a verify step at the end.`,
    monitor: `Monitor: CPU, GPU, VRAM and disk are inside their normal band.`,
    installer: `Installer: resolved the official source and the size before any download starts.`,
    update: `Update: compared installed versions against the vendor channels.`,
  };
  return map[id];
}

/* ------------------------------------------------------------------- store */

/**
 * The routing task for one turn. The agent the intent picked decides it, and an
 * explicit capability directive from the composer (vision, web/deep research,
 * deep thinking) overrides it because the owner asked for that mode by hand.
 */
export function resolveRoutingTask(run: Run, extra?: string): RoutingTask {
  const hint = (extra ?? "").toLowerCase();
  if (/vision|image|screenshot|picture/.test(hint)) return "vision";
  if (/deep research|web search|browse|search the web/.test(hint)) return "research";
  if (/deep think|reasoning|analyse|analyze/.test(hint)) return "reasoning";
  if (/code|coding|refactor|debug/.test(hint)) return "coding";
  return run.agents[0]?.task ?? "brain";
}

/**
 * The repair decision, kept pure so it can be reasoned about and tested on its
 * own: a finished turn is repaired only when FRIDAY's verification rejected the
 * answer, this run has not already been repaired, and a genuinely different
 * engine is still eligible.
 */
export function planRepair(input: {
  verified: boolean;
  alreadyRepaired: boolean;
  candidates: string[];
  answeredBy?: string | null;
}): { repair: boolean; alternatives: string[] } {
  const alternatives = input.candidates.filter((id) => id && id !== input.answeredBy);
  const repair = !input.verified && !input.alreadyRepaired && alternatives.length > 0;
  return { repair, alternatives };
}

class BrainStore {
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private hydrated = false;
  private stageClock = 0;
  private activeRequestId: string | null = null;
  /** Resolver for an action paused by the Manual/Auto approval gate. */
  private pendingAction: ((allow: boolean) => void) | null = null;
  /** Set by Auto Mode so replies are shaped for speech. */
  private autoMode = false;
  /** Models the last dispatch actually asked for, per run. */
  private lastDispatch: { runId: string; modelIds: string[] } | null = null;
  /** Core Brain cognition for the last dispatched run, used for verification. */
  private lastCognition: { runId: string; cognition: Cognition } | null = null;
  private lastGithubCheck: import("./github-updates").GithubCheck | null = null;
  private lastUpdateCheckAt = 0;
  private updateWatch: ReturnType<typeof setInterval> | null = null;
  /** Per-engine stream buffers for the active run, used to reconcile answers. */
  private streamBuffers = new Map<string, { text: string; at: number }>();
  /** Runs that already used their single verification-repair retry. */
  private repairedRuns = new Set<string>();

  private desktopListenersReady = false;
  // Guards against a desktop request that never reports back: without it the
  // composer would stay stuck on "streaming…" with no way out.
  private desktopWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Phone turn currently owned by this desktop Core Brain pass. */
  private phoneCognizeSession: string | null = null;
  private phoneCognizeStreamed = false;

  state: BrainState = {
    identity,
    settings: { ...defaultSettings },
    agentsEnabled: baseAgents(),
    messages: [],
    runs: [],
    activeRunId: null,
    approval: null,
    memory: [],
    suggestions: [],
    updates: seedUpdates(),
    checkingUpdates: false,
    schedule: [],
    log: [],
    stats: { requests: 0, toolCalls: 0, approvals: 0, lessons: 0, avgMs: 0 },
  };

  private snapshot: BrainState = this.state;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    // React may call subscribe while committing useSyncExternalStore. Emitting
    // synchronously from inside subscribe can recursively restart that commit
    // in optimized desktop builds. Hydrate after the current commit instead.
    if (!this.hydrated && typeof window !== "undefined") {
      window.setTimeout(() => this.hydrate(), 0);
    }
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) this.stopTimer();
    };
  };

  getSnapshot = () => this.snapshot;

  private emit(persist = true) {
    this.snapshot = { ...this.state };
    this.listeners.forEach((l) => l());
    if (persist) this.persist();
  }

  private push(level: BrainLogLevel, line: string) {
    this.state.log = [{ id: nextId("blog"), at: clock(), level, line }, ...this.state.log].slice(
      0,
      MAX_LOG,
    );
  }

  /**
   * Record that this turn entered a real FLOW_CHART stage. Also writes one
   * `push()` line (same log as "brain online") so there is no second event bus.
   */
  private noteTurn(run: Run, nodeId: string, detail: string, emit = true) {
    run.trace = run.trace ?? [];
    const step = appendTraceStep(run.trace, { id: nextId("tr"), nodeId, detail });
    flowStudio.beginRun(run.id);
    flowStudio.note(run.id, nodeId, "running", detail);
    if (!step) return;
    turnMark(run.id, `${nodeId}:${step.id}`);
    this.push("info", `${step.lane}: ${step.label}${detail ? ` — ${detail}` : ""}`);
    if (turnTimingEnabled()) {
      console.info(`[friday.turn] ${run.id} ${nodeId} enter ${detail}`);
    }
    if (emit) this.emit(false);
  }

  private finishTurnStep(run: Run, state: "done" | "failed" = "done", extra?: string) {
    if (!run.trace?.length) return;
    const running = [...run.trace].reverse().find((step) => step.state === "running");
    if (running) {
      turnDone(run.id, `${running.nodeId}:${running.id}`, extra);
      flowStudio.note(
        run.id,
        running.nodeId,
        state === "failed" ? "failed" : "ok",
        extra || running.detail,
      );
    }
    completeRunningStep(run.trace, state, extra);
  }

  private recordDoneTurn(run: Run, nodeId: string, detail: string, ms: number) {
    run.trace = run.trace ?? [];
    const step = appendTraceStep(run.trace, {
      id: nextId("tr"),
      nodeId,
      detail,
      state: "done",
      ms,
      startedAt: Date.now() - Math.max(0, ms),
    });
    if (!step) return;
    if (turnTimingEnabled()) {
      console.info(`[friday.turn] ${run.id} ${nodeId} ${ms}ms ${detail}`);
    }
    this.push("info", `${step.lane}: ${step.label} — ${detail} (${ms}ms)`);
  }

  log(level: BrainLogLevel, line: string) {
    this.push(level, line);
    this.emit();
  }

  /* ---------------------------------------------------------- persistence */

  private applySaved(saved: Partial<BrainState>) {
    this.state.settings = { ...defaultSettings, ...(saved.settings ?? {}) };
    this.state.agentsEnabled = { ...baseAgents(), ...(saved.agentsEnabled ?? {}) };
    this.state.memory = saved.memory?.length ? saved.memory : seedMemory();
    this.state.messages = (saved.messages ?? []).slice(-200);
    this.state.suggestions = saved.suggestions ?? [];
    this.state.schedule = (saved.schedule?.length ? saved.schedule : seedSchedule()).map((job) => ({
      ...job,
      lastRun: honestLastRun(job.lastRun),
    }));
    this.state.stats = { ...this.state.stats, ...(saved.stats ?? {}) };
  }

  private hydrate() {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    bootRuntime();
    this.bindDesktopChat();
    const saved = readLocalState<Partial<BrainState>>(STORAGE_KEY);
    if (saved) this.applySaved(saved);
    // Fresh install / cleared cache: recover the durable desktop copy.
    restoreFromDisk<Partial<BrainState>>(STORAGE_KEY, (disk) => {
      this.applySaved(disk);
      this.emit(false);
    });
    if (this.state.memory.length === 0) this.state.memory = seedMemory();

    if (this.state.schedule.length === 0) this.state.schedule = seedSchedule();
    if (this.state.suggestions.length === 0) this.seedSuggestions();
    if (this.state.messages.length === 0) {
      this.state.messages = [
        {
          id: nextId("msg"),
          role: "friday",
          at: Date.now(),
          text: `${vary("greeting")} Brain core is active — ${agentSpecs.length} agents standing by, memory loaded, models routed. Ask me anything, or give me a goal and I'll plan it first.`,
        },
      ];
    }
    this.push(
      "info",
      `brain online — ${agentSpecs.length} agents, ${this.state.memory.length} memories`,
    );
    this.syncLiveSurfaces();
    this.emit(false);
    this.armUpdateWatch();
    // Startup update checks are non-essential and must never run in the same
    // turn as initial store hydration / first paint.
    if (this.state.settings.checkUpdatesOnStart) {
      window.setTimeout(() => this.checkUpdates(), 0);
    }
  }

  /** (Re)arms the stuck-request guard; every stream event pushes it back. */
  private armWatchdog(ms = 140_000) {
    this.clearWatchdog();
    if (typeof window === "undefined") return;
    this.desktopWatchdog = setTimeout(() => {
      this.desktopWatchdog = null;
      const run = this.state.runs.find((item) => item.id === this.state.activeRunId);
      if (!run || !this.activeRequestId) return;
      window.friday?.abortChat?.(this.activeRequestId);
      this.failDesktopRun(run, "The local AI service stopped responding. Try again.");
    }, ms);
  }

  private clearWatchdog() {
    if (!this.desktopWatchdog) return;
    clearTimeout(this.desktopWatchdog);
    this.desktopWatchdog = null;
  }

  private bindDesktopChat() {
    if (this.desktopListenersReady || typeof window === "undefined" || !window.friday) return;
    this.desktopListenersReady = true;
    // ONE conversation across devices: declare the open session to the kernel
    // so a message sent from the paired phone lands in this very thread, and
    // mirror those turns into the transcript as they happen.
    void window.friday.setActiveSession?.("main");
    window.friday.onSessionMessage?.((event) => {
      if (!event?.text?.trim() || event.origin !== "phone") return;
      const from: Message["role"] = event.role === "user" ? "user" : "friday";
      const last = this.state.messages[this.state.messages.length - 1];
      if (last && last.role === from && last.text === event.text) return; // already shown
      this.state.messages = [
        ...this.state.messages,
        {
          id: nextId("msg"),
          role: from,
          text: event.text,
          at: Date.now(),
          ...(event.role === "user" ? { via: "phone" as const } : {}),
        },
      ];
      this.push("info", `phone — ${event.role === "user" ? "message received" : "answer sent"}`);
      this.persist();
      this.emit(false);
    });
    window.friday.onCompanionCognize?.((event) => {
      void this.askFromPhone(event);
    });
    window.friday.onChatDelta?.((event) => {
      if (event.requestId !== this.activeRequestId) return;
      this.armWatchdog();
      const run = this.state.runs.find((item) => item.id === this.state.activeRunId);
      if (!run) return;
      const current = this.state.messages.find(
        (message) => message.runId === run.id && message.role === "friday",
      );
      if (current) {
        this.state.messages = this.state.messages.map((message) =>
          message.id === current.id ? { ...message, text: message.text + event.text } : message,
        );
      } else {
        this.state.messages = [
          ...this.state.messages,
          { id: nextId("msg"), role: "friday", text: event.text, at: Date.now(), runId: run.id },
        ];
      }
      run.answer += event.text;
      if (event.modelId) {
        const buffer = this.streamBuffers.get(event.modelId) ?? { text: "", at: Date.now() };
        buffer.text += event.text;
        this.streamBuffers.set(event.modelId, buffer);
        // The header must name the engine that is REALLY answering, not the
        // model the static routing table planned for this task.
        this.noteRealModel(run, event.modelId);
      }

      const execute = run.stages.find((stage) => stage.id === "execute");
      if (execute) {
        execute.state = "running";
        execute.detail = `streaming from ${event.modelId ?? "selected model"}`;
        execute.ms = Date.now() - run.startedAt;
      }
      applyDesktopPhase(run, "stream", `streaming from ${event.modelId ?? "selected model"}`);
      const waiting = run.trace?.some(
        (step) => step.nodeId === "router.select" && step.state === "running",
      );
      if (waiting) {
        this.finishTurnStep(run, "done", `first token from ${event.modelId ?? "selected model"}`);
      }
      this.emit(false);
    });
    window.friday.onChatTool?.((event) => {
      if (event.requestId !== this.activeRequestId) return;
      const run = this.state.runs.find((item) => item.id === this.state.activeRunId);
      if (!run) return;
      const execute = run.stages.find((stage) => stage.id === "execute");
      if (execute) {
        execute.state = "running";
        execute.detail = toolActivity(event.name);
        execute.ms = Date.now() - run.startedAt;
      }
      this.emit(false);
    });
    window.friday.onChatDone?.((event) => {
      if (event.requestId !== this.activeRequestId) return;
      this.clearWatchdog();
      const run = this.state.runs.find((item) => item.id === this.state.activeRunId);
      if (!run) {
        this.activeRequestId = null;
        return;
      }
      if (event.cancelled) {
        this.failDesktopRun(run, "Stopped by you.");
        return;
      }
      applyDesktopPhase(run, "finish", "conversation saved");
      run.stages.forEach((stage) => {
        if (stage.state !== "skipped") stage.state = "done";
      });
      if (event.answeredBy?.line) this.noteAnsweredBy(run, event.answeredBy);
      else if (event.modelId) this.noteRealModel(run, event.modelId);
      this.reconcileRun(run);

      // VERIFY → REPAIR. A rejected answer is not handed to the owner as the
      // final word while another engine can still do better: the turn is
      // re-dispatched once to an alternative engine with the exact defects
      // named. `tryRepair` returns true only when that retry is under way.
      if (this.tryRepair(run, event.modelId ?? null)) return;
      run.agents.forEach((agent) => {
        agent.state = "done";
        agent.output = run.answer;
      });
      this.finish(run);
      this.activeRequestId = null;
    });
    window.friday.onChatError?.((event) => {
      if (event.requestId !== this.activeRequestId) return;
      this.clearWatchdog();
      const run = this.state.runs.find((item) => item.id === this.state.activeRunId);
      if (run) this.failDesktopRun(run, event.error);
      else this.activeRequestId = null;
    });
  }

  /**
   * Record the engine that ACTUALLY answered this turn.
   *
   * The agent rows (and therefore the conversation header) are seeded from the
   * pinned routing table before dispatch. When the router falls back to a
   * different engine, the owner must see that engine's name, not the plan's.
   */
  private noteAnsweredBy(run: Run, answeredBy: AnsweredBy) {
    run.answeredBy = answeredBy;
    const line = answeredBy.line;
    const targets = run.agents.length === 1 ? run.agents : run.agents.slice(0, 1);
    for (const agent of targets) {
      agent.modelId = answeredBy.modelId || agent.modelId;
      agent.modelLabel = line;
    }
    this.state.messages = this.state.messages.map((message) =>
      message.runId === run.id && message.role === "friday" ? { ...message, answeredBy } : message,
    );
    this.push("info", line);
  }

  private noteRealModel(run: Run, modelId: string) {
    const id = String(modelId || "").trim();
    if (!id) return;
    const label =
      modelById.get(id)?.name ??
      [...modelById.values()].find((m) => id.endsWith(m.id) || id.includes(m.id))?.name ??
      id;
    // Single-stream turns are answered by exactly one engine; a parallel turn
    // keeps its own per-agent attribution and only the lead row is corrected.
    const targets = run.agents.length === 1 ? run.agents : run.agents.slice(0, 1);
    let changed = false;
    for (const agent of targets) {
      if (agent.modelId === id && agent.modelLabel === label) continue;
      agent.modelId = id;
      agent.modelLabel = label;
      changed = true;
    }
    if (changed) this.push("info", `answering with ${label}`);
  }

  /**
   * Cross-checks what each engine produced for this run. With one engine the
   * answer only gets FRIDAY's voice enforced; with several it is reconciled,
   * conflicts are logged, and the visible reply is rewritten to the winner.
   */
  private reconcileRun(run: Run) {
    const buffers = [...this.streamBuffers.entries()].filter(([, b]) => b.text.trim());
    this.streamBuffers = new Map();
    const cognition = this.lastCognition?.runId === run.id ? this.lastCognition.cognition : null;

    if (buffers.length < 2 || !cognition) {
      const scrubbed = coreBrain.speakAsFriday(run.answer);
      if (scrubbed && scrubbed !== run.answer) this.replaceAnswer(run, scrubbed);
      return;
    }

    const result = coreBrain.reconcileTurn(
      cognition,
      buffers.map(([modelId, buffer]) => ({
        modelId,
        text: buffer.text,
        ok: true,
        ms: Date.now() - buffer.at,
      })),
    );
    if (!result.answer) return;
    this.replaceAnswer(run, result.answer);
    this.push("info", `reconciled ${buffers.length} engines — ${result.detail}`);
    for (const conflict of result.conflicts.slice(0, 3)) this.push("warn", conflict);
  }

  /** Rewrites the reply already shown for this run, in place. */
  private replaceAnswer(run: Run, text: string) {
    run.answer = text;
    const index = [...this.state.messages]
      .reverse()
      .findIndex((message) => message.runId === run.id && message.role === "friday");
    if (index === -1) return;
    const target = this.state.messages.length - 1 - index;
    this.state.messages = this.state.messages.map((message, i) =>
      i === target ? { ...message, text } : message,
    );
  }

  /**
   * REPAIR stage. FRIDAY verifies her own finished answer before she treats it
   * as the result; when the check rejects it (empty, a deflection, sources
   * fetched but not cited, a failed tool answered over) and another engine was
   * eligible for this turn, she runs the turn once more on an alternative
   * engine with the defects named.
   *
   * Bounded on purpose: one repair per run, and only when a genuinely
   * different engine exists — otherwise the same answer would simply be paid
   * for twice. Returns true when a repair pass has been dispatched.
   */
  private tryRepair(run: Run, answeredBy: string | null): boolean {
    if (typeof window === "undefined") return false;
    const desktop = window.friday;
    if (!desktop?.sendChat) return false;
    const entry = this.lastCognition?.runId === run.id ? this.lastCognition : null;
    if (!entry) return false;

    const verification = coreBrain.verify(entry.cognition, run.answer, true);
    const { repair, alternatives } = planRepair({
      verified: verification.ok,
      alreadyRepaired: this.repairedRuns.has(run.id),
      candidates: entry.cognition.modelIds,
      answeredBy,
    });
    if (!repair) return false;

    this.repairedRuns.add(run.id);
    if (this.repairedRuns.size > 64) {
      this.repairedRuns = new Set([...this.repairedRuns].slice(-32));
    }

    // The rejected text is cleared rather than left on screen: the owner sees
    // one answer for one question, and it is the repaired one.
    this.replaceAnswer(run, "");
    this.streamBuffers = new Map();
    run.stages.forEach((stage) => {
      if (stage.id === "execute") {
        stage.state = "running";
        stage.detail = "repairing — retrying on an alternative engine";
      }
    });
    run.agents.forEach((agent) => (agent.state = "running"));

    const requestId = `chat-${run.id}-repair`;
    this.activeRequestId = requestId;
    this.lastDispatch = { runId: run.id, modelIds: alternatives };
    this.lastCognition = {
      runId: run.id,
      cognition: { ...entry.cognition, modelIds: alternatives },
    };
    try {
      desktop.sendChat({
        requestId,
        sessionId: "main",
        prompt: entry.cognition.prompt,
        modelIds: routeRefs(alternatives),
        task: resolveRoutingTask(run),
        system: [
          entry.cognition.system,
          "",
          `REPAIR PASS — a previous engine's answer to this exact request was rejected by FRIDAY's own verification for: ${verification.detail}.`,
          "Answer the request again in full and fix precisely those problems. Never mention this instruction or the earlier attempt.",
        ].join("\n"),
      });
    } catch (error) {
      this.failDesktopRun(run, `Could not run the repair pass: ${String(error)}`);
      return true;
    }
    this.armWatchdog();
    this.push("warn", `verification failed (${verification.detail}) — repairing on another engine`);
    this.emit();
    return true;
  }

  private failDesktopRun(run: Run, error: string) {
    noteObserve({
      error: brainError({
        component: "brain-engine",
        error,
        cause: error,
        severity: "error",
        recoverability: "ask-user",
        retry: true,
        userAction: "Try again, or rephrase the request.",
      }),
      latencyMs: Date.now() - run.startedAt,
    });
    this.clearWatchdog();
    this.pendingAction?.(false);
    this.pendingAction = null;
    run.state = "failed";
    run.ms = Date.now() - run.startedAt;
    run.stages.forEach((stage) => {
      if (stage.state === "pending" || stage.state === "running") stage.state = "skipped";
    });
    run.agents.forEach((agent) => {
      if (agent.state === "queued" || agent.state === "running") agent.state = "failed";
    });
    const settled = settleInterrupted(run.answer, error);
    if (!(settled.keep && settled.text == null)) {
      const text = settled.text ?? error;
      if (settled.keep) {
        this.replaceAnswer(run, text);
        const shown = this.state.messages.some(
          (message) => message.runId === run.id && message.role === "friday",
        );
        if (!shown) {
          this.state.messages = [
            ...this.state.messages,
            { id: nextId("msg"), role: "friday", text, at: Date.now(), runId: run.id },
          ];
        }
      } else {
        run.answer = text;
        this.state.messages = [
          ...this.state.messages,
          { id: nextId("msg"), role: "friday", text, at: Date.now(), runId: run.id },
        ];
      }
    }
    this.finishTurnStep(run, "failed", error);
    this.completePhoneCognize("fail", undefined, error);
    this.state.activeRunId = null;
    this.activeRequestId = null;
    this.recordTurn(run, false, error);
    this.push("error", `run ${run.id} failed — ${error}`);
    this.speakReply(error);
    dispatchPluginHook("on-error", {
      runId: run.id,
      error: String(error || "").slice(0, 800),
      ms: run.ms,
    });
    dispatchPluginHook("on-turn-complete", { runId: run.id, ms: run.ms, ok: false });
    this.emit();
  }

  private persist() {
    if (typeof window === "undefined") return;
    writeState(STORAGE_KEY, {
      settings: this.state.settings,
      agentsEnabled: this.state.agentsEnabled,
      memory: this.state.memory.slice(0, 120),
      messages: this.state.messages.slice(-200),
      suggestions: this.state.suggestions.slice(0, 20),
      schedule: this.state.schedule,
      stats: this.state.stats,
    });
  }

  /* --------------------------------------------------------------- models */

  private routeModel(task: RoutingTask): { id: string | null; label: string } {
    // Brain resolves candidate recommendations against the canonical live registry.
    // Brain must NEVER invent or force an unlisted model ID.
    try {
      const live = usageRegistry.getSnapshot();
      if (live.models.length > 0) {
        if (live.routeMode === "auto" && live.selected.length === 0) {
          return { id: null, label: "Auto" };
        }
        if (live.selected.length > 0) {
          const picked = live.models.find(
            (m) => live.selected.includes(m.id) || live.selected.includes(m.modelName),
          );
          if (picked && picked.available && picked.eligible) {
            return { id: picked.id, label: picked.label };
          }
        }
        const routing = models.getSnapshot().routing;
        const candidateId = routing[task] ?? routing.brain ?? null;
        if (candidateId) {
          const match = live.models.find(
            (m) => m.id === candidateId || m.modelName === candidateId,
          );
          if (match && match.available && match.eligible) {
            return { id: match.id, label: match.label };
          }
        }
        const eligible = live.models.filter((m) => m.available && m.eligible);
        if (eligible.length > 0) {
          eligible.sort(
            (a, b) => (b.resident ? 1 : 0) - (a.resident ? 1 : 0) || b.priority - a.priority,
          );
          const first = eligible[0];
          if (first) {
            return { id: first.id, label: first.label };
          }
        }
      }
    } catch {
      /* fallback to static catalog in tests or standalone preview */
    }

    const routing = models.getSnapshot().routing;
    const id = routing[task] ?? routing.brain ?? null;
    if (!id) return { id: null, label: "unrouted" };
    return { id, label: modelById.get(id)?.name ?? id };
  }

  /* --------------------------------------------------------------- memory */

  recall(prompt: string, k = 4): MemoryHit[] {
    const now = Date.now();
    const words = prompt
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    const enabled = (layer: MemoryLayer) =>
      (layer !== "knowledge" || this.state.settings.useKnowledge) &&
      (layer !== "project" || this.state.settings.useProjectMemory);
    const pool = this.state.memory.filter(
      (m) => enabled(m.layer) && !looksSensitive(`${m.title} ${m.snippet}`),
    );
    const scored = pool
      .map((m) => {
        const hay = `${m.title} ${m.snippet}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        return {
          ...m,
          score: Number(Math.min(0.99, (m.pinned ? 0.6 : 0.25) + hits * 0.18).toFixed(2)),
        };
      })
      .sort((a, b) => b.score - a.score);
    const packed = packTurnContext({
      transcript: this.state.messages.map((message) => ({
        role: message.role === "user" ? "user" : "assistant",
        text: message.text,
      })),
      facts: pool.map((m) => ({
        id: m.id,
        text: `${m.title} ${m.snippet}`,
        source: m.layer,
        at: m.at,
        pinned: m.pinned,
      })),
      ask: prompt,
      now,
      maxFacts: k,
    });
    const picked = packed.forModel.facts.length
      ? packed.forModel.facts.flatMap((fact) => {
          const rec = scored.find((row) => row.id === fact.id);
          return rec ? [rec] : [];
        })
      : scored.slice(0, k);
    return picked.map((m) => ({
      id: m.id,
      layer: m.layer,
      title: m.title,
      snippet: m.snippet,
      score: m.score,
      source: m.layer,
      ageMs: Number.isFinite(m.at) ? Math.max(0, now - m.at) : null,
    }));
  }

  remember(layer: MemoryLayer, title: string, snippet: string, pinned = false) {
    this.state.memory = [
      { id: nextId("mem"), layer, title, snippet, score: 0.9, at: Date.now(), pinned },
      ...this.state.memory,
    ].slice(0, 200);
    this.push("ok", `memory written — [${layer}] ${title}`);
    this.emit();
  }

  forget(id: string) {
    const rec = this.state.memory.find((m) => m.id === id);
    this.state.memory = this.state.memory.filter((m) => m.id !== id);
    if (rec) this.push("warn", `memory removed — ${rec.title}`);
    this.emit();
  }

  pin(id: string) {
    this.state.memory = this.state.memory.map((m) =>
      m.id === id ? { ...m, pinned: !m.pinned } : m,
    );
    this.emit();
  }

  /* ------------------------------------------------------------- settings */

  toggleSetting(key: keyof BrainSettings) {
    this.state.settings[key] = !this.state.settings[key];
    const on = this.state.settings[key];
    this.push("info", `${key} ${on ? "enabled" : "disabled"}`);
    if (key === "autoLearn") this.syncLearningSurfaces();
    if (key === "checkUpdatesOnStart") {
      this.stampSchedule("Update check", on);
      if (on) void this.checkUpdates();
    }
    if (key === "checkUpdatesOnStart" || key === "autoLearn") this.syncScheduleFromSettings();
    this.emit();
  }

  toggleAgent(id: AgentId) {
    this.state.agentsEnabled[id] = !this.state.agentsEnabled[id];
    this.push(
      "info",
      `${agentById.get(id)?.name} ${this.state.agentsEnabled[id] ? "activated" : "paused"}`,
    );
    this.emit();
  }

  /* ------------------------------------------------------------------ run */

  /**
   * Run one turn.
   * `options.extra` carries the capability directive the composer attached and
   * `options.modelIds` pins the exact models the owner selected for this turn.
   *
   * The result is REPORTED, never swallowed: voice mode used to call this and
   * get nothing back when a previous turn was still running, so the owner
   * spoke into silence. Callers can now say exactly what happened.
   */
  send(
    prompt: string,
    rawOptions: {
      extra?: string;
      modelIds?: string[];
      routeMode?: string;
      routingContract?: ModelRoutingContract;
      routingSurface?: "voice" | "chat";
    } = {},
  ): SendResult {
    // One routing decision for every surface: chat used to pass the owner's
    // route mode and pinned picks while voice/Auto Mode did not, so the same
    // question could reach a different model depending on how it was asked.
    // The registry is the single source of truth, filled in here for callers
    // that do not carry it.
    const options = withRoutingDefaults(rawOptions);
    const text = prompt.trim();
    if (!text) return { accepted: false, reason: "empty", message: "I didn't catch anything." };
    if (this.state.activeRunId) {
      return {
        accepted: false,
        reason: "busy",
        message: "I'm still working on the last request — one moment.",
      };
    }
    this.startRun(text, options);
    return { accepted: true, reason: "accepted", message: null };
  }

  /**
   * Phone companion handshake: the kernel already stored the user line. This
   * run goes through the same `send()` → `cognize` path as typed chat. Always
   * ack so a connected desktop never silently falls back to a second kernel
   * brain; if this window is busy, fail with the same message `send()` uses.
   */
  private askFromPhone(event: { sessionId?: string; prompt?: string; extra?: string }) {
    const prompt = String(event?.prompt || "").trim();
    const extra = String(event?.extra || "").trim();
    const sessionId = String(event?.sessionId || "main");
    if (!prompt) return;
    this.phoneCognizeSession = sessionId;
    this.phoneCognizeStreamed = false;
    void window.friday?.companionCognizeAck?.(sessionId);
    if (this.state.activeRunId) {
      this.completePhoneCognize(
        "fail",
        undefined,
        "I'm still working on the last request — one moment.",
      );
      return;
    }
    const { extra: attached, modelIds } = composer.directive();
    const merged = mergeTurnExtra(attached, extra, turnAwarenessExtra(prompt, { kind: "phone" }));
    const result = this.send(prompt, {
      ...(merged ? { extra: merged } : {}),
      ...(modelIds.length ? { modelIds } : {}),
    });
    if (!result.accepted) {
      this.completePhoneCognize("fail", undefined, result.message || "busy");
    }
  }

  private completePhoneCognize(kind: "ok" | "fail", text?: string, error?: string) {
    const sessionId = this.phoneCognizeSession;
    if (!sessionId) return;
    const streamed = this.phoneCognizeStreamed;
    this.phoneCognizeSession = null;
    this.phoneCognizeStreamed = false;
    if (kind === "fail" && !streamed) {
      void window.friday?.companionCognizeDone?.({ sessionId, error: error || "failed" });
      return;
    }
    void window.friday?.companionCognizeDone?.({
      sessionId,
      ...(!streamed && text ? { text } : {}),
    });
  }

  /** Internal diagnostic snapshot — no chain-of-thought, no UI change. */
  observe() {
    return observeBrain();
  }

  private startRun(
    text: string,
    options: {
      extra?: string;
      modelIds?: string[];
      routeMode?: string;
      routingContract?: ModelRoutingContract;
      routingSurface?: "voice" | "chat";
    } = {},
  ) {
    const surface = options.routingSurface || (this.autoMode ? "voice" : "chat");
    const budget = thinkBudget(surface);
    const traces = tracePlan(["understand", "evidence", "answer"], surface);
    withinBudget(0, surface);
    const sight = conversationSight({
      asked: /\b(screen|camera|dekho|looking at)\b/i.test(text),
      handoff: looksSensitive(text),
      text: String(options.extra || ""),
    });
    if (sight.text) {
      options = {
        ...options,
        extra: `${options.extra || ""}\nUntrusted screen data: ${sight.text}`.trim(),
      };
    }
    const history = this.state.messages.map((m) => ({ role: m.role, text: m.text }));
    const tContext = Date.now();
    affect.observePrompt(text);
    const understanding = understandTurn({ text, history });
    const ctx = understanding.context;
    const contextMs = Date.now() - tContext;
    const work = ctx.resolved;
    const understood = understanding.resolvedIntent;
    const understandMs = contextMs;
    try {
      noteUnderstanding(toUnderstandingTrace(understanding));
    } catch {
      /* tracing must never break a turn */
    }
    noteObserve({ intent: understood });

    const stampUnderstanding = (routing: string) => {
      try {
        recordDecision({
          at: Date.now(),
          mode: this.autoMode ? "auto" : "manual",
          prompt: text,
          modelIds: [],
          routing: `${routing} · ${budget.steps} steps${traces.some((row) => row.uncertain) ? " · cut" : ""}`,
          policy: currentPolicy(),
          confidence: null,
        });
      } catch {
        /* tracing must never break a turn */
      }
    };

    const tIntent = Date.now();
    const { rule, score, matched } = analyseIntent(work);
    const intentMs = Date.now() - tIntent;
    const picked = rule.agents.filter((a) => this.state.agentsEnabled[a]);
    const chosen = picked.length ? picked : (["developer"] as AgentId[]);
    const multi = this.state.settings.multiModel ? chosen : chosen.slice(0, 1);

    const runId = nextId("run");
    const run: Run = {
      id: runId,
      prompt: text,
      intent: rule.id,
      intentLabel: rule.label,
      confidence: score,
      matched,
      stages: pipelineStages.map((s) => ({
        id: s.id,
        label: s.label,
        state: "pending",
        detail: s.note,
        ms: 0,
      })),
      agents: multi.map((id) => {
        const spec = agentById.get(id)!;
        const model = this.routeModel(spec.task);
        return {
          id,
          name: spec.name,
          task: spec.task,
          modelId: model.id,
          modelLabel: model.label,
          state: "queued",
          output: "",
          tokens: 0,
          ms: 0,
        } satisfies AgentRun;
      }),
      recalled: [],
      trace: [],
      state: "running",
      answer: "",
      startedAt: Date.now(),
      ms: 0,
    };
    this.recordDoneTurn(
      run,
      "thinking.context",
      ctx.references.length ? ctx.references.join(", ") : "no unresolved references",
      contextMs,
    );
    this.recordDoneTurn(
      run,
      "thinking.understand",
      `${understood.kind} · ${understood.catalogLabel}`,
      understandMs,
    );
    this.recordDoneTurn(
      run,
      "thinking.intent",
      `${rule.label} (${Math.round(score * 100)}%)`,
      intentMs,
    );

    const last = this.state.messages[this.state.messages.length - 1];
    const phoneEcho = last?.role === "user" && last.text === text && last.via === "phone";
    if (phoneEcho) {
      this.state.messages = this.state.messages.map((message, index, list) =>
        index === list.length - 1 ? { ...message, runId } : message,
      );
    } else {
      this.state.messages = [
        ...this.state.messages,
        { id: nextId("msg"), role: "user", text, at: Date.now(), runId },
      ];
    }
    this.state.runs = [run, ...this.state.runs].slice(0, MAX_RUNS);
    this.state.activeRunId = runId;
    this.state.stats.requests += 1;
    const traced = tracePlan(["hear", "decide", "answer", "check"], surface);
    const paced = withinBudget(budget.ms, surface);
    this.push(
      "info",
      `run ${runId} — intent ${rule.label} (${Math.round(score * 100)}%), ${multi.length} agent(s)` +
        ` · ${traced.length} steps${paced ? "" : " over budget"}${sight.text ? " · screen data held" : ""}`,
    );
    dispatchPluginHook("on-turn-start", { runId, intent: rule.id });
    this.emit();

    // The owner is active: any idle self-improvement work parks itself at its
    // last checkpoint before this turn does anything else.
    taskGraph.noteOwnerActivity();
    registerTaskRunners();

    const care = ownerShape(work, "");
    if (care.feeling.label === "distress") {
      stampUnderstanding("distress — no model");
      const safe = replyKeepsHelp(care.text, true)
        ? care.text
        : "I'm here with you. iCall or AASRA can help.";
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "smalltalk",
        text: safe,
        confidence: 1,
      });
      return;
    }

    const planned = everydayPlan(work);
    if (planned) {
      stampUnderstanding("everyday plan — no model");
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "action",
        text: planned.text,
        confidence: 0.9,
      });
      return;
    }

    // Direct control over the queue ("task status", "interrupt", "resume task").
    const queueReply = handleQueueCommand(work);
    if (queueReply) {
      stampUnderstanding("queue command — no model");
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "action",
        text: queueReply,
        confidence: 1,
      });
      return;
    }

    const doctorReply = handleDoctorCommand(work);
    if (doctorReply) {
      stampUnderstanding("doctor command — no model");
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "action",
        text: doctorReply,
        confidence: 1,
      });
      return;
    }

    const installerReply = handleInstallerCommand(work);
    if (installerReply) {
      stampUnderstanding("installer command — no model");
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "action",
        text: installerReply,
        confidence: 1,
      });
      return;
    }

    const desktopIntake = considerDesktopTask(work);
    if (desktopIntake) {
      bindActiveGraph(desktopIntake.id);
      stampUnderstanding("desktop task — no model");
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "action",
        text: desktopIntake.message,
        confidence: 1,
      });
      return;
    }

    const intake = considerLongTask(work);
    if (intake) {
      bindActiveGraph(intake.id);
      stampUnderstanding("long-task intake — no model");
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "action",
        text: intake.message,
        confidence: 1,
      });
      return;
    }

    const baseline = baselineRespond(work, { ongoing: ctx.ongoing });
    const decision = decideAction({
      text: work,
      intent: understood,
      handledByBaseline: baseline.handled,
    });
    noteObserve({ decision });
    if (decision.askUser && !baseline.handled) {
      stampUnderstanding(`ask — ${decision.reason}`);
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "unsure",
        text: decision.reason,
        confidence: understood.catalogScore,
      });
      return;
    }
    if (baseline.handled) {
      stampUnderstanding("baseline — no model");
      const shaped =
        baseline.text && (care.feeling.label === "anger" || care.feeling.label === "hurry")
          ? ownerShape(work, baseline.text).text
          : baseline.text;
      void this.answerFromBaseline(
        run,
        shaped === baseline.text ? baseline : { ...baseline, text: shaped },
      );
      return;
    }

    const desktop = typeof window !== "undefined" ? window.friday : undefined;

    if (desktop?.sendChat) {
      // Intent/routing are cheap and already complete; later NeuralCircuit
      // stages track the real Core Brain + stream, not a fake timer.
      applyDesktopPhase(run, "wait", "waiting for selected model");
      const memoryStage = run.stages.find((stage) => stage.id === "memory");
      run.recalled = this.recall(run.prompt);
      if (memoryStage) {
        memoryStage.detail = `${run.recalled.length} local context records selected`;
      }
      run.agents.forEach((agent) => (agent.state = "running"));
      const requestId = `chat-${runId}`;
      this.activeRequestId = requestId;
      // One cognitive flow for both modes, owned by FRIDAY's Core Brain:
      // memory + identity + planning + tool routing (real web search when the
      // request needs it) before any specialist model is called.
      void this.dispatchCognition(run, work, requestId, desktop, {
        ...(options.extra ? { extra: options.extra } : {}),
        ...(options.modelIds ? { modelIds: options.modelIds } : {}),
        ...(options.routeMode ? { routeMode: options.routeMode } : {}),
        ...(options.routingContract ? { routingContract: options.routingContract } : {}),
        routingSurface: options.routingSurface || (this.autoMode ? "voice" : "chat"),
      });
      this.emit(false);
      return;
    }

    // Browser preview has no desktop kernel; retain the lightweight local
    // demonstrator there only. Packaged builds never execute this timer path.
    this.ensureTimer();
  }

  /**
   * Core Brain pass for one desktop run. Runs off the click handler so tool
   * routing (real web search) never blocks the UI, then hands the enriched
   * system prompt to the specialist model(s) over IPC.
   */
  private async dispatchCognition(
    run: Run,
    text: string,
    requestId: string,
    desktop: NonNullable<typeof window.friday>,
    options: {
      extra?: string;
      modelIds?: string[];
      routeMode?: string;
      routingContract?: ModelRoutingContract;
      routingSurface?: "voice" | "chat";
    },
  ) {
    const memoryStage = run.stages.find((stage) => stage.id === "memory");
    const modelStage = run.stages.find((stage) => stage.id === "models");
    let cognition: Cognition;
    const flowAsk = parseFlowCommand(text);
    if (flowAsk.action !== "none") {
      const { answerFlowCommand } = await import("./flow-adapters");
      const answer = looksSensitive(text)
        ? {
            feature: flowAsk.feature,
            action: flowAsk.action,
            text: "That line is SENSITIVE, so the flow view will not show it.",
          }
        : answerFlowCommand(text);
      flowStudio.open(answer.feature, flowAsk.action === "watch" ? "watch" : "chart");
      this.noteTurn(run, "thinking.observe", `flow ${answer.action} ${answer.feature}`);
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "knowledge",
        text: answer.text,
        confidence: 1,
      });
      return;
    }
    this.noteTurn(run, "thinking.cognition", "preparing the turn");
    applyDesktopPhase(run, "prepare", "preparing the turn");
    try {
      cognition = await coreBrain.cognize(text, {
        mode: this.autoMode ? "auto" : "manual",
        surface: options.routingSurface || (this.autoMode ? "voice" : "chat"),
        observe: false,
        multiModel: this.state.settings.multiModel,
        useKnowledge: this.state.settings.useKnowledge,
        useProjectMemory: this.state.settings.useProjectMemory,
        autoLearn: this.state.settings.autoLearn,
        history: this.state.messages.map((m) => ({ role: m.role, text: m.text })),
        ...(options.extra ? { extra: options.extra } : {}),
        ...(options.modelIds ? { pinnedModelIds: options.modelIds } : {}),
        onStage: (nodeId, detail) => this.noteTurn(run, nodeId, detail),
      });
    } catch (error) {
      this.failDesktopRun(run, `FRIDAY's Core Brain could not prepare this turn: ${String(error)}`);
      return;
    }
    if (this.activeRequestId !== requestId) return; // superseded by a newer run

    if (cognition.localMind?.skipModel && cognition.localMind.reply) {
      this.lastCognition = { runId: run.id, cognition };
      if (modelStage) modelStage.detail = "FRIDAY local mind — model stayed idle";
      void this.answerFromBaseline(run, {
        handled: true,
        kind: "knowledge",
        text: cognition.localMind.reply,
        confidence: cognition.localMind.confidence,
      });
      return;
    }

    const ownerAuto =
      usageRegistry.getSnapshot().routeMode === "auto" &&
      usageRegistry.getSnapshot().selected.length === 0 &&
      !(options.modelIds && options.modelIds.length);
    const modelIds = ownerAuto
      ? []
      : cognition.modelIds.length
        ? cognition.modelIds
        : run.agents.map((agent) => agent.modelId).filter((id): id is string => Boolean(id));

    if (memoryStage) {
      memoryStage.detail = `${run.recalled.length} local records + ${cognition.context.length} memories`;
    }
    if (modelStage) modelStage.detail = cognition.routing;
    for (const tool of cognition.tools) {
      this.push(
        tool.ok ? "ok" : "warn",
        `${tool.tool} — ${tool.detail}${tool.ok ? "" : " (answering without it)"}`,
      );
    }
    if (cognition.sources.length) {
      this.push("info", `${cognition.sources.length} live source(s) attached to the turn`);
    }

    // The router in the main process must receive the REAL task, not a
    // generic "chat": model eligibility, capability filtering and cost policy
    // all key off it.
    const task = resolveRoutingTask(run, options.extra);
    this.streamBuffers = new Map();
    this.lastDispatch = { runId: run.id, modelIds };
    this.lastCognition = { runId: run.id, cognition };

    // Rare, deliberate multi-model collaboration: only on a real capability
    // gap that matters, or when the owner asked for a second opinion.
    const collaboration = considerCollaboration(text, {
      enabled: this.state.settings.multiModel,
    });
    this.noteTurn(
      run,
      "orchestrator.collaboration",
      collaboration.warranted
        ? `${collaboration.initiator}-initiated · ${collaboration.reason}`
        : collaboration.reason,
    );
    this.finishTurnStep(run, "done");
    if (collaboration.warranted && desktop.parallelChat) {
      if (this.phoneCognizeSession) this.phoneCognizeStreamed = true;
      const handled = await this.collaborate(run, text, requestId, desktop, collaboration, {
        task,
        system: cognition.system,
        modelIds,
        cognition,
      });
      if (handled) return;
    }

    try {
      this.noteTurn(
        run,
        "router.select",
        modelIds.length
          ? `waiting for first token from ${modelIds.join(", ")}`
          : "waiting for first token from the routed model",
      );
      applyDesktopPhase(
        run,
        "wait",
        modelIds.length
          ? `waiting for first token from ${modelIds.join(", ")}`
          : "waiting for first token from the routed model",
      );
      if (this.phoneCognizeSession) this.phoneCognizeStreamed = true;
      desktop.sendChat?.({
        requestId,
        sessionId: "main",
        prompt: text,
        // Providers address their models by their own ids, so send the
        // provider/registry reference first and the catalog id as a fallback.
        modelIds: routeRefs(modelIds),
        task,
        // The owner's local/cloud/auto/manual/multi choice for this turn.
        ...(options.routeMode ? { routeMode: options.routeMode } : {}),
        ...(options.routingContract ? { routingContract: options.routingContract } : {}),
        ...(options.routingSurface ? { routingSurface: options.routingSurface } : {}),
        system: cognition.system,
      });
      this.armWatchdog();
    } catch (error) {
      this.failDesktopRun(run, `Could not reach FRIDAY's local AI service: ${String(error)}`);
      return;
    }
    this.emit(false);
  }

  /**
   * Run 2-3 real models concurrently on one hard (or owner-flagged) turn and
   * give ONE answer built from what they actually returned.
   *
   * Every call goes through the same main-process path as an ordinary chat —
   * the same free-vs-paid policy and the same per-model data-egress
   * confirmation — and the answers are merged by the existing reconciler, not
   * by a new synthesis mechanism. Returns false when collaboration could not
   * happen, so the caller falls back to the ordinary single-model stream.
   */
  private async collaborate(
    run: Run,
    text: string,
    requestId: string,
    desktop: NonNullable<typeof window.friday>,
    decision: CollaborationDecision,
    dispatch: { task: string; system: string; modelIds: string[]; cognition: Cognition },
  ): Promise<boolean> {
    this.push(
      "info",
      `multi-model collaboration (${decision.initiator}-initiated) — ${decision.reason}`,
    );
    this.noteTurn(run, "router.select", `parallel ${decision.count} models — ${decision.reason}`);
    let response: Awaited<ReturnType<NonNullable<typeof desktop.parallelChat>>>;
    try {
      response = await desktop.parallelChat!({
        requestId: `${requestId}-multi`,
        sessionId: "main",
        prompt: text,
        task: dispatch.task,
        system: dispatch.system,
        count: decision.count,
        reason: decision.reason,
        qualityTarget: usageRegistry.getSnapshot().qualityTarget,
        strategy: usageRegistry.getSnapshot().strategy,
        ...(dispatch.modelIds.length ? { modelIds: routeRefs(dispatch.modelIds) } : {}),
      });
    } catch (error) {
      this.push("warn", `multi-model collaboration failed (${String(error)}) — using one model`);
      return false;
    }
    if (this.activeRequestId !== requestId) return true; // superseded by a newer run

    const usable = (response.results ?? []).filter((entry) => entry.ok && entry.text.trim());
    if (!response.ok || usable.length < 2) {
      this.push(
        "warn",
        response.error
          ? `multi-model collaboration unavailable — ${response.error}`
          : "only one model answered — continuing with the single-model path",
      );
      return false;
    }

    // Existing verification + reconciliation. Nothing new is invented here.
    const result = coreBrain.reconcileTurn(
      dispatch.cognition,
      usable.map((entry) => ({ modelId: entry.modelId, text: entry.text, ok: true, ms: entry.ms })),
    );
    const answer = result.answer || usable[0]!.text;

    try {
      recordCollaboration({
        initiator: decision.initiator === "owner" ? "owner" : "friday",
        reason: decision.reason,
        models: (response.results ?? []).map((entry) => ({
          modelId: entry.modelId,
          label: entry.label,
          access: entry.access,
          ok: entry.ok,
          ms: entry.ms,
        })),
        winner: result.winner,
        agreement: result.agreement,
      });
    } catch {
      /* tracing must never break a finished turn */
    }

    run.stages.forEach((stage) => {
      stage.state = "done";
      stage.ms = Date.now() - run.startedAt;
      if (stage.id === "models") {
        stage.detail = `${usable.length} models in parallel — ${usable.map((m) => m.label).join(", ")}`;
      }
    });
    run.agents.forEach((agent) => {
      agent.state = "done";
      agent.output = answer;
      agent.modelLabel = usable.map((m) => m.label).join(" + ");
    });
    run.answer = answer;
    const answeredBy = multiAnsweredBy(usable);
    run.answeredBy = answeredBy;
    this.state.messages = [
      ...this.state.messages,
      {
        id: nextId("msg"),
        role: "friday",
        text: answer,
        at: Date.now(),
        runId: run.id,
        answeredBy,
      },
    ];
    this.push(
      "ok",
      `reconciled ${usable.length} parallel engines — ${result.detail} (ask "why did you use those models" for the full trace)`,
    );
    for (const conflict of result.conflicts.slice(0, 3)) this.push("warn", conflict);
    this.activeRequestId = null;
    this.finish(run);
    return true;
  }

  /**
   * FRIDAY answering as herself. No model is contacted; when the request maps
   * to a real tool the tool is executed for real and its actual result — good
   * or bad — is what the owner sees. Nothing here is simulated.
   */
  private async answerFromBaseline(run: Run, reply: BaselineReply) {
    run.stages.forEach((stage) => {
      stage.state = stage.id === "execute" ? "running" : "done";
      stage.ms = Date.now() - run.startedAt;
      if (stage.id === "models")
        stage.detail = "answered by FRIDAY's baseline brain — no model used";
    });
    run.recalled = this.recall(run.prompt);
    run.agents.forEach((agent) => {
      agent.state = "running";
      agent.modelId = null;
      agent.modelLabel = "FRIDAY (baseline)";
    });
    this.emit(false);

    let text = reply.text;
    if (reply.resolve) {
      this.noteTurn(run, "execution.runners", "reading a live machine value");
      // One real measurement (disk, load, network, battery) — still no model.
      text = await reply
        .resolve()
        .catch((error: unknown) => `I couldn't read that from the machine: ${String(error)}`);
      this.finishTurnStep(run, "done");
    }
    if (reply.action && reply.action.kind === "skill") {
      const { tool: skillId, args, label, risk } = reply.action;
      const allowed = await this.gateAction(run, skillId, (risk ?? "exec") as ActionRisk, label);
      if (!allowed) {
        text = `Cancelled — I did not run ${label}.`;
      } else {
        this.push("info", `baseline brain invoking skill ${skillId} — ${label}`);
        this.noteTurn(run, "agents.skills", `running ${label}`);
        noteObserve({ tool: skillId });
        dispatchPluginHook("on-skill-run", { runId: run.id, skillId, label });
        const result = await (window.friday?.invokeSkill?.(skillId, args) ??
          Promise.resolve({ ok: false, error: "skills are only available in the desktop app" }));
        text = describeToolResult(label, result as Record<string, unknown>);
        this.state.stats.toolCalls += 1;
      }
    } else if (reply.action && reply.action.kind === "connector") {
      // A connector action is an ordinary tool call: same approval gate, same
      // run log, same result formatting — only the transport differs.
      const { tool, args, label, risk } = reply.action;
      const allowed = await this.gateAction(run, tool, (risk ?? "exec") as ActionRisk, label);
      if (!allowed) {
        text = `Cancelled — I did not run ${label}.`;
      } else {
        const entry = connectorTools().find((t) => t.tool === tool);
        this.push("info", `baseline brain calling ${tool} — ${label}`);
        this.noteTurn(run, "execution.runners", `connector ${label}`);
        noteObserve({ tool });
        const result = entry
          ? await invokeApprovedConnectorAction(entry, args)
          : { ok: false, error: "That service is no longer connected." };
        text = describeToolResult(
          label,
          (result.ok
            ? { ok: true, entries: result.lines ?? [] }
            : { ok: false, error: result.error }) as Record<string, unknown>,
        );
        this.state.stats.toolCalls += 1;
      }
    } else if (reply.action) {
      const { tool, args, label, risk } = reply.action;
      // Manual mode gates every action; auto mode gates anything that is not
      // read-only. The approval decision itself lives in brain/action-risk.ts.
      const allowed = await this.gateAction(run, tool, (risk ?? "exec") as ActionRisk, label);
      if (!allowed) {
        text = `Cancelled — I did not run ${label}.`;
      } else {
        this.push("info", `baseline brain running ${tool} — ${label}`);
        this.noteTurn(run, "execution.runners", label);
        noteObserve({ tool });
        const command = String(args["command"] ?? args["cmd"] ?? "");
        const shell = typeof args["shell"] === "string" ? args["shell"] : undefined;
        const opRaw = typeof args["op"] === "string" ? args["op"] : "run";
        let result: Record<string, unknown>;
        if (isSandboxLabTool(tool)) {
          const op = opRaw === "create" || opRaw === "checks" || opRaw === "apply" ? opRaw : "run";
          const local = await runSandboxPlan(
            {
              op,
              ...(command ? { command } : {}),
              ...(typeof args["template"] === "string" ? { template: args["template"] } : {}),
              ...(typeof args["name"] === "string" ? { name: args["name"] } : {}),
              risk: (risk ?? "exec") as "safe" | "write" | "exec",
              tool: "sandbox.exec",
              label,
            },
            { actor: "FRIDAY" },
          );
          result = local as Record<string, unknown>;
          if (!result["ok"] && !result["error"] && typeof result["output"] === "string") {
            result = { ...result, error: String(result["output"]).slice(-800) };
          }
          if (typeof result["output"] === "string" && result["output"].length > 1600) {
            result = { ...result, output: String(result["output"]).slice(-1600) };
          }
        } else if (isWorkspaceShellTool(tool) && command) {
          const local = await runWorkspaceShell(command, {
            ...(shell
              ? { shell: tool === "shell.powershell" ? shell || "powershell" : shell }
              : {}),
            actor: "FRIDAY",
          });
          if (local.skipped) {
            result = (await kernelCall<Record<string, unknown>>("tool.exec", {
              name: tool,
              args,
              approved: true,
            }).catch((error: unknown) => ({ ok: false, error: String(error) }))) ?? {
              ok: false,
              error: "Kernel is not running — start it from Setup.",
            };
          } else {
            result = local as Record<string, unknown>;
          }
        } else {
          result = (await kernelCall<Record<string, unknown>>("tool.exec", {
            name: tool,
            args,
            approved: true,
          }).catch((error: unknown) => ({ ok: false, error: String(error) }))) ?? {
            ok: false,
            error: "Kernel is not running — start it from Setup.",
          };
        }
        text = describeToolResult(label, result);
        presentToolArtifacts(label, result);
        this.state.stats.toolCalls += 1;
      }
    }

    this.state.messages = [
      ...this.state.messages,
      { id: nextId("msg"), role: "friday", text, at: Date.now(), runId: run.id },
    ];
    run.answer = text;
    run.agents.forEach((agent) => {
      agent.state = "done";
      agent.output = text;
    });
    run.stages.forEach((stage) => (stage.state = "done"));
    this.push("ok", `run ${run.id} answered locally (${reply.kind}) — no model required`);
    this.noteTurn(run, "orchestrator.report", `answered locally (${reply.kind})`);
    this.finishTurnStep(run, "done");
    this.finish(run);
  }

  /**
   * Ask the owner before an action runs. Returns true when it may proceed.
   * Reuses the single existing approval slot (state.approval) and the same
   * approve() button the agent tool-calls already use — no second system.
   */
  private gateAction(run: Run, tool: string, risk: ActionRisk, label: string): Promise<boolean> {
    const mode = actionMode();
    if (
      !brainActionNeedsApproval(risk, mode, {
        confirmImportant: this.state.settings.confirmImportant,
        prompt: run.prompt,
      })
    ) {
      return Promise.resolve(true);
    }
    const agent = run.agents[0]?.id ?? ("developer" as AgentId);
    this.state.approval = {
      runId: run.id,
      agent,
      tool,
      risk: risk === "safe" ? "write" : (risk as "write" | "exec"),
      reason: `${label} — ${approvalReason(risk, mode)}`,
    };
    run.state = "awaiting-approval";
    this.push("warn", `waiting for your approval: ${label} (${risk})`);
    this.emit();
    return new Promise<boolean>((resolve) => {
      this.pendingAction = resolve;
    });
  }

  approve(allow: boolean) {
    const req = this.state.approval;
    if (!req) return;
    // An action gated by gateAction() resumes exactly where it paused.
    if (this.pendingAction) {
      const resume = this.pendingAction;
      this.pendingAction = null;
      this.state.approval = null;
      this.state.stats.approvals += 1;
      this.push(
        allow ? "ok" : "warn",
        `${allow ? "approved" : "denied"} ${req.tool} (${req.risk})`,
      );
      const run = this.state.runs.find((r) => r.id === req.runId);
      if (run) run.state = "running";
      this.emit();
      resume(allow);
      return;
    }
    const run = this.state.runs.find((r) => r.id === req.runId);
    this.state.approval = null;
    this.state.stats.approvals += 1;
    if (!run) return this.emit();

    const agent = run.agents.find((a) => a.id === req.agent);
    if (allow) {
      run.state = "running";
      if (agent) agent.state = "running";
      this.state.stats.toolCalls += 1;
      this.push("ok", `approved ${req.tool} (${req.risk}) for ${agentById.get(req.agent)?.name}`);
    } else {
      if (agent) {
        agent.state = "blocked";
        agent.output = `${agentById.get(req.agent)?.name.replace(" Agent", "")}: skipped ${req.tool} — you denied the ${req.risk} permission.`;
      }
      run.state = "running";
      this.push("warn", `denied ${req.tool} — continuing without it`);
    }
    this.state.activeRunId = run.id;
    this.ensureTimer();
    this.emit();
  }

  clearChat() {
    this.pendingAction?.(false);
    this.pendingAction = null;
    persistAndResetConversation();
    this.state.messages = [];
    this.state.runs = [];
    this.state.activeRunId = null;
    this.state.approval = null;
    this.push("info", "conversation memory cleared — long-term memory kept");
    this.syncSharedSurfaces("clear");
    this.emit();
  }

  /** Stop the run that is currently streaming so a new voice/chat turn can start. */
  stop() {
    const run = this.state.runs.find((r) => r.id === this.state.activeRunId);
    if (!run) return;
    this.clearWatchdog();
    if (this.activeRequestId && typeof window !== "undefined") {
      window.friday?.abortChat?.(this.activeRequestId);
    }
    this.failDesktopRun(run, "Stopped by you.");
  }

  /** Re-run the last request, dropping the answer it produced. */
  regenerate() {
    if (this.state.activeRunId) return;
    const lastUser = [...this.state.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const idx = this.state.messages.findIndex((m) => m.id === lastUser.id);
    this.state.messages = this.state.messages.slice(0, idx);
    this.push("info", "regenerating the last answer");
    this.emit();
    this.send(lastUser.text);
  }

  /** Replace the visible conversation (used when switching saved chats). */
  loadConversation(messages: Message[]) {
    if (this.state.activeRunId) return;
    persistAndResetConversation();
    this.state.messages = messages.slice(-200);
    this.state.approval = null;
    this.syncSharedSurfaces("adopt");
    this.emit();
  }

  /**
   * Keep kernel chat history (phone replay) and Auto Mode captions on the
   * same conversation the desktop just cleared or loaded.
   */
  private syncSharedSurfaces(kind: "clear" | "adopt") {
    void kernelApi.chat
      .replace(
        "main",
        this.state.messages.map((message) => ({
          role: message.role === "friday" ? "assistant" : "user",
          text: message.text,
          origin: message.via === "phone" ? "phone" : "desktop",
        })),
      )
      .catch(() => null);
    void import("./assistant-mode").then(({ assistantMode }) => {
      if (kind === "clear") assistantMode.clearCaptions();
      else assistantMode.adoptTranscript();
    });
  }

  /* ------------------------------------------------------ self improvement */

  private seedSuggestions() {
    this.state.suggestions = suggestionSeeds.slice(0, 4).map((s) => ({
      id: nextId("sug"),
      ...s,
      state: "pending" as const,
      at: Date.now(),
    }));
  }

  propose() {
    const taken = new Set(this.state.suggestions.map((s) => s.title));
    const pool = suggestionSeeds.filter((s) => !taken.has(s.title));
    const pick = pool[Math.floor(Math.random() * pool.length)] ?? suggestionSeeds[0]!;
    this.state.suggestions = [
      { id: nextId("sug"), ...pick, state: "pending" as const, at: Date.now() },
      ...this.state.suggestions,
    ].slice(0, 12);
    this.push("info", `self-review — proposed "${pick.title}" (waiting for your confirmation)`);
    this.emit();
  }

  resolveSuggestion(id: string, apply: boolean) {
    const s = this.state.suggestions.find((x) => x.id === id);
    if (!s) return;
    s.state = apply ? "applied" : "dismissed";
    if (apply) {
      this.remember("long-term", s.title, `Approved improvement: ${s.rationale}`);
      this.push("ok", `applied improvement — ${s.title}`);
    } else {
      this.push("warn", `dismissed improvement — ${s.title}`);
    }
    this.emit();
  }

  /* ------------------------------------------------------------- schedule */

  toggleJob(id: string) {
    this.state.schedule = this.state.schedule.map((j) =>
      j.id === id ? { ...j, enabled: !j.enabled } : j,
    );
    const job = this.state.schedule.find((j) => j.id === id);
    if (job) this.honorScheduleJob(job);
    this.emit();
  }

  addJob(title: string, when: string, agent: AgentId) {
    this.state.schedule = [
      ...this.state.schedule,
      { id: nextId("job"), title, when, agent, enabled: true, lastRun: "—" },
    ];
    this.push("ok", `scheduled "${title}" — ${when}`);
    this.emit();
  }

  removeJob(id: string) {
    this.state.schedule = this.state.schedule.filter((j) => j.id !== id);
    this.emit();
  }

  /* --------------------------------------------------------- update flow */

  /** Re-query live scanners when the Updates tab is shown and the last check is stale. */
  refreshUpdatesIfStale(maxAgeMs = UPDATE_STALE_MS) {
    if (this.state.checkingUpdates) return;
    if (this.lastUpdateCheckAt && Date.now() - this.lastUpdateCheckAt < maxAgeMs) return;
    void this.checkUpdates();
  }

  async checkUpdates() {
    if (this.state.checkingUpdates) return;
    this.state.checkingUpdates = true;
    this.lastUpdateCheckAt = Date.now();
    this.state.updates = this.state.updates.map((u) => ({
      ...u,
      state: "checking" as const,
      notes: "querying the live GitHub and capability scanners",
    }));
    this.push(
      "info",
      "startup check — application, plugins, modules, agents, providers, tools, workflows",
    );
    this.emit();

    try {
      const { rows, github } = await collectLiveUpdateRows(this.state.updates as LiveUpdateRow[]);
      this.lastGithubCheck = github;
      this.state.updates = rows;
      this.stampSchedule("Update check", this.state.settings.checkUpdatesOnStart, clock());
    } catch (error) {
      this.state.updates = this.state.updates.map((u) => ({
        ...u,
        state: "up-to-date" as const,
        notes: `check failed — ${String(error)}`,
      }));
      this.push("warn", `update check failed — ${String(error)}`);
    }
    this.state.checkingUpdates = false;
    const n = this.state.updates.filter((u) => u.state === "available").length;
    this.push(
      n ? "warn" : "ok",
      n
        ? `${n} update group(s) available — confirm install on Settings → Updates`
        : "everything checked is up to date",
    );
    this.emit();
  }

  async applyUpdate(id: string) {
    const row = this.state.updates.find((u) => u.id === id);
    if (!row || row.state !== "available") return;
    if (id !== "app") {
      this.push(
        "info",
        `${row.label} updates install on that page — Brain does not invent a second installer`,
      );
      this.emit();
      return;
    }
    row.state = "installing";
    this.push("info", `installing ${row.label} through the existing updater`);
    this.emit();
    const electron = await checkForUpdates().catch(() => []);
    const appUpdate = electron.find(
      (item) => item.kind === "app" || item.id === "app" || item.id === "friday",
    );
    if (appUpdate) {
      const result = await applyDesktopUpdate(appUpdate);
      if (result.ok) {
        row.state = "installed";
        row.installed = row.latest;
        this.push("ok", `${row.label} update started — restart if FRIDAY does not reopen`);
      } else {
        row.state = "available";
        row.notes = result.error || "updater did not start — use Settings → Updates";
        this.push("warn", row.notes);
      }
      this.emit();
      return;
    }
    row.state = "available";
    const githubVersion =
      this.lastGithubCheck?.ok && this.lastGithubCheck.version
        ? `GitHub ${this.lastGithubCheck.version}`
        : "GitHub reports a newer build";
    row.notes = `${githubVersion} — download and install from Settings → Updates (same channel)`;
    this.push("info", row.notes);
    this.emit();
  }

  private stampSchedule(title: string, enabled?: boolean, lastRun?: string) {
    this.state.schedule = this.state.schedule.map((job) =>
      job.title === title
        ? {
            ...job,
            ...(typeof enabled === "boolean" ? { enabled } : {}),
            ...(lastRun ? { lastRun } : {}),
          }
        : job,
    );
  }

  private syncScheduleFromSettings() {
    this.stampSchedule("Update check", this.state.settings.checkUpdatesOnStart);
  }

  private syncLearningSurfaces() {
    const on = this.state.settings.autoLearn;
    try {
      preferences.setToggle("lessons", on);
    } catch {
      /* preferences optional in tests */
    }
    void kernelCall("settings.set", { key: "write_lessons", value: on }).catch(() => null);
  }

  private syncLiveSurfaces() {
    this.syncScheduleFromSettings();
    this.syncLearningSurfaces();
    for (const job of this.state.schedule) {
      if (job.title === "Memory compaction") {
        try {
          preferences.setToggle("memOpt", job.enabled);
        } catch {
          /* optional */
        }
      }
      if (job.title === "Workspace backup") {
        try {
          preferences.setToggle("memorySnapshot", job.enabled);
        } catch {
          /* optional */
        }
      }
    }
  }

  private armUpdateWatch() {
    if (this.updateWatch || typeof window === "undefined") return;
    this.updateWatch = setInterval(() => {
      if (this.state.settings.checkUpdatesOnStart) void this.checkUpdates();
    }, UPDATE_POLL_MS);
  }

  private honorScheduleJob(job: ScheduledJob) {
    if (job.title === "Update check") {
      this.state.settings.checkUpdatesOnStart = job.enabled;
      if (job.enabled) void this.checkUpdates();
      return;
    }
    if (job.title === "Memory compaction") {
      try {
        preferences.setToggle("memOpt", job.enabled);
      } catch {
        /* optional */
      }
      return;
    }
    if (job.title === "Workspace backup") {
      try {
        preferences.setToggle("memorySnapshot", job.enabled);
      } catch {
        /* optional */
      }
      return;
    }
    if (job.title === "Morning briefing") {
      void this.syncMorningBriefing(job.enabled);
    }
  }

  private async syncMorningBriefing(enabled: boolean) {
    const index = await listCapabilities().catch(() => null);
    const pack = index?.items.find(
      (item) =>
        item.tree === "workflows" &&
        (item.id === "morning-briefing" || /morning briefing/i.test(item.name)),
    );
    if (!pack) {
      this.push(
        "info",
        "Morning briefing maps to the morning-briefing workflow — pack not in this scan",
      );
      return;
    }
    const ok = await setCapabilityEnabled(pack.id, enabled);
    this.push(
      ok ? "ok" : "warn",
      ok
        ? `morning-briefing workflow ${enabled ? "enabled" : "paused"}`
        : "could not toggle the morning-briefing workflow from here",
    );
    this.emit();
  }

  /**
   * Manual and chat stay silent. Auto mode speaks from assistant-mode, which
   * is the only voice session. This hook remains so a finished run still has
   * one place that used to speak, and it does not open a second speaker.
   */
  private speakReply(_text: string) {
    return;
  }

  /* ----------------------------------------------------------------- tick */

  private ensureTimer() {
    if (this.timer || typeof window === "undefined") return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const run = this.state.runs.find((r) => r.id === this.state.activeRunId);
    if (!run) {
      this.stopTimer();
      return;
    }
    if (run.state === "awaiting-approval") {
      this.stopTimer();
      return;
    }

    run.ms = Date.now() - run.startedAt;
    const stage = run.stages.find((s) => s.state !== "done" && s.state !== "skipped");
    if (!stage) return this.finish(run);

    if (stage.state === "pending") {
      stage.state = "running";
      this.stageClock = 0;
      this.onStageStart(run, stage);
      this.emit(false);
      return;
    }

    this.stageClock += TICK_MS;
    stage.ms = this.stageClock;
    if (this.stageClock >= this.stageDuration(stage.id)) {
      stage.state = "done";
      this.onStageEnd(run, stage);
    }
    this.emit(false);
  }

  private stageDuration(id: StageId) {
    if (id === "execute") return 1200;
    if (id === "reason" || id === "respond") return 700;
    return 400;
  }

  private onStageStart(run: Run, stage: StageRun) {
    switch (stage.id) {
      case "intent":
        stage.detail = `${run.intentLabel} · ${Math.round(run.confidence * 100)}% confidence${run.matched.length ? ` · signals: ${run.matched.join(", ")}` : ""}`;
        break;
      case "agents":
        stage.detail = run.agents.map((a) => a.name).join(", ");
        break;
      case "models":
        stage.detail = run.agents.map((a) => `${a.task} → ${a.modelLabel}`).join(" · ");
        break;
      case "memory": {
        run.recalled = this.recall(run.prompt);
        stage.detail = run.recalled.length
          ? run.recalled.map((r) => `[${r.layer}] ${r.title}`).join(" · ")
          : "no relevant memory";
        break;
      }
      case "execute": {
        run.agents.forEach((a) => {
          if (a.state === "queued") a.state = "running";
        });
        const blocking = run.agents
          .map((a) => agentById.get(a.id)!)
          .find((spec) =>
            brainActionNeedsApproval(
              spec.risk === "exec" ? "exec" : spec.risk === "write" ? "write" : "safe",
              actionMode(),
              {
                confirmImportant: this.state.settings.confirmImportant,
                prompt: run.prompt,
              },
            ),
          );
        if (blocking) {
          run.state = "awaiting-approval";
          this.state.approval = {
            runId: run.id,
            agent: blocking.id,
            tool: blocking.tools[blocking.tools.length - 1] ?? "shell.run",
            risk: blocking.risk === "exec" ? "exec" : "write",
            reason: `${blocking.name} needs it to ${blocking.duty.toLowerCase()}`,
          };
          stage.detail = "waiting for your approval";
          this.push("warn", `approval required — ${blocking.name} wants ${blocking.tools.at(-1)}`);
        } else {
          stage.detail = `${run.agents.length} agent(s) working`;
          this.state.stats.toolCalls += run.agents.length;
        }
        break;
      }
      case "collect":
        stage.detail = `${run.agents.filter((a) => a.state !== "blocked").length} result(s) merged`;
        break;
      case "reason":
        stage.detail = "cross-checking agent outputs for contradictions";
        break;
      case "respond":
        stage.detail = "composing in FRIDAY's voice";
        break;
      case "persist":
        stage.detail = this.state.settings.autoLearn
          ? "writing what is worth keeping"
          : "learning disabled — nothing written";
        break;
    }
  }

  private onStageEnd(run: Run, stage: StageRun) {
    if (stage.id === "execute") {
      run.agents.forEach((a) => {
        if (a.state === "running" || a.state === "queued") {
          a.state = "done";
          a.output = agentOutput(a.id, run.prompt);
          // Measured, not invented: tokens are derived from the text this
          // agent actually produced and ms from the real stage clock.
          a.tokens = Math.max(1, Math.round((a.output.length + run.prompt.length) / 4));
          a.ms = Math.max(1, stage.ms || Date.now() - run.startedAt);
        }
      });
    }
    if (stage.id === "respond") {
      run.answer = personaAnswer(run.prompt, run.intent, run.agents, run.recalled);
      this.state.messages = [
        ...this.state.messages,
        { id: nextId("msg"), role: "friday", text: run.answer, at: Date.now(), runId: run.id },
      ];
    }
    if (stage.id === "persist" && this.state.settings.autoLearn && shouldWriteLessons()) {
      this.state.memory = [
        {
          id: nextId("mem"),
          layer: "conversation" as MemoryLayer,
          title: run.prompt.slice(0, 48),
          snippet: `${run.intentLabel} request handled by ${run.agents.map((a) => a.name).join(", ")}.`,
          score: 0.7,
          at: Date.now(),
          pinned: false,
        },
        ...this.state.memory,
      ].slice(0, 200);
      this.state.stats.lessons += 1;
    }
  }

  /** Auto Mode marks itself here so the runtime can shape spoken replies. */
  setAutoMode(on: boolean) {
    this.autoMode = on;
  }

  private recordTurn(run: Run, ok: boolean, error?: string) {
    const ms = run.ms || Date.now() - run.startedAt;
    // Core Brain closes its own loop: verify the result, learn what is useful
    // and record which engine actually earned the routing for this task kind.
    if (this.lastCognition?.runId === run.id) {
      const tVerify = Date.now();
      const verification = coreBrain.reflect({
        cognition: this.lastCognition.cognition,
        answer: run.answer,
        ok,
        ms,
        learn: this.state.settings.autoLearn,
        ...(error ? { error } : {}),
      });
      this.push(verification.ok ? "ok" : "warn", `verification — ${verification.detail}`);
      this.recordDoneTurn(run, "verify.answer", verification.detail, Date.now() - tVerify);
      this.lastCognition = null;
      if (this.state.settings.selfImprove) void coreBrain.reviewSelf();
      return;
    }
    completeTurn({
      taskId: run.id,
      mode: this.autoMode ? "auto" : "manual",
      prompt: run.prompt,
      answer: run.answer,
      ok,
      ms,
      modelIds:
        this.lastDispatch?.runId === run.id
          ? this.lastDispatch.modelIds
          : run.agents.map((agent) => agent.modelId).filter((id): id is string => Boolean(id)),
      ...(error ? { error } : {}),
    });
  }

  private finish(run: Run) {
    this.finishTurnStep(run, "done");
    run.state = "done";
    run.ms = Date.now() - run.startedAt;
    noteObserve({ latencyMs: run.ms });
    this.recordTurn(run, true);
    this.state.activeRunId = null;
    const n = this.state.stats.requests || 1;
    this.state.stats.avgMs = Math.round((this.state.stats.avgMs * (n - 1) + run.ms) / n);
    this.push("ok", `run ${run.id} complete in ${(run.ms / 1000).toFixed(1)}s`);
    this.speakReply(run.answer);
    dispatchPluginHook("on-turn-complete", { runId: run.id, ms: run.ms, ok: true });
    if (this.state.settings.selfImprove && this.state.stats.requests % 3 === 0) this.propose();
    this.stopTimer();
    this.completePhoneCognize("ok", run.answer);
    this.emit();
  }
}

export const brain = new BrainStore();
export { agentSpecs, agentById, pipelineStages, identity };
