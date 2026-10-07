/**
 * Derives FRIDAY's REAL live state for the main window.
 *
 * Everything here is a pure projection of the brain store, the models store,
 * the task ledger, the registries and the voice engine. There is no simulated
 * activity: a component is only "working" when something real is happening in
 * the store that owns it.
 */

import { useEffect, useMemo, useState } from "react";
import type { StageId } from "./brain-catalog";
import { agentSpecs } from "./brain-catalog";
import { useCapabilities } from "./capability-trees";
import { useAssistantMode } from "./use-assistant-mode";
import { useBrain } from "./use-brain";
import { useModels } from "./use-models";
import { useOps } from "./use-ops";
import { useLedger } from "./self/use-self";
import { voicePhaseFromState, type VoicePhase } from "./voice-state";

export type ComponentId =
  | "brain"
  | "intent"
  | "planner"
  | "agent"
  | "skill"
  | "tool"
  | "plugin"
  | "module"
  | "model"
  | "memory"
  | "workflow"
  | "task"
  | "result"
  | "verification";

/** A single truthful readout line inside a component box. */
export type LiveDetail = { k: string; v: string };

export type NodeState = "idle" | "listening" | "working" | "speaking" | "done" | "blocked";

export type LiveComponent = {
  id: ComponentId;
  label: string;
  tone: string;
  side: "left" | "right";
  /** Percentage position inside the graphic area (box centre). */
  x: number;
  y: number;
  active: boolean;
  /** Real per-node lifecycle state. */
  state: NodeState;
  /** Short real status shown in idle state. */
  status: string;
  /** Per-component real readouts (only facts present in the stores). */
  details: LiveDetail[];
  /** Human age of the node's last real activity, e.g. "4s ago". */
  age?: string | undefined;
  /** Extra lines shown only while the component is actually working. */
  action?: string | undefined;
  progress?: number | undefined;
};

export type { VoicePhase } from "./voice-state";

export type FridayLive = {
  busy: boolean;
  awaitingApproval: boolean;
  /** Real current action, e.g. "Executing tools". */
  action: string;
  /** Real emotional state derived from what FRIDAY is actually doing. */
  emotion: string;
  stageLabel: string;
  stageIndex: number;
  stageCount: number;
  progress: number;
  voice: VoicePhase;
  components: LiveComponent[];
  /** Small real session numbers for the Auto Mode HUD strip. */
  session: { runs: number; tokens: number; avgMs: number; errors: number; tasks: number };
};

/** Which components a pipeline stage genuinely uses. */
const STAGE_COMPONENTS: Record<StageId, ComponentId[]> = {
  intent: ["brain", "intent", "planner"],
  agents: ["brain", "planner", "agent", "skill"],
  models: ["brain", "planner", "model"],
  memory: ["brain", "memory"],
  execute: ["brain", "agent", "skill", "tool", "plugin", "module", "task"],
  collect: ["brain", "task", "result"],
  reason: ["brain", "verification", "result"],
  respond: ["brain", "model", "result"],
  persist: ["brain", "memory", "workflow"],
};

const ACTION_BY_STAGE: Record<StageId, string> = {
  intent: "Analyzing request",
  agents: "Selecting agents",
  models: "Routing models",
  memory: "Recalling memory",
  execute: "Executing tools",
  collect: "Collecting results",
  reason: "Verifying answer",
  respond: "Generating response",
  persist: "Saving memory",
};

const EMOTION_BY_STAGE: Record<StageId, string> = {
  intent: "Curious",
  agents: "Focused",
  models: "Focused",
  memory: "Thoughtful",
  execute: "Concentrating",
  collect: "Attentive",
  reason: "Careful",
  respond: "Smiling",
  persist: "Content",
};

/** Layout: compact boxes hugging both sides of the logo, deliberately staggered. */
const LAYOUT: Record<ComponentId, { side: "left" | "right"; x: number; y: number; tone: string }> =
  {
    brain: { side: "left", x: 17, y: 8, tone: "var(--color-primary)" },
    intent: { side: "left", x: 10, y: 21, tone: "oklch(0.74 0.15 195)" },
    planner: { side: "left", x: 16, y: 34, tone: "oklch(0.72 0.16 230)" },
    agent: { side: "left", x: 9, y: 47, tone: "oklch(0.75 0.15 165)" },
    skill: { side: "left", x: 16, y: 60, tone: "oklch(0.78 0.15 140)" },
    tool: { side: "left", x: 10, y: 73, tone: "var(--color-warning)" },
    plugin: { side: "left", x: 19, y: 86, tone: "oklch(0.72 0.17 60)" },
    module: { side: "right", x: 81, y: 86, tone: "oklch(0.7 0.18 300)" },
    model: { side: "right", x: 90, y: 73, tone: "var(--color-accent)" },
    memory: { side: "right", x: 84, y: 60, tone: "var(--color-magenta)" },
    workflow: { side: "right", x: 91, y: 47, tone: "oklch(0.72 0.17 330)" },
    task: { side: "right", x: 84, y: 34, tone: "oklch(0.76 0.14 90)" },
    result: { side: "right", x: 90, y: 21, tone: "oklch(0.78 0.16 120)" },
    verification: { side: "right", x: 83, y: 8, tone: "oklch(0.74 0.15 210)" },
  };

const LABELS: Record<ComponentId, string> = {
  brain: "Brain",
  intent: "Intent",
  planner: "Planner",
  agent: "Agent",
  skill: "Skill",
  tool: "Tool",
  plugin: "Plugin",
  module: "Module",
  model: "Model",
  memory: "Memory",
  workflow: "Workflow",
  task: "Task",
  result: "Result",
  verification: "Verification",
};

const ORDER: ComponentId[] = [
  "brain",
  "intent",
  "planner",
  "agent",
  "skill",
  "tool",
  "plugin",
  "module",
  "model",
  "memory",
  "workflow",
  "task",
  "result",
  "verification",
];

/** Real stage durations mirror the engine so progress is truthful. */
const stageDuration = (id: StageId) =>
  id === "execute" ? 1200 : id === "reason" || id === "respond" ? 700 : 400;

/**
 * Progress while a stage is still running. Streaming stages must not hit 100%
 * against the 1.2s browser-preview timer — a live model can talk for minutes.
 */
export function streamingStageProgress(stage: { id: StageId; ms: number }): number {
  if (stage.id === "execute" || stage.id === "respond") {
    const t = Math.max(0, stage.ms) / 8000;
    return Math.min(92, Math.round(12 + 80 * (1 - Math.exp(-t))));
  }
  return Math.min(100, Math.round((stage.ms / stageDuration(stage.id)) * 100));
}

/** Last time a node was genuinely doing something (module scope on purpose). */
const lastActiveAt = new Map<ComponentId, number>();

const ageOf = (at: number | undefined, now: number): string | undefined => {
  if (!at) return undefined;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 1) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

export function useFridayLive(): FridayLive {
  const brainState = useBrain();
  const modelsState = useModels();
  const ledgerState = useLedger();
  const voiceState = useAssistantMode();
  // Real, disk-backed module registry (empty until the workspace scan fills it).
  const moduleRegistry = useOps().modules;
  const caps = useCapabilities();

  const run = useMemo(
    () => brainState.runs.find((r) => r.id === brainState.activeRunId) ?? null,
    [brainState.runs, brainState.activeRunId],
  );

  const reported = voicePhaseFromState(voiceState.mode, voiceState.voiceState);
  const voice: VoicePhase =
    voiceState.mode === "auto" && run && (reported === "listening" || reported === "off")
      ? "thinking"
      : reported;

  // Ages only need to advance while something real is in flight.
  const ticking = Boolean(run) || voice !== "off";
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 100000), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  return useMemo(() => {
    const now = Date.now();
    void tick;
    const awaitingApproval = Boolean(brainState.approval);
    const busy = Boolean(run) && !awaitingApproval;

    const stage = run?.stages.find((s) => s.state === "running") ?? null;
    const stageIndex = stage && run ? run.stages.findIndex((s) => s.id === stage.id) : -1;
    const stageCount = run?.stages.length ?? 0;
    const stageProgress = stage ? streamingStageProgress(stage) : 0;

    const activeIds = new Set<ComponentId>(
      awaitingApproval
        ? (["brain", "tool"] as ComponentId[])
        : stage
          ? STAGE_COMPONENTS[stage.id]
          : [],
    );

    /* ---------------------------------------------------- real store facts */
    const enabledAgents = Object.values(brainState.agentsEnabled).filter(Boolean).length;
    const installedModels = Object.values(modelsState.installed).filter(Boolean).length;
    const routedTasks = Object.values(modelsState.routing).filter(Boolean).length;
    const pinnedMemories = brainState.memory.filter((m) => m.pinned).length;

    const lastRun =
      run ?? [...brainState.runs].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

    const runningAgents = run?.agents.filter((a) => a.state === "running") ?? [];
    const doneAgents = lastRun?.agents.filter((a) => a.state === "done").length ?? 0;
    const runTokens = lastRun?.agents.reduce((sum, a) => sum + a.tokens, 0) ?? 0;
    const nextStage = run?.stages.find((s) => s.state === "pending") ?? null;
    const activeAgent = runningAgents[0] ?? null;
    const activeModel = activeAgent?.modelLabel ?? run?.agents[0]?.modelLabel ?? "";
    const recallLayers = [...new Set((lastRun?.recalled ?? []).map((r) => r.layer))].join("/");
    const memoryByLayer = brainState.memory.reduce<Record<string, number>>((acc, m) => {
      acc[m.layer] = (acc[m.layer] ?? 0) + 1;
      return acc;
    }, {});
    const memoryTiers = Object.entries(memoryByLayer)
      .map(([k, v]) => `${k}:${v}`)
      .slice(0, 2)
      .join(" ");
    const enabledJobs = brainState.schedule.filter((j) => j.enabled);
    const errorLogs = brainState.log.filter((l) => l.level === "error").length;

    // Registries — the same live capability index the sidebar pages render.
    const skillItems = caps.items.filter((item) => item.tree === "skills");
    const pluginItems = caps.items.filter((item) => item.tree === "plugins");
    const activeSkills = skillItems.filter((s) => s.enabled).length;
    const activePlugins = pluginItems.filter((p) => p.enabled).length;
    const enabledModules = moduleRegistry.filter((m) => m.enabled).length;
    const intentKey = (lastRun?.intentLabel ?? "").toLowerCase();
    const intentToken = intentKey.split(" ")[0] ?? "";
    const matchedSkill =
      skillItems.find(
        (s) =>
          intentToken &&
          (s.name.toLowerCase().includes(intentToken) ||
            s.category.toLowerCase().includes(intentToken) ||
            s.segment.toLowerCase().includes(intentToken)),
      ) ?? null;

    // Task ledger — real background work, independent of the chat pipeline.
    const liveTasks = ledgerState.tasks.filter(
      (t) => t.status === "running" || t.status === "queued" || t.status === "awaiting-approval",
    );
    const topTask = liveTasks[0] ?? ledgerState.tasks[0] ?? null;

    /* ------------------------------------------------------ voice activity */
    // Auto Mode is real work too: hearing, thinking and speaking light up the
    // nodes that are genuinely involved.
    const voiceActive = new Set<ComponentId>();
    if (voice === "listening") voiceActive.add("intent");
    if (voice === "hearing") {
      voiceActive.add("intent");
      voiceActive.add("brain");
    }
    if (voice === "thinking") voiceActive.add("brain");
    if (voice === "speaking") {
      voiceActive.add("result");
      voiceActive.add("model");
    }

    const idleStatus: Record<ComponentId, string> = {
      brain: `${enabledAgents}/${agentSpecs.length} agents ready`,
      intent:
        voice === "unavailable"
          ? voiceState.paused
            ? "microphone paused"
            : "microphone unavailable"
          : voice === "listening" || voice === "hearing"
            ? "wake word armed"
            : "awaiting input",
      planner: `${brainState.stats.requests} runs planned`,
      agent: `${enabledAgents} enabled`,
      skill: `${activeSkills}/${skillItems.length} enabled`,
      tool: `${brainState.stats.toolCalls} calls`,
      plugin: `${activePlugins}/${pluginItems.length} enabled`,
      module: `${enabledModules}/${moduleRegistry.length} enabled`,
      model: `${installedModels} installed · ${routedTasks} routed`,
      memory: `${brainState.memory.length} records`,
      workflow: `${enabledJobs.length} scheduled`,
      task: liveTasks.length ? `${liveTasks.length} running` : "no active task",
      result: brainState.stats.avgMs ? `avg ${brainState.stats.avgMs}ms` : "no results yet",
      verification: `${brainState.stats.lessons} lessons`,
    };

    const activeAction: Partial<Record<ComponentId, string>> = {
      brain:
        voice === "hearing"
          ? "receiving speech"
          : stage
            ? ACTION_BY_STAGE[stage.id]
            : "orchestrating",
      intent:
        voice === "hearing"
          ? `hearing “${voiceState.interim.slice(0, 24)}”`
          : voice === "listening"
            ? "listening for “FRIDAY”"
            : run
              ? `${run.intentLabel} · ${Math.round(run.confidence * 100)}%`
              : "classifying",
      planner: stage ? `step ${stageIndex + 1}/${stageCount}` : "planning",
      agent: activeAgent ? `${activeAgent.name} · ${activeAgent.state}` : "dispatching agents",
      skill: matchedSkill ? matchedSkill.name : "matching skills",
      tool: brainState.approval ? `approval: ${brainState.approval.tool}` : "running tools",
      plugin: `${activePlugins} plugins enabled`,
      module: `${enabledModules} modules enabled`,
      model: voice === "speaking" ? "speaking reply" : activeModel || "routing",
      memory: run?.recalled.length ? `${run.recalled.length} recalled` : "searching memory",
      workflow: "recording run",
      task: topTask ? topTask.title.slice(0, 30) : run ? run.prompt.slice(0, 30) : "",
      result: voice === "speaking" ? "voicing answer" : `${doneAgents} agents merged`,
      verification: "cross-checking answer",
    };

    /* ------------------------------------------------ per-component detail */
    const finishedIds = new Set<ComponentId>();
    if (lastRun) {
      for (const s of lastRun.stages) {
        if (s.state === "done") STAGE_COMPONENTS[s.id].forEach((c) => finishedIds.add(c));
      }
    }

    const line = (k: string, v: string | number | null | undefined): LiveDetail | null =>
      v === null || v === undefined || v === "" ? null : { k, v: String(v) };

    const agentMark = (state: string) =>
      state === "done" ? "✓" : state === "running" ? "…" : state === "failed" ? "✕" : "·";

    const detailMap: Record<ComponentId, (LiveDetail | null)[]> = {
      brain: [
        line("run", lastRun ? (lastRun.id.split("-").slice(-1)[0] ?? null) : "none"),
        line("stage", stage ? `${stage.label} ${stageIndex + 1}/${stageCount}` : "waiting"),
        line("errors", errorLogs),
      ],
      intent: [
        line("intent", lastRun?.intentLabel),
        line("confidence", lastRun ? `${Math.round(lastRun.confidence * 100)}%` : null),
        line("matched", lastRun?.matched.slice(0, 3).join(", ")),
      ],
      planner: [
        line("step", stageCount ? `${stageIndex + 1}/${stageCount}` : null),
        line("next", nextStage?.label ?? (run ? "final stage" : "idle")),
        line("planned", `${brainState.stats.requests} runs`),
      ],
      agent: [
        ...(lastRun?.agents
          .slice(0, 2)
          .map((a) => line(`${agentMark(a.state)} ${a.name.replace(" Agent", "")}`, a.state)) ??
          []),
        line("enabled", `${enabledAgents}/${agentSpecs.length}`),
      ],
      skill: [
        line("registered", skillItems.length),
        line("enabled", activeSkills),
        line("matched", matchedSkill ? `${matchedSkill.name} · ${matchedSkill.category}` : null),
      ],
      tool: [
        line("calls", brainState.stats.toolCalls),
        line("approvals", brainState.stats.approvals),
        line(
          "pending",
          brainState.approval
            ? `${brainState.approval.tool} (${brainState.approval.risk})`
            : ledgerState.approvals.length
              ? `${ledgerState.approvals.length} waiting`
              : null,
        ),
      ],
      plugin: [
        line("enabled", `${activePlugins}/${pluginItems.length}`),
        line("bundled", pluginItems.filter((p) => p.origin === "app").length || null),
      ],
      module: [
        line("enabled", `${enabledModules}/${moduleRegistry.length}`),
        line("active", moduleRegistry.find((m) => m.enabled)?.name),
        line("bridge", modelsState.bridge),
      ],
      model: [
        line("routed", activeModel || `${routedTasks} tasks`),
        line("installed", installedModels),
        line("tokens", runTokens || null),
      ],
      memory: [
        line("records", `${brainState.memory.length} · ${pinnedMemories} pinned`),
        line("tiers", memoryTiers),
        line(
          "recalled",
          lastRun?.recalled.length ? `${lastRun.recalled.length} ${recallLayers}` : null,
        ),
      ],
      workflow: [
        line("scheduled", enabledJobs.length),
        line("next", enabledJobs[0]?.when),
        line("last", enabledJobs[0]?.lastRun),
      ],
      task: [
        line("id", topTask ? (topTask.id.split("-").slice(-1)[0] ?? null) : "idle"),
        line("title", topTask?.title.slice(0, 24) ?? lastRun?.prompt.slice(0, 24)),
        line(
          "status",
          topTask
            ? `${topTask.status} ${Math.round(topTask.progress)}%`
            : `${liveTasks.length} live`,
        ),
      ],
      result: [
        line("merged", `${doneAgents}/${lastRun?.agents.length ?? 0} agents`),
        line("answer", lastRun?.answer ? `${lastRun.answer.length} chars` : "pending"),
        line("avg", brainState.stats.avgMs ? `${brainState.stats.avgMs}ms` : null),
      ],
      verification: [
        line("outcome", lastRun?.state ?? "idle"),
        line("lessons", brainState.stats.lessons),
        line("requests", brainState.stats.requests),
      ],
    };

    const components: LiveComponent[] = ORDER.map((id) => {
      const layout = LAYOUT[id];
      const pipelineActive = activeIds.has(id);
      const voiceOn = voiceActive.has(id);
      const active = pipelineActive || voiceOn;
      const blocked =
        (awaitingApproval && (id === "tool" || id === "brain")) ||
        (id === "tool" && ledgerState.approvals.length > 0);
      const nodeState: NodeState = blocked
        ? "blocked"
        : pipelineActive
          ? "working"
          : voiceOn
            ? voice === "speaking"
              ? "speaking"
              : "listening"
            : finishedIds.has(id)
              ? "done"
              : "idle";
      if (active) lastActiveAt.set(id, now);
      return {
        id,
        label: LABELS[id],
        tone: layout.tone,
        side: layout.side,
        x: layout.x,
        y: layout.y,
        active,
        state: nodeState,
        status: idleStatus[id],
        details: detailMap[id].filter((d): d is LiveDetail => d !== null).slice(0, 3),
        age: active ? "now" : ageOf(lastActiveAt.get(id), now),
        ...(active
          ? {
              action: activeAction[id],
              progress: pipelineActive ? stageProgress : undefined,
            }
          : {}),
      };
    });

    // Emotion reflects what is genuinely happening, including a short warm
    // window right after a completed answer.
    const lastFriday = [...brainState.messages].reverse().find((m) => m.role === "friday");
    const justAnswered = Boolean(lastFriday && lastFriday.runId && !run);

    let action = "Idle";
    let emotion = "Relaxed";
    if (awaitingApproval) {
      action = "Waiting for your approval";
      emotion = "Cautious";
    } else if (voice === "hearing") {
      action = "Hearing you";
      emotion = "Attentive";
    } else if (stage) {
      action = ACTION_BY_STAGE[stage.id];
      emotion = EMOTION_BY_STAGE[stage.id];
    } else if (voice === "speaking") {
      action = "Speaking";
      emotion = "Smiling";
    } else if (run) {
      action = "Starting up the pipeline";
      emotion = "Alert";
    } else if (voice === "unavailable") {
      action = voiceState.paused ? "Microphone paused" : "Microphone unavailable";
      emotion = "Concerned";
    } else if (justAnswered) {
      action = "Idle · answer delivered";
      emotion = "Smiling";
    } else if (voice === "listening") {
      action = "Listening for “FRIDAY”";
    }

    return {
      busy,
      awaitingApproval,
      action,
      emotion,
      stageLabel: stage?.label ?? "",
      stageIndex,
      stageCount,
      progress: stageProgress,
      voice,
      components,
      session: {
        runs: brainState.stats.requests,
        tokens: runTokens,
        avgMs: brainState.stats.avgMs,
        errors: errorLogs,
        tasks: liveTasks.length,
      },
    };
  }, [
    brainState,
    modelsState,
    ledgerState,
    voiceState,
    moduleRegistry,
    caps.items,
    voice,
    run,
    tick,
  ]);
}
