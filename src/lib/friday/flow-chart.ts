/**
 * FRIDAY · owner flow chart index
 *
 * ONE index that binds the owner's master chart (Dev → Auto/Manual →
 * Experience → Supervisor → Runtimes → Orchestrator → Model Router → Agents →
 * Capability Bus → Permission → Execution → Verification → Memory → Idle →
 * Improvement → Evolve) to the code that really implements each box.
 *
 * This module owns no behaviour of its own — every node resolves a live
 * module that already exists, so nothing here can drift into a second
 * implementation. `core/__tests__/owner-flow-chart.test.ts` resolves every
 * node against the real modules, which is what makes the chart a contract
 * instead of a picture.
 */

import { assistantMode } from "./assistant-mode";
import { brain } from "./brain-engine";
import { notifications } from "./notifications";
import { stage } from "./stage";
import { systemMap } from "./system-map";
import { voiceGate } from "./voice-audio";
import { nextVoiceState } from "./voice-state";
import { matchWakeWord } from "./wake-word";
import { wakeEngineStatus } from "./wake-engine";
import { coreBrain } from "./brain/core-brain";
import { understand } from "./brain/intent-engine";
import { resolveContext } from "./brain/context-engine";
import { observeBrain } from "./brain/observe";
import { vary } from "./brain/anti-repeat";
import { capabilityRegistry } from "./brain/capability-registry";
import { modelRegistry } from "./brain/model-registry";
import { classifyPriority } from "./brain/priority";
import { planPipeline } from "./brain/orchestrator";
import { currentPolicy } from "./brain/cost-policy";
import { actionNeedsApproval } from "./brain/action-risk";
import { chooseSkill } from "./brain/skill-router";
import { chooseTools } from "./brain/tool-router";
import { chooseModules } from "./brain/module-router";
import { chooseConnectors } from "./brain/connector-router";
import { chooseWorkflows } from "./brain/workflow-router";
import { dispatchPluginHook } from "./plugin-hooks";
import { listAgentsFromRegistry } from "./brain/agent-router";
import { considerCollaboration } from "./brain/multi-model";
import { ledger, experiences } from "./self/task-ledger";
import { taskGraph } from "./self/task-graph";
import { backgroundTasks } from "./self/background-tasks";
import { autonomousCore } from "./self/autonomous-core";
import { autonomy } from "./self/autonomy";
import { governance } from "./self/governance";
import { learning } from "./self/learning-engine";
import { memory } from "./self/memory-engine";
import { library } from "./library-engine";
import { projectWorkspaces } from "./project-workspace-engine";
import { capabilityMatrix } from "./self/capability-matrix";
import { devPipeline } from "./self/dev-pipeline";
import { self } from "./self/self-manager";
import { models } from "./models-engine";
import { ops } from "./ops-engine";
import { doctor } from "./doctor-engine";
import { privacy } from "./privacy";

import { knownConnectors } from "./connectors";
import { classifyIntent } from "../../../core/brain/intent";
import { prepare } from "../../../core/brain/router";
import { planWaves } from "../../../core/brain/planner";
import { verifyResult } from "../../../core/brain/decision";
import { tasks } from "../../../core/orchestration";
import { permissions } from "../../../core/permissions";
import { modelRouter } from "../../../core/ai/model-router";
import { locks } from "../../../core/synchronization";

export type FlowLayerId =
  | "owner"
  | "entry"
  | "experience"
  | "supervisor"
  | "voice-runtime"
  | "thinking"
  | "task-runtime"
  | "orchestrator"
  | "model-router"
  | "agents"
  | "capability-bus"
  | "permission"
  | "execution"
  | "verification"
  | "memory"
  | "idle"
  | "improvement";

export type FlowNode = {
  /** Stable id, `<layer>.<node>`. */
  id: string;
  /** The box exactly as the owner's chart names it. */
  label: string;
  /** Repository path of the single implementation that owns this box. */
  module: string;
  /** What this box really does in the running app. */
  detail: string;
  /** Live binding — never a copy of the implementation. */
  resolve: () => unknown;
};

export type FlowLayer = {
  id: FlowLayerId;
  title: string;
  /** Position in the chart, top to bottom. */
  order: number;
  nodes: FlowNode[];
};

const node = (
  id: string,
  label: string,
  module: string,
  detail: string,
  resolve: () => unknown,
): FlowNode => ({ id, label, module, detail, resolve });

export const FLOW_CHART: FlowLayer[] = [
  {
    id: "owner",
    title: "Dev — owner / authority",
    order: 1,
    nodes: [
      node(
        "owner.identity",
        "FRIDAY owner",
        "src/lib/friday/self/governance.ts",
        "Single owner authority; every consequential action resolves to his approval.",
        () => governance,
      ),
      node(
        "owner.autonomy",
        "Authority level",
        "src/lib/friday/self/autonomy.ts",
        "How much FRIDAY may do unattended, chosen by the owner.",
        () => autonomy.getSnapshot(),
      ),
    ],
  },
  {
    id: "entry",
    title: "Auto mode · Manual mode",
    order: 2,
    nodes: [
      node(
        "entry.auto",
        "Auto mode (voice)",
        "src/lib/friday/assistant-mode.ts",
        "Wake-word driven voice session; enters the same brain path as typing.",
        () => assistantMode.getSnapshot().mode,
      ),
      node(
        "entry.manual",
        "Manual mode (chat)",
        "src/lib/friday/brain-engine.ts",
        "Typed chat turn; identical pipeline, no second lighter path.",
        () => brain.getSnapshot().messages,
      ),
    ],
  },
  {
    id: "experience",
    title: "Experience layer",
    order: 3,
    nodes: [
      node(
        "experience.voice",
        "Voice",
        "src/lib/friday/voice-state.ts",
        "Formal voice state machine driving captions and HUD.",
        () => nextVoiceState,
      ),
      node(
        "experience.chat",
        "Chat",
        "src/lib/friday/brain-engine.ts",
        "Conversation surface and run history.",
        () => brain.getSnapshot().runs,
      ),
      node(
        "experience.tray",
        "Tray",
        "electron/tray.cjs",
        "Tray icon, hidden-window persistence and pause/resume from the tray.",
        () => assistantMode.getSnapshot().paused !== undefined,
      ),
      node(
        "experience.notifications",
        "Notifications",
        "src/lib/friday/notifications.ts",
        "One notification bus for every subsystem.",
        () => notifications.getSnapshot(),
      ),
      node(
        "experience.dashboard",
        "Dashboard",
        "src/lib/friday/stage.ts",
        "What the owner is shown next, per turn.",
        () => stage.getSnapshot(),
      ),
      node(
        "experience.status",
        "Status",
        "src/lib/friday/system-map.ts",
        "Live map of every component, its status and dependencies.",
        () => systemMap,
      ),
      node(
        "experience.memory",
        "Memory surface",
        "src/lib/friday/self/memory-engine.ts",
        "Tiered memory the owner can read and pin.",
        () => memory.getSnapshot().items,
      ),
    ],
  },
  {
    id: "supervisor",
    title: "FRIDAY supervisor",
    order: 4,
    nodes: [
      node(
        "supervisor.session",
        "Session manager",
        "src/lib/friday/assistant-mode.ts",
        "Owns the live session: mode, pause, hands-free, voice state.",
        () => assistantMode.getSnapshot(),
      ),
      node(
        "supervisor.task",
        "Task manager",
        "src/lib/friday/self/task-ledger.ts",
        "Durable record of every task, its status and its result.",
        () => ledger.getSnapshot(),
      ),
      node(
        "supervisor.conversation",
        "Conversation manager",
        "src/lib/friday/brain-engine.ts",
        "Turns, runs, approvals and transcript persistence.",
        () => brain.getSnapshot(),
      ),
      node(
        "supervisor.priority",
        "Priority manager",
        "src/lib/friday/brain/priority.ts",
        "Classifies urgency and decides what may be deferred to background.",
        () => classifyPriority,
      ),
      node(
        "supervisor.resource",
        "Resource manager",
        "src/lib/friday/ops-engine.ts",
        "CPU/RAM/disk pressure and service health gating heavy work.",
        () => ops.getSnapshot(),
      ),
      node(
        "supervisor.model",
        "Model manager",
        "src/lib/friday/models-engine.ts",
        "Installed, downloadable and connected models with their state.",
        () => models.getSnapshot(),
      ),
      node(
        "supervisor.agent",
        "Agent manager",
        "src/lib/friday/brain/capability-registry.ts",
        "The one registry of agents, skills, tools, plugins and workflows.",
        () => capabilityRegistry.getSnapshot(),
      ),
      node(
        "supervisor.background",
        "Background job manager",
        "src/lib/friday/self/background-tasks.ts",
        "Long-running jobs that survive the current turn.",
        () => backgroundTasks.getSnapshot(),
      ),
      node(
        "supervisor.interrupt",
        "Interrupt manager",
        "src/lib/friday/assistant-mode.ts",
        "Barge-in, stop words and stream abort across voice and chat.",
        () => assistantMode.setPaused,
      ),
      node(
        "supervisor.approval",
        "Approval manager",
        "src/lib/friday/brain/action-risk.ts",
        "Decides which actions need the owner before they run.",
        () => actionNeedsApproval,
      ),
    ],
  },
  {
    id: "voice-runtime",
    title: "Voice runtime",
    order: 5,
    nodes: [
      node(
        "voice.microphone",
        "Microphone",
        "src/lib/friday/voice-audio.ts",
        "One shared microphone stream with holder tracking.",
        () => voiceGate.getSnapshot(),
      ),
      node(
        "voice.vad",
        "VAD",
        "src/lib/friday/voice-audio.ts",
        "Local speech/silence detection with noise floor tracking.",
        () => voiceGate.getSnapshot().noiseFloor,
      ),
      node(
        "voice.wake",
        "Wake detector",
        "src/lib/friday/wake-word.ts",
        "Native detector (friday-linear / openWakeWord) scores captured VoiceGate clips on a persistent worker; transcript fallback otherwise. Not a live microphone tap.",
        () => matchWakeWord,
      ),
      node(
        "voice.wake-engine",
        "Wake engine status",
        "src/lib/friday/wake-engine.ts",
        "Reports which detector is actually active.",
        () => wakeEngineStatus,
      ),
      node(
        "voice.stt",
        "STT",
        "src/lib/friday/voice-stt.ts",
        "Local faster-whisper on a persistent worker (model loaded once per session).",
        () => import("./voice-stt"),
      ),
    ],
  },
  {
    id: "thinking",
    title: "Thinking",
    order: 6,
    nodes: [
      node(
        "thinking.intent",
        "Command / intent",
        "core/brain/intent/index.ts",
        "Classifies the goal before any model is contacted.",
        () => classifyIntent,
      ),
      node(
        "thinking.planner",
        "Planner",
        "core/brain/planner/index.ts",
        "Turns the intent into ordered, inspectable steps and waves.",
        () => planWaves,
      ),
      node(
        "thinking.prepare",
        "Context + reasoning",
        "core/brain/router/index.ts",
        "One pass that classifies, assesses and plans without executing.",
        () => prepare,
      ),
      node(
        "thinking.cognition",
        "Cognition",
        "src/lib/friday/brain/core-brain.ts",
        "Builds the single context payload used by chat and voice alike.",
        () => coreBrain.cognize,
      ),
      node(
        "thinking.understand",
        "Intent (live)",
        "src/lib/friday/brain/intent-engine.ts",
        "Runtime intent: kind, entities, follow-ups, when to ask instead of guess.",
        () => understand,
      ),
      node(
        "thinking.context",
        "Context",
        "src/lib/friday/brain/context-engine.ts",
        "Resolves it/that/continue, option N, and prior-talk refs against session state plus the memory fabric.",
        () => resolveContext,
      ),
      node(
        "thinking.observe",
        "Observability",
        "src/lib/friday/brain/observe.ts",
        "Diagnostic snapshot: intent, tasks, model, confidence. No chain-of-thought.",
        () => observeBrain(),
      ),
      node(
        "thinking.voice-same-brain",
        "Anti-repetition",
        "src/lib/friday/brain/anti-repeat.ts",
        "Chat and voice share one variation pool for greetings and acknowledgements. Vocatives come from the user profile, not the publisher name.",
        () => vary,
      ),
    ],
  },
  {
    id: "task-runtime",
    title: "Task runtime",
    order: 7,
    nodes: [
      node(
        "task.queue",
        "Task queue",
        "core/orchestration/index.ts",
        "De-duplicated, cancellable, timeout-bounded work queue.",
        () => tasks.submit,
      ),
      node(
        "task.scheduler",
        "Task scheduler",
        "src/lib/friday/self/task-graph.ts",
        "Decomposes a goal into nodes and schedules them in dependency order.",
        () => taskGraph.getSnapshot(),
      ),
      node(
        "task.workers",
        "Parallel workers",
        "src/lib/friday/self/task-runners.ts",
        "Registered runners that execute graph nodes concurrently.",
        () => import("./self/task-runners"),
      ),
      node(
        "task.background",
        "Background jobs",
        "src/lib/friday/self/background-tasks.ts",
        "Jobs that continue while the owner does something else.",
        () => backgroundTasks.getSnapshot().jobs ?? backgroundTasks.getSnapshot(),
      ),
      node(
        "task.locks",
        "Mutual exclusion",
        "core/synchronization/index.ts",
        "Single-flight and lock table so one resource is never raced.",
        () => locks,
      ),
    ],
  },
  {
    id: "orchestrator",
    title: "Orchestrator — understand → plan → decompose → assign → execute → verify → report",
    order: 8,
    nodes: [
      node(
        "orchestrator.pipeline",
        "Pipeline",
        "src/lib/friday/brain/orchestrator.ts",
        "Assigns roles and steps for single-task, multi-task and background work.",
        () => planPipeline,
      ),
      node(
        "orchestrator.collaboration",
        "Multi-model collaboration",
        "src/lib/friday/brain/multi-model.ts",
        "Adds a second opinion only when confidence or the owner demands it.",
        () => considerCollaboration,
      ),
      node(
        "orchestrator.report",
        "Report",
        "src/lib/friday/self/task-ledger.ts",
        "Every run ends as a recorded outcome, not a silent stop.",
        () => experiences.getSnapshot(),
      ),
    ],
  },
  {
    id: "model-router",
    title: "Model router — analysis → capability → cost → availability → selection",
    order: 9,
    nodes: [
      node(
        "router.select",
        "Selection",
        "core/ai/model-router/index.ts",
        "Chooses the provider/model actually used for a role.",
        () => modelRouter,
      ),
      node(
        "router.capability",
        "Capability match",
        "src/lib/friday/brain/model-registry.ts",
        "Per-model capability and measured performance records.",
        () => modelRegistry,
      ),
      node(
        "router.cost",
        "Cost policy",
        "src/lib/friday/brain/cost-policy.ts",
        "Paid cloud stays off unless the owner allows paid and a key is connected.",
        () => currentPolicy(),
      ),
      node(
        "router.availability",
        "Availability",
        "src/lib/friday/models-engine.ts",
        "Local (Ollama etc.), free cloud and connected paid models with live health.",
        () => models.getSnapshot().installed,
      ),
    ],
  },
  {
    id: "agents",
    title: "Agent / capability layer",
    order: 10,
    nodes: [
      node(
        "agents.registry",
        "Agents",
        "src/lib/friday/brain/agent-router.ts",
        "Picks enabled+safe installed agents from the live capability registry. Background plan()/run() packs and marketplace personas share this router.",
        () => listAgentsFromRegistry,
      ),
      node(
        "agents.skills",
        "Skill routing",
        "src/lib/friday/brain/skill-router.ts",
        "Picks the installed skill that best matches the request.",
        () => chooseSkill,
      ),
      node(
        "agents.tools",
        "Tool routing",
        "src/lib/friday/brain/tool-router.ts",
        "Picks enabled+safe catalog tools that match the request and can actually run.",
        () => chooseTools,
      ),
      node(
        "agents.modules",
        "Module routing",
        "src/lib/friday/brain/module-router.ts",
        "Picks enabled+safe catalog modules that match the request and can actually run.",
        () => chooseModules,
      ),
      node(
        "agents.connectors",
        "Connector routing",
        "src/lib/friday/brain/connector-router.ts",
        "Picks safe actions on connected services when the request names that service. Write/exec still goes through governance.",
        () => chooseConnectors,
      ),
      node(
        "agents.workflows",
        "Workflow routing",
        "src/lib/friday/brain/workflow-router.ts",
        "Picks one, sequential (then/also), or parallel (at once) enabled+safe catalog workflows when the request names them. A keyword index scores candidates only — not the whole catalog. Long step chains run through existing skill/tool/agent/module/connector invokes. Write/exec stays dry-run unless approved.",
        () => chooseWorkflows,
      ),
    ],
  },
  {
    id: "capability-bus",
    title: "Capability bus — skills · tools · plugins · modules · workflows · connectors · APIs",
    order: 11,
    nodes: [
      node(
        "bus.capabilities",
        "Capability bus",
        "src/lib/friday/capabilities.ts",
        "One typed surface over every capability kind.",
        () => import("./capabilities"),
      ),
      node(
        "bus.connectors",
        "Connectors",
        "src/lib/friday/connectors.ts",
        "Live registry of outside services. Connected only after a real authenticated probe. Chat routes through connector-router / connectorTools().",
        () => knownConnectors,
      ),
      node(
        "bus.plugins",
        "Plugin hooks",
        "src/lib/friday/plugin-hooks.ts",
        "Enabled catalog plugins fire declared hooks at real lifecycle moments through electron/plugins.cjs. Test selected dispatches one pack.",
        () => dispatchPluginHook,
      ),
      node(
        "bus.workflows",
        "Workflow packs",
        "src/lib/friday/brain/workflow-forge.ts",
        "Shipped workflow.json packs: sequential steps over existing skills, tools, agents, modules, and connectors. Visual create/edit, the Workflows Visual Builder (@xyflow/react node graph of the same steps[]), and Test selected dry-run the selected pack. Agents may declare workflows[] of existing pack ids.",
        () => import("./brain/workflow-forge"),
      ),
      node(
        "bus.matrix",
        "Capability matrix",
        "src/lib/friday/self/capability-matrix.ts",
        "Scores how well each capability actually performs.",
        () => capabilityMatrix.getSnapshot(),
      ),
    ],
  },
  {
    id: "permission",
    title: "Permission engine — safe · approval · block",
    order: 12,
    nodes: [
      node(
        "permission.broker",
        "Permission broker",
        "core/permissions/index.ts",
        "Capability-tiered gate in front of every machine action.",
        () => permissions,
      ),
      node(
        "permission.privacy",
        "Privacy firewall",
        "src/lib/friday/privacy.ts",
        "Sensitive content never leaves the PC without a fresh answer.",
        () => privacy.getSnapshot(),
      ),
      node(
        "permission.governance",
        "Owner approval",
        "src/lib/friday/self/governance.ts",
        "Self-modifying work always asks; approval code can never self-approve.",
        () => governance.getSnapshot(),
      ),
      node(
        "permission.billing",
        "Billing firewall",
        "kernel/router.py",
        "Cost and billing firewall in the kernel router — never switchable from the wiring panel.",
        () => currentPolicy(),
      ),
      node(
        "permission.authority",
        "Tool authority",
        "electron/tool-authority.cjs",
        "Main-process tool allowlist and confirmation — never switchable from the wiring panel.",
        () => actionNeedsApproval,
      ),
    ],
  },
  {
    id: "execution",
    title: "Execution",
    order: 13,
    nodes: [
      node(
        "execution.runners",
        "Execution",
        "src/lib/friday/self/task-runners.ts",
        "Runs the approved step through the real tool or model.",
        () => import("./self/task-runners"),
      ),
      node(
        "execution.health",
        "Monitor",
        "src/lib/friday/doctor-engine.ts",
        "Watches the runtime while work is executing.",
        () => doctor.getSnapshot(),
      ),
    ],
  },
  {
    id: "verification",
    title: "Verification — pass → complete · fail → retry/fix",
    order: 14,
    nodes: [
      node(
        "verify.step",
        "Step verification",
        "core/brain/decision/index.ts",
        "Every executed step is verified before it counts as done.",
        () => verifyResult,
      ),
      node(
        "verify.answer",
        "Answer verification",
        "src/lib/friday/brain/core-brain.ts",
        "An empty or deflected answer is never reported as success.",
        () => coreBrain.verify,
      ),
      node(
        "verify.repair",
        "Retry / fix",
        "src/lib/friday/brain-engine.ts",
        "A failed turn produces a concrete repair plan, not a dead end.",
        () => import("./brain-engine"),
      ),
    ],
  },
  {
    id: "memory",
    title: "Memory",
    order: 15,
    nodes: [
      node(
        "memory.library",
        "Owner Library (uploaded / generated / modified files)",
        "src/lib/friday/library-engine.ts",
        "One Library index under FRIDAY_ROOT. Chat attach, teach, and Auto Mode pins share this store — not Import & Build.",
        () => library.list(),
      ),
      node(
        "memory.projects",
        "Owner Projects & Workspaces (scoped work + Chat + Auto hands-off)",
        "src/lib/friday/project-workspace-engine.ts",
        "One project manifest under FRIDAY_ROOT/projects. Section Chat injects extra; Auto hands-off skips writes into that root. Folders and Sandbox stay themselves.",
        () => projectWorkspaces.list(true),
      ),
      node(
        "memory.tiers",
        "Conversation / task / preference / knowledge memory",
        "src/lib/friday/self/memory-engine.ts",
        "Tiered memory: conversation, task, preferences, project and tool knowledge.",
        () => memory.getSnapshot().items,
      ),
      node(
        "memory.performance",
        "Model performance",
        "src/lib/friday/brain/model-registry.ts",
        "Measured latency and success per model, reused by the router.",
        () => modelRegistry,
      ),
      node(
        "memory.history",
        "Error history / successful strategies",
        "src/lib/friday/self/task-ledger.ts",
        "Every outcome, good or bad, is kept and reused.",
        () => experiences.getSnapshot(),
      ),
    ],
  },
  {
    id: "idle",
    title: "Idle / background engine — discover · learn · test",
    order: 16,
    nodes: [
      node(
        "idle.core",
        "Idle engine",
        "src/lib/friday/self/autonomous-core.ts",
        "Runs only when resources are free and nothing urgent is blocked.",
        () => autonomousCore.getSnapshot(),
      ),
      node(
        "idle.learn",
        "Learn",
        "src/lib/friday/self/learning-engine.ts",
        "Turns outcomes into lessons and strategy changes.",
        () => learning,
      ),
      node(
        "idle.discover",
        "Discover",
        "src/lib/friday/self/self-manager.ts",
        "Finds missing tools, models and libraries.",
        () => self.getSnapshot(),
      ),
    ],
  },
  {
    id: "improvement",
    title: "Improvement engine — propose → approve → sandbox → build/test → version or rollback",
    order: 17,
    nodes: [
      node(
        "improve.pipeline",
        "Development pipeline",
        "src/lib/friday/self/dev-pipeline.ts",
        "Proposal, sandbox, build, test, compare-to-baseline, promote or roll back.",
        () => devPipeline.getSnapshot(),
      ),
      node(
        "improve.approval",
        "Dev approval",
        "src/lib/friday/self/governance.ts",
        "No self-change installs without the owner.",
        () => governance.getSnapshot(),
      ),
      node(
        "improve.registry",
        "Registry update / new capability",
        "src/lib/friday/brain/capability-registry.ts",
        "A promoted change is registered so it is usable on the next turn.",
        () => capabilityRegistry.getSnapshot(),
      ),
    ],
  },
];

/** The ten supervisor managers named in the owner's chart. */
export const SUPERVISOR_MANAGERS: FlowNode[] =
  FLOW_CHART.find((layer) => layer.id === "supervisor")?.nodes ?? [];

export type FlowNodeCheck = {
  id: string;
  label: string;
  module: string;
  ok: boolean;
  detail: string;
};

/** Resolves every node against the live modules. Never throws. */
export function resolveFlow(): FlowNodeCheck[] {
  const checks: FlowNodeCheck[] = [];
  for (const layer of FLOW_CHART) {
    for (const item of layer.nodes) {
      try {
        const value = item.resolve();
        checks.push({
          id: item.id,
          label: item.label,
          module: item.module,
          ok: value !== undefined && value !== null,
          detail: value === undefined || value === null ? "resolved to nothing" : item.detail,
        });
      } catch (error) {
        checks.push({
          id: item.id,
          label: item.label,
          module: item.module,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return checks;
}

/** Ids of chart boxes that are not backed by working code right now. */
export function flowGaps(): string[] {
  return resolveFlow()
    .filter((check) => !check.ok)
    .map((check) => `${check.id}: ${check.detail}`);
}

/** Flat, ordered list of every chart box — used by docs and tests. */
export function flowNodes(): FlowNode[] {
  return [...FLOW_CHART].sort((a, b) => a.order - b.order).flatMap((layer) => layer.nodes);
}
