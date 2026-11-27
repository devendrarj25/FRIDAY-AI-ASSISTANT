/**
 * FRIDAY · Core Brain
 *
 * FRIDAY's own cognitive layer. It sits between the UI (Manual Mode chat and
 * Auto Mode voice) and every model, tool and skill on the machine. Models —
 * local Qwen/Llama or a cloud provider — are specialist engines she calls;
 * they are never FRIDAY herself.
 *
 * One flow, both modes (orchestrator only — specialists keep their own files):
 *   INPUT → CONTEXT → MEMORY → KNOWLEDGE → WORLD STATE → INTENT/GOAL →
 *   REASONING → PLANNING → CAPABILITY ROUTING → MODEL ROUTING → ACTION →
 *   OBSERVATION → VERIFICATION → RESPONSE → LEARNING
 *
 * This file coordinates existing specialists (identity, memory, knowledge,
 * world-model, reasoning, meta-reasoner, model registry/orchestrator, runtime
 * dispatch, governance). It does not absorb those specialists' logic. Nothing
 * here invents a result: when a tool or model is unavailable it is reported,
 * not faked.
 *
 * Safety is FRIDAY's own and simple: she does what the owner asks and asks the
 * owner before anything that changes the system. Self-improvement only ever
 * produces proposals — governance holds them until the owner approves.
 */

import { pastEvidence } from "./memory-asof";
import { stageOff } from "./stage-switches";
import {
  prepareTurn,
  refineTurnWithDispatchRole,
  completeTurn,
  type TurnDispatch,
  type TurnMode,
} from "../runtime";
import { browserAvailable, webSearch } from "../browser-engine";
import {
  rankSources,
  researchNote,
  evaluateSources,
  shouldResearch,
  looksLikeLiveFact,
  looksLikeLiveState,
  looksLikeKnowledgeAsk,
  formulateQueries,
} from "./research";
import { experiences } from "../self/task-ledger";
import { finishAnswer, recordAnswer } from "./answer-ledger";
import { noteCardAnswer, noteLedgerTurn, watchLearnedAnswer } from "./intent-memory";
import { considerMemory, looksSensitive } from "./memory-policy";
import { modelRegistry as brainModelRegistry } from "./model-registry";
import { shouldWriteLessons } from "../settings-runtime";
import { brainKnowledge } from "./knowledge-base";
import { walkOpsChain, localNeighborhood, inferMultiHop } from "./knowledge-graph";
import { ingestKnowledge } from "./knowledge-ingest";
import { isNonOwnerRow, quotedDataBlock } from "./quoted-data";
import { whatIfFromPrompt } from "./ops-whatif";
import { allowedModelIds } from "./cost-policy";
import { consolidateEvent } from "../self/memory-consolidate";
import { governance } from "../self/governance";
import { learning } from "../self/learning-engine";
import { readLocalState, restoreFromDisk, writeState } from "../persist";
import { capabilityRegistry, type CapabilitySnapshot } from "./capability-registry";
import { describeLiveSelf, looksLikeSelfStatusQuestion } from "./app-guide";
import { answerSelf, selfTopic } from "./self-questions";
import { describeSkillValue, routeSkills as routeSkillsRaw } from "./skill-router";
import { manageSkillsFromPrompt } from "./skill-manager";
import { managePluginsFromPrompt, pluginWarnings } from "./plugin-manager";
import { describeAgentValue, routeAgents as routeAgentsRaw } from "./agent-router";
import { describeToolValue, routeTools as routeToolsRaw } from "./tool-router";
import { describeModuleValue, routeModules as routeModulesRaw } from "./module-router";
import { describeConnectorValue, routeConnectors as routeConnectorsRaw } from "./connector-router";
import { describeWorkflowValue, routeWorkflows as routeWorkflowsRaw } from "./workflow-router";
import { noteObserve } from "./observe";
import { fileSkillGapDraft, looksLikeCapabilityGap } from "./skill-forge";
import { fileAgentGapDraft, looksLikeAgentGap } from "./agent-forge";
import { fileModuleGapDraft, looksLikeModuleGap } from "./module-forge";
import { filePluginGapDraft, looksLikePluginGap } from "./plugin-forge";
import { fileWorkflowGapDraft, looksLikeWorkflowGap } from "./workflow-forge";
import { dispatchPluginHook } from "../plugin-hooks";
import { turnDone, turnMark, withDeadline } from "./turn-timing";
import type { StageReporter } from "./turn-trace";
import { understandTurn, toUnderstandingTrace, type TurnUnderstanding } from "./intent-engine";
import {
  conversationDigest,
  lastDecision,
  snapshotCurrentSituation,
  type SessionTurn,
} from "./conversation-state";
import { openLoopDigest } from "./open-loops";
import { noteUnderstanding } from "./decision-trace";
import { readWorldInsight } from "./world-model";
import { checkAnswer, checksFor } from "./answer-checks";
import { checkCitations } from "./web-sources";
import { compareOf, MIN_COMPARE_TASKS } from "./model-profile";
import {
  reviewAssumptions,
  evaluateAnswer,
  evaluateConversationalFit,
  reviseConversationalAnswer,
  type MetaReview,
} from "./meta-reasoner";
import { reasonAbout, type ReasoningTrace } from "./reasoning";
import { installCognitiveBaseline } from "./cognitive-baseline";
import { vectorIndex } from "./vector-index";
import { gradeRetrieval } from "./retrieval";
import { memory } from "../self/memory-engine";
import {
  classifyCognitiveRoute,
  reasoningEffortFor,
  type CognitiveAction,
  type ReasoningEffort,
} from "./cognitive-route";
import { finishCognitiveCycle, planCognitiveDepth, type CognitiveCycle } from "./cognitive-control";
import {
  commitLocalAnswer,
  consultLocalMind,
  distillLocalAnswer,
  noteModelTurn,
  packHistory,
  type LocalMindDecision,
} from "./local-mind";
import { isConsequential } from "./action-risk";
import { classifyModality } from "./modality";
import { videoFilesIn, videoSteps } from "./video-method";
import { selectResponseStrategy, type ResponseStrategy } from "./decision-engine";
import { refreshScreenObservation } from "./screen-observe";
import { refreshCameraObservation } from "./camera-observe";
import { observeTerminalState, terminalLookRequested } from "./terminal-observe";
import { observeLogsState, logsLookRequested } from "./logs-observe";
import { observeTasksState, tasksLookRequested } from "./tasks-observe";
import { observeDoctorState, doctorLookRequested } from "./doctor-observe";
import { observeInstallerState, installerLookRequested } from "./installer-observe";
import { observeLibraryState, libraryLookRequested } from "./library-observe";
import { observeProjectWorkspaceState, projectLookRequested } from "./project-workspace-observe";
import { observeBrowserState, browserLookRequested } from "./browser-observe";
import { projectWorkspaces } from "../project-workspace-engine";
import { filterMemoriesForProject } from "../project-workspace-logic";
import { proposeFabricLimitation } from "../self/limitation-loop";
import {
  IDENTITY_DIRECTIVE,
  enforceIdentity,
  reconcile as reconcileAnswers,
  type ModelAnswer,
  type Reconciliation,
} from "./reconciler";

const STORAGE_KEY = "friday.core-brain.v1";
const MAX_MODEL_STATS = 60;

/** Prompts that can only be answered from the live web, not from a model. */
const WEB_HINTS =
  /\b(search|google|look ?up|latest|news|today'?s|current(?:ly)?|right now|price|weather|release[sd]?|version of|who is|what happened|202[6-9]|this week)\b/i;
/** Questions about FRIDAY's own application, answered from the live map. */
const SELF_HINTS =
  /\b(your|friday'?s|the app|this app)\b.*\b(status|health|version|state|model[s]?|memory|skills|tools|components|installed|running|broken|wiring)\b|\b(what (is|are) (you|your)|self[- ]?check|system map|app map|system wiring|wiring diagram)\b/i;

const EXPLICIT_WEB = /\b(search (the )?web|search online|look this up|find online|browse)\b/i;

/** One turnMark/turnDone pair per cognition stage, plus a TurnTrace detail. */
function clockStage(
  markId: string,
  name: string,
  stage: StageReporter | undefined,
  detail?: string,
): void {
  turnMark(markId, name);
  stage?.("thinking.cognition", detail ?? name);
}

/** Full world/meta/knowledge pass — skipped for simple factual chat. */
const TRIVIAL_TURN =
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|good|great|cool|sure|hmm|namaste|shukriya)[\s.!]*$/i;

export function needsDeepFabric(
  prompt: string,
  understanding: { ambiguous: boolean; understandingConfidence: number },
): boolean {
  if (TRIVIAL_TURN.test(prompt) && !understanding.ambiguous) return false;
  if (understanding.ambiguous || understanding.understandingConfidence < 0.7) return true;
  if (looksLikeSelfStatusQuestion(prompt) || SELF_HINTS.test(prompt) || selfTopic(prompt))
    return true;
  const kind = taskKind(prompt);
  if (kind !== "chat") return true;
  if (EXPLICIT_WEB.test(prompt) || WEB_HINTS.test(prompt)) return true;
  return false;
}

export type BrainToolUse = {
  tool: "web-search" | "skill" | "tool" | "agent" | "module" | "plugin" | "connector" | "workflow";
  query: string;
  ok: boolean;
  detail: string;
};

/** The last turn in plain terms, kept in memory only, for the Brain page. Never written to disk. */
export type LastTurn = {
  at: number;
  prompt: string;
  route: string;
  effort: string;
  models: string[];
  routing: string;
  notes: string[];
  checked: string[];
  issues: string[];
  verified: boolean | null;
  sources: number;
  tools: string[];
};

export type BrainSource = { title: string; url: string; snippet?: string };

export type Cognition = {
  taskId: string;
  prompt: string;
  mode: TurnMode;
  /** Enriched system prompt handed to the selected model(s). */
  system: string;
  modelIds: string[];
  routing: string;
  context: string[];
  tools: BrainToolUse[];
  sources: BrainSource[];
  notes: string[];
  dispatch: TurnDispatch;
  startedAt: number;
  /** Personality toggles that shaped this pass — defaults are all on. */
  useKnowledge: boolean;
  useProjectMemory: boolean;
  autoLearn: boolean;
  understanding?: TurnUnderstanding;
  meta?: MetaReview;
  /** Public reasoning stance only — never a private chain-of-thought dump. */
  reasoning?: { publicNote: string; verified: boolean; groundedness?: number };
  strategy?: ResponseStrategy;
  /** How hard a steerable model should think on this turn (a request, never a promise). */
  reasoningEffort?: ReasoningEffort;
  /**
   * The turn read something live: a tool, skill, connector, web source or a system-context block. Its answer
   * reflects that moment, so it is neither replayed from a saved card nor learned into one.
   */
  liveContext?: boolean;
  /** Kinds of untrusted material the turn read (web, screen, file, connector, document, system). */
  untrustedKinds?: string[];
  /** Where the turn was spoken or typed. verify() reads it: a spoken answer carries no URL. */
  surface?: "voice" | "chat" | "phone";
  /** The cognitive route this turn took (the voice effort cap reads it). */
  routeAction?: CognitiveAction;
  /** Executive pass for this turn. It never executes a side effect. */
  control?: CognitiveCycle;
  /**
   * When FRIDAY already learned this stable ask, the desk should answer
   * from the card and leave the model idle.
   */
  localMind?: LocalMindDecision;
  /** Answer-ledger entry of this turn, settled with the model that really answered. */
  ledgerId?: number;
};

export type Verification = {
  ok: boolean;
  score: number;
  issues: string[];
  detail: string;
};

type ModelStat = { runs: number; ok: number; ms: number };

type CoreBrainState = {
  turns: number;
  verified: number;
  rejected: number;
  searches: number;
  /** `${kind}|${modelId}` → measured outcome, used to bias future routing. */
  models: Record<string, ModelStat>;
  lastAt: number;
};

const EMPTY: CoreBrainState = {
  turns: 0,
  verified: 0,
  rejected: 0,
  searches: 0,
  models: {},
  lastAt: 0,
};

let seq = 0;
const newTaskId = () => `brain-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

/** True only when every model on the route is local; an empty or mixed route is not. */
const routeIsLocal = (ids: string[]): boolean =>
  ids.length > 0 && ids.every((id) => brainModelRegistry.get(id)?.kind === "local");

/** A spoken turn races the vector recall against this and carries on with the lexical hits when it loses. */
export const VOICE_VECTOR_DEADLINE_MS = 250;
/** One shared deadline for the six capability routers of a spoken turn (they run together). */
export const VOICE_ROUTER_DEADLINE_MS = 1500;
/** A spoken turn waits this long for the live web, once, and answers from memory when it is late. */
export const VOICE_WEB_DEADLINE_MS = 2000;

/** The most evidence a spoken turn sends: a slow CPU reads every character before the first word. */
const SPOKEN_EVIDENCE_CHARS = 1500;
const SPOKEN_NOTE_LIMIT = 3;
const SPOKEN_NOTE_CHARS = 160;
/** A note that changes the answer (a failure to name, a thing not to invent), not a trace line. */
const ANSWER_SHAPING_NOTE =
  /failed|say so|not treating as fact|do not |did not ask|use only|contradict|unavailable|not live|nothing|not installed|waits for/i;

const capSpoken = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** At most three short notes that shape the spoken answer; the rest stay on `Cognition.notes`. */
function spokenNotes(notes: string[]): string {
  return notes
    .filter((note) => ANSWER_SHAPING_NOTE.test(note))
    .slice(0, SPOKEN_NOTE_LIMIT)
    .map((note) => `Note: ${capSpoken(note, SPOKEN_NOTE_CHARS)}`)
    .join("\n");
}

/**
 * The six capability routers for a spoken turn. Each starts at once, so they run side by side, and each is bounded
 * by `VOICE_ROUTER_DEADLINE_MS` (a late router adds nothing to this turn and the trace records the timeout). The
 * returned functions have the routers' own shape and hand back the promise that is already running.
 */
function togetherRouters(prompt: string, managed: boolean, runId: string) {
  const bound = <T>(stage: string, work: Promise<T[]>): Promise<T[]> =>
    withDeadline(
      work.catch(() => [] as T[]),
      VOICE_ROUTER_DEADLINE_MS,
      [] as T[],
      { runId, stage },
    );
  const skills = managed ? null : bound("skill-route", routeSkillsRaw(prompt));
  const agents = managed ? null : bound("agent-route", routeAgentsRaw(prompt));
  const tools = bound("tool-route", routeToolsRaw(prompt));
  const modules = bound("module-route", routeModulesRaw(prompt));
  const connectors = bound("connector-route", routeConnectorsRaw(prompt));
  const workflows = bound("workflow-route", routeWorkflowsRaw(prompt));
  return {
    routeSkills: (_prompt: string) => skills ?? routeSkillsRaw(_prompt),
    routeAgents: (_prompt: string) => agents ?? routeAgentsRaw(_prompt),
    routeTools: (_prompt: string) => tools,
    routeModules: (_prompt: string) => modules,
    routeConnectors: (_prompt: string) => connectors,
    routeWorkflows: (_prompt: string) => workflows,
  };
}

/** Coarse task kind — the key the brain learns routing quality against. */
export function taskKind(prompt: string): string {
  if (/\b(code|bug|error|refactor|compile|typescript|python|function)\b/i.test(prompt))
    return "code";
  if (/\b(why|plan|design|compare|analyse|analyze|decide|strategy)\b/i.test(prompt))
    return "reasoning";
  if (WEB_HINTS.test(prompt)) return "research";
  if (/\b(open|run|install|delete|move|shutdown|restart|launch)\b/i.test(prompt)) return "system";
  return "chat";
}

class CoreBrain {
  private state: CoreBrainState = { ...EMPTY, models: {} };
  private loaded = false;
  private last: LastTurn | null = null;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): CoreBrainState => {
    this.load();
    return this.state;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const local = readLocalState<CoreBrainState>(STORAGE_KEY);
    if (local) this.state = { ...EMPTY, ...local, models: local.models ?? {} };
    restoreFromDisk<CoreBrainState>(STORAGE_KEY, (disk) => {
      this.state = { ...EMPTY, ...disk, models: disk.models ?? {} };
      this.emit();
    });
  }

  private emit() {
    this.state = { ...this.state, lastAt: Date.now() };
    writeState(STORAGE_KEY, this.state);
    this.listeners.forEach((fn) => fn());
  }

  /** The last turn as the Brain page shows it, or null before any turn. */
  lastTurn(): LastTurn | null {
    return this.last;
  }

  /** The measured per-task-kind stats of each model (`kind|modelId`), copied. */
  modelStats(): Record<string, { runs: number; ok: number; ms: number }> {
    this.load();
    return { ...this.state.models };
  }

  /** Ordered model preference this brain has measured for a kind of task. */
  preferred(kind: string, ids: string[]): string[] {
    this.load();
    let ledgerId: string | null = null;
    try {
      ledgerId = experiences.preferredModelFor(kind);
    } catch {
      /* ledger optional */
    }
    const score = (id: string) => {
      const stat = this.state.models[`${kind}|${id}`];
      const measured = !stat || stat.runs < 2 ? 0 : stat.ok / stat.runs;
      const fromLedger = ledgerId && id === ledgerId ? 0.08 : 0;
      // What the model kept of the rules of a fixed set of asks (Compare), and how fast it is, count a
      // little. A model with no such record adds nothing, exactly as before.
      const compare = compareOf(id);
      const rules =
        compare && compare.tasks >= MIN_COMPARE_TASKS ? 0.1 * (compare.bare / compare.tasks) : 0;
      const own = Object.entries(this.state.models).filter(([key]) => key.endsWith(`|${id}`));
      const runs = own.reduce((n, [, row]) => n + row.runs, 0);
      const avg = runs >= 2 ? own.reduce((n, [, row]) => n + row.ms * row.runs, 0) / runs : 0;
      const slow = Math.min(0.05, avg / 120_000);
      return measured + fromLedger + rules - slow;
    };
    return [...ids].sort((a, b) => score(b) - score(a));
  }

  /** Does this request need the live web rather than a model's memory? */
  needsWeb(prompt: string): boolean {
    return EXPLICIT_WEB.test(prompt) || WEB_HINTS.test(prompt);
  }

  /**
   * Full cognitive pass for one turn: memory + identity (via the runtime),
   * planning and model routing, then real tool execution when the request
   * needs it. Returns everything the executor needs — it never calls a model.
   */
  async cognize(
    prompt: string,
    options: {
      mode?: TurnMode;
      /** Typed, spoken, or phone. Omitted keeps the mode's existing guide. */
      surface?: "voice" | "chat" | "phone";
      /** False when the desktop turn was already observed. */
      observe?: boolean;
      multiModel?: boolean;
      depth?: number;
      extra?: string;
      /** Models pinned by the owner in the composer — they always win. */
      pinnedModelIds?: string[];
      /** Set false to skip tool routing (used by regression tests). */
      allowTools?: boolean;
      /** Personality → Use knowledge base. Default on. */
      useKnowledge?: boolean;
      /** Personality → Use project memory. Default on. */
      useProjectMemory?: boolean;
      /** Personality → Learn from conversations. Default on. */
      autoLearn?: boolean;
      /** Real FLOW_CHART stage the turn actually entered. */
      onStage?: StageReporter;
      /** Live chat history so cognize can resolve references — same session, not a second store. */
      history?: SessionTurn[];
    } = {},
  ): Promise<Cognition> {
    this.load();
    const mode = options.mode ?? "manual";
    // Same rule as prepareTurn: an explicit surface wins, otherwise Auto mode is the spoken one.
    const spoken = options.surface ? options.surface === "voice" : mode === "auto";
    const useKnowledge = options.useKnowledge !== false;
    const useProjectMemory = options.useProjectMemory !== false;
    const autoLearn = options.autoLearn !== false;
    const kind = taskKind(prompt);
    const tools: BrainToolUse[] = [];
    const sources: BrainSource[] = [];
    const notes: string[] = [];
    let evidence = "";
    /** Kinds of untrusted material this turn read (web, screen, file, connector, document). */
    const untrustedKinds = new Set<string>();
    /** A live system-context block (terminal, logs, tasks, doctor, installer, library, project, browser) fed the turn. */
    let systemContext = false;
    const stage = options.onStage;
    const markId = "cognize";

    turnMark(markId, "understand");
    const understanding = understandTurn({
      text: prompt,
      ...(options.history ? { history: options.history } : {}),
      ...(options.observe === false ? { observe: false } : {}),
    });
    try {
      noteUnderstanding(toUnderstandingTrace(understanding));
    } catch {
      /* tracing must never break a turn */
    }
    turnDone(markId, "understand", understanding.resolvedIntent.kind);
    notes.push(
      `understood as ${understanding.resolvedIntent.kind} (${Math.round(understanding.understandingConfidence * 100)}% understanding)`,
    );
    notes.push(`goal: ${understanding.resolvedGoal.slice(0, 160)}`);
    // A short answer, a cut-short follow-up or a correction is handed over as the full request it means.
    if (understanding.resolvedIntent.rewrittenFrom) {
      notes.push(
        `the owner's words read in full (${understanding.resolvedIntent.rewrittenFrom}): ${understanding.conversationResolved.slice(0, 240)}`,
      );
    }
    const routing = understanding.resolvedIntent.routing;
    if (routing?.novel && prompt.trim().split(/\s+/).length >= 5) {
      notes.push(
        "no known request type matched: read it on its own terms, do not force it into a category",
      );
    }
    if (routing?.recalled) {
      notes.push(
        `he has phrased this before (${routing.recalled.uses}x) and it was understood as ${routing.recalled.catalogId}`,
      );
    }
    const implied = understanding.resolvedIntent.implied;
    if (implied) {
      notes.push(
        `he did not ask, but his words imply it: offer to ${implied.offer} in one line, and wait for his yes; do not do it unasked`,
      );
    }
    const found = understanding.resolvedIntent.slots;
    if (understanding.resolvedIntent.action && found && Object.keys(found).length) {
      notes.push(
        `action ${understanding.resolvedIntent.action}: ${Object.entries(found)
          .map(([name, value]) => `${name}=${value}`)
          .join(", ")}. Use only these; do not invent a missing one.`,
      );
    }
    notes.push(`move: ${understanding.conversationalMove}`);
    const strategy = selectResponseStrategy({
      text: prompt,
      intent: understanding.resolvedIntent,
      move: understanding.conversationalMove,
      ambiguous: understanding.ambiguous,
      confidence: understanding.understandingConfidence,
    });
    notes.push(`strategy: ${strategy.strategy} — ${strategy.reason}`);
    notes.push(strategy.directive);
    const modality = classifyModality({
      prompt,
      mode,
      ...(options.extra ? { extra: options.extra } : {}),
    });
    notes.push(`modality: ${modality.summary}`);
    for (const file of videoFilesIn(`${prompt}\n${options.extra || ""}`)) {
      notes.push(
        `video method for ${file}: ${videoSteps(file)
          .map((step) => step.tool)
          .join(" → ")}`,
      );
    }
    for (const gap of modality.notBuilt) {
      notes.push(`modality not built: ${gap}`);
      try {
        proposeFabricLimitation({
          id: "video-unbounded",
          title: "Unbounded live video watch is not a platform modality",
          rationale: gap,
          evidence: [prompt.slice(0, 160)],
          kind: "research",
          risk: "review",
        });
      } catch {
        /* filing a gap must never break a turn */
      }
    }
    if (modality.wantsScreen) {
      try {
        const screen = await refreshScreenObservation();
        notes.push(`screen observe (read-only): ${screen.summary}`);
        systemContext = true;
      } catch {
        notes.push("screen observe (read-only): unreadable — no pixels captured");
      }
    }
    if (modality.wantsCamera) {
      try {
        const cam = await refreshCameraObservation();
        notes.push(`camera observe (read-only): ${cam.summary}`);
        systemContext = true;
      } catch {
        notes.push("camera observe (read-only): unreadable — no pixels captured");
      }
    }
    if (
      terminalLookRequested(prompt) ||
      terminalLookRequested(options.extra || "") ||
      /\bTERMINAL SESSION\b/.test(options.extra || "")
    ) {
      try {
        const term = observeTerminalState();
        notes.push(`terminal observe (read-only): ${term.summary}`);
        evidence = [evidence, term.extra].filter(Boolean).join("\n\n");
        systemContext = true;
      } catch {
        notes.push("terminal observe (read-only): unreadable — no second shell spawned");
      }
    }
    if (
      logsLookRequested(prompt) ||
      logsLookRequested(options.extra || "") ||
      /\bLOGS SESSION\b/.test(options.extra || "")
    ) {
      try {
        const logs = observeLogsState();
        notes.push(`logs observe (read-only): ${logs.summary}`);
        evidence = [evidence, logs.extra].filter(Boolean).join("\n\n");
        systemContext = true;
      } catch {
        notes.push("logs observe (read-only): unreadable — no second log tail");
      }
    }
    if (
      tasksLookRequested(prompt) ||
      tasksLookRequested(options.extra || "") ||
      /\bTASKS SESSION\b/.test(options.extra || "")
    ) {
      try {
        const tasks = observeTasksState();
        notes.push(`tasks observe (read-only): ${tasks.summary}`);
        evidence = [evidence, tasks.extra].filter(Boolean).join("\n\n");
        systemContext = true;
      } catch {
        notes.push("tasks observe (read-only): unreadable — no second queue");
      }
    }
    if (
      doctorLookRequested(prompt) ||
      doctorLookRequested(options.extra || "") ||
      /\bDOCTOR SESSION\b/.test(options.extra || "")
    ) {
      try {
        const doctorLive = observeDoctorState();
        notes.push(`doctor observe (read-only): ${doctorLive.summary}`);
        evidence = [evidence, doctorLive.extra].filter(Boolean).join("\n\n");
        systemContext = true;
      } catch {
        notes.push("doctor observe (read-only): unreadable — no second probe");
      }
    }
    if (
      installerLookRequested(prompt) ||
      installerLookRequested(options.extra || "") ||
      /\bINSTALL SESSION\b/.test(options.extra || "")
    ) {
      try {
        const installerLive = observeInstallerState();
        notes.push(`installer observe (read-only): ${installerLive.summary}`);
        evidence = [evidence, installerLive.extra].filter(Boolean).join("\n\n");
        systemContext = true;
      } catch {
        notes.push("installer observe (read-only): unreadable — no second installer");
      }
    }
    if (
      libraryLookRequested(prompt) ||
      libraryLookRequested(options.extra || "") ||
      /\bLIBRARY SESSION\b/.test(options.extra || "")
    ) {
      try {
        const libraryLive = observeLibraryState();
        notes.push(`library observe (read-only): ${libraryLive.summary}`);
        evidence = [evidence, libraryLive.extra].filter(Boolean).join("\n\n");
        systemContext = true;
      } catch {
        notes.push("library observe (read-only): unreadable — no second file store");
      }
    }
    if (
      projectLookRequested(prompt) ||
      projectLookRequested(options.extra || "") ||
      /\bPROJECT WORKSPACE SESSION\b/.test(options.extra || "")
    ) {
      try {
        const projectLive = observeProjectWorkspaceState();
        notes.push(`project workspace observe (read-only): ${projectLive.summary}`);
        evidence = [evidence, projectLive.extra].filter(Boolean).join("\n\n");
        systemContext = true;
      } catch {
        notes.push("project workspace observe (read-only): unreadable — no second project store");
      }
    }
    if (
      browserLookRequested(prompt) ||
      browserLookRequested(options.extra || "") ||
      /\bBROWSER SESSION\b/.test(options.extra || "")
    ) {
      try {
        const browserLive = observeBrowserState();
        notes.push(`browser observe (read-only): ${browserLive.summary}`);
        evidence = [evidence, browserLive.extra].filter(Boolean).join("\n\n");
        systemContext = true;
      } catch {
        notes.push("browser observe (read-only): unreadable — no second Chromium");
      }
    }
    const sessionNote = conversationDigest();
    if (sessionNote) notes.push(`session: ${sessionNote}`);
    const loopsNote = openLoopDigest();
    if (loopsNote) notes.push(`open loops: ${loopsNote}`);
    if (understanding.ambiguous) {
      notes.push("ambiguous or missing information — clarifying is owned by the existing ask path");
    }

    const classified = classifyCognitiveRoute({
      prompt,
      kind,
      ambiguous: understanding.ambiguous,
      understandingConfidence: understanding.understandingConfidence,
    });
    notes.push(`cognitive: ${classified.klass} → ${classified.action} (${classified.reason})`);
    let deep = needsDeepFabric(prompt, understanding);
    if (classified.action === "fast-path") deep = false;
    if (
      classified.action === "deep-reasoning" ||
      classified.action === "multi-verify" ||
      classified.action === "research"
    ) {
      deep = true;
    }
    if (modality.needsDeep) deep = true;
    const depthPlan = planCognitiveDepth({
      prompt,
      kind,
      route: classified,
      confidence: understanding.understandingConfidence,
      ambiguous: understanding.ambiguous,
    });
    if (depthPlan.forceDeep && classified.action !== "fast-path") deep = true;
    notes.push(`executive: ${depthPlan.depth} / ${depthPlan.mode} — ${depthPlan.reason}`);
    notes.push(
      deep
        ? "fabric: deep — Understand → Recall → Knowledge → Freshness → World → Goal → Reason → Assumptions → Confidence → Research/Verify if needed → Plan → Route"
        : "fabric: light — understand + knowledge + route (simple chat; skipped world/meta/reasoning)",
    );

    let meta: MetaReview | undefined;
    let reasoning: ReasoningTrace | undefined;
    let worldSummary = "";
    let worldPrelude = false;

    const runWorldPrelude = () => {
      if (worldPrelude) return;
      worldPrelude = true;
      try {
        installCognitiveBaseline();
      } catch {
        /* baseline seed must never break a turn */
      }
      clockStage(markId, "world-insight", stage, "world-insight");
      if (stageOff("world-insight")) {
        notes.push("world state: switched off for a measurement");
        turnDone(markId, "world-insight", "off");
      } else
        try {
          const world = readWorldInsight();
          worldSummary = world.snapshot.summary;
          notes.push(`world state: ${world.snapshot.summary}`);
          if (world.unknown.length) {
            notes.push(`world unknown: ${world.unknown.slice(0, 3).join("; ")}`);
          }
          if (world.expected.length) {
            notes.push(`world expected: ${world.expected[0]}`);
          }
          if (world.atRisk.length) {
            notes.push(`world at-risk: ${world.atRisk[0]}`);
          }
          if (world.likelyNext.length) {
            notes.push(`world likely-next: ${world.likelyNext[0]}`);
          }
          turnDone(markId, "world-insight", world.snapshot.summary.slice(0, 80));
        } catch {
          notes.push("world state: unreadable");
          turnDone(markId, "world-insight", "unreadable");
        }

      clockStage(markId, "meta-review", stage, "meta-review");
      if (stageOff("meta-review")) {
        notes.push("meta: switched off for a measurement");
        turnDone(markId, "meta-review", "off");
      } else
        try {
          meta = reviewAssumptions({ text: prompt, intent: understanding.resolvedIntent });
          notes.push(`meta: ${meta.action} — ${meta.reason}`);
          turnDone(markId, "meta-review", meta.action);
        } catch {
          notes.push("meta: unreadable");
          turnDone(markId, "meta-review", "unreadable");
        }
    };

    if (deep) runWorldPrelude();

    clockStage(markId, "vector-index", stage, "vector-index");
    let recalled: ReturnType<typeof brainKnowledge.recall> = [];
    let vectorHits: { title: string; snippet: string; score: number }[] = [];
    try {
      if (stageOff("vector-index")) throw new Error("switched off for a measurement");
      // Spoken: the judge and rerank are skipped and the whole recall is raced against a short timer; a slow
      // kernel means the lexical hits answer this turn and the vector hits are simply absent.
      vectorHits = spoken
        ? await withDeadline(
            vectorIndex.queryHits(prompt, 8, "none"),
            VOICE_VECTOR_DEADLINE_MS,
            [] as typeof vectorHits,
            { runId: markId, stage: "vector-index" },
          )
        : await vectorIndex.queryHits(prompt, 8);
      if (vectorHits.length) notes.push(`vector index: ${vectorHits.length} hit(s)`);
      turnDone(markId, "vector-index", `${vectorHits.length} hit(s)`);
    } catch {
      turnDone(markId, "vector-index", "skipped");
    }
    clockStage(markId, "knowledge-recall", stage, "knowledge-recall");
    if (!useKnowledge || stageOff("knowledge-recall")) {
      notes.push(
        stageOff("knowledge-recall")
          ? "knowledge: switched off for a measurement"
          : "knowledge: skipped (useKnowledge off)",
      );
    } else {
      try {
        recalled = brainKnowledge.recall(prompt, {
          k: 3,
          ...(vectorHits.length ? { vectorHits } : {}),
        });
      } catch {
        recalled = [];
      }
      if (!useProjectMemory) {
        recalled = recalled.filter((entry) => entry.kind !== "project");
      }
    }
    const retrievalGrade = gradeRetrieval(
      recalled.map((entry) => ({ score: Math.max(0.2, entry.confidence) })),
    ).grade;
    notes.push(`retrieval grade: ${retrievalGrade}`);
    const memoryConflict = recalled.some((entry) => entry.contradiction);
    if (memoryConflict && classified.action !== "fast-path" && !worldPrelude) {
      deep = true;
      notes.push("executive: stored contradiction — deepen this turn");
      runWorldPrelude();
    }
    const projectBoundTurn =
      projectLookRequested(prompt) ||
      projectLookRequested(options.extra || "") ||
      /\bPROJECT WORKSPACE SESSION\b/.test(options.extra || "");
    const projectIdForTurn = projectBoundTurn ? projectWorkspaces.activeId() : null;
    try {
      if (stageOff("memory-retrieve")) throw new Error("switched off for a measurement");
      let remembered = memory.retrieve(prompt, 8, {
        ...(vectorHits.length ? { vectorHits } : {}),
        ...(useProjectMemory && projectIdForTurn ? { projectId: projectIdForTurn } : {}),
      });
      if (!useProjectMemory) {
        remembered = remembered.filter(
          (hit) =>
            hit.item.scope !== "project" && hit.item.kind !== "project" && !hit.item.projectId,
        );
        notes.push("project memory: skipped (useProjectMemory off)");
      } else {
        remembered = remembered.filter(
          (hit) => filterMemoriesForProject([hit.item], projectIdForTurn).length > 0,
        );
      }
      const reflections = remembered.filter((hit) => hit.item.tags.includes("reflection"));
      const past = pastEvidence(prompt);
      if (past) {
        notes.push(`memory as of ${past.label}: ${past.lines.length} record(s)`);
        evidence = [
          evidence,
          `From stored memory as it was ${past.label} (a question about the past, not guessed):\n` +
            past.lines.map((row) => `- ${row}`).join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      if (remembered.length) {
        notes.push(`memory retrieve: ${remembered.length} hit(s)`);
        // The owner's own rows go in as memory. A row somebody else wrote (an imported document, a web page, a
        // tool result) goes in as delimited quoted data that cannot be read as an instruction.
        const ownRows = remembered.filter((hit) => !isNonOwnerRow(hit.item));
        const otherRows = remembered.filter((hit) => isNonOwnerRow(hit.item));
        evidence = [
          evidence,
          ownRows.length
            ? "From stored memory (hybrid retrieve, not guessed):\n" +
              ownRows
                .map(
                  (hit) =>
                    `- [${hit.item.tier}] ${hit.item.title} (${hit.item.source}): ${hit.item.text.slice(0, 280)}`,
                )
                .join("\n")
            : "",
          quotedDataBlock(
            otherRows.map((hit) => ({
              label: `[${hit.item.tier}] ${hit.item.title} (${hit.item.source})`,
              text: hit.item.text,
              // An imported document chunk keeps the longer window it always had.
              ...(String(hit.item.source).startsWith("library:") ? { max: 800 } : {}),
            })),
          ),
        ]
          .filter(Boolean)
          .join("\n\n");
        if (otherRows.length) {
          untrustedKinds.add("document");
          notes.push(`memory: ${otherRows.length} row(s) from outside sources quoted as data`);
        }
      }
      if (reflections.length) {
        notes.push(`reflexion: ${reflections.length} prior failure note(s)`);
      }
    } catch {
      /* memory retrieve is additive */
    }
    turnDone(markId, "knowledge-recall", `${recalled.length} hit(s)`);
    clockStage(markId, "knowledge-graph", stage, "knowledge-graph");
    let hopLabels: string[] = [];
    if (!useKnowledge) {
      turnDone(markId, "knowledge-graph", "skipped");
    } else {
      try {
        const hops = walkOpsChain("FRIDAY");
        hopLabels = hops.map((hop) => `${hop.from} ${hop.predicate} ${hop.to}`);
        if (hops.length) {
          notes.push(`knowledge graph: FRIDAY → ${hops.map((hop) => hop.to).join(" → ")}`);
        }
      } catch {
        /* graph queries must never break a turn */
      }
      try {
        const nearby = localNeighborhood(prompt);
        if (nearby.length) {
          notes.push(
            `knowledge neighborhood: ${nearby
              .slice(0, 4)
              .map((hop) => `${hop.from} ${hop.predicate} ${hop.to}`)
              .join("; ")}`,
          );
          hopLabels = [
            ...new Set([
              ...hopLabels,
              ...nearby.map((hop) => `${hop.from} ${hop.predicate} ${hop.to}`),
            ]),
          ];
        }
      } catch {
        /* local search is additive */
      }
      try {
        const inferred = inferMultiHop(prompt);
        if (inferred) {
          notes.push(`knowledge multi-hop: ${inferred.note}`);
          hopLabels = [
            ...new Set([
              ...hopLabels,
              ...inferred.hops.map((hop) => `${hop.from} ${hop.predicate} ${hop.to}`),
            ]),
          ];
        }
      } catch {
        /* composed path is additive */
      }
      turnDone(markId, "knowledge-graph", `${hopLabels.length} hop(s)`);
      try {
        const status = brainKnowledge.queryStatus(prompt);
        notes.push(`knowledge status: ${status.status} (${status.reason})`);
      } catch {
        /* status is additive */
      }
    }
    try {
      const whatIf = whatIfFromPrompt(prompt);
      if (whatIf) {
        notes.push(
          `ops what-if: ${whatIf.asked} → ${whatIf.outcome}` +
            (whatIf.inconclusive ? " (inconclusive)" : ""),
        );
      }
    } catch {
      /* what-if must never break a turn */
    }
    if (recalled.length) {
      const stale = recalled.filter((entry) => {
        const age = Date.now() - (entry.freshnessAt ?? entry.updatedAt);
        return age > 14 * 86_400_000;
      });
      notes.push(
        `freshness: ${stale.length} of ${recalled.length} recalled knowledge item(s) older than 14 days`,
      );
      evidence = [
        evidence,
        "From stored knowledge (real Brain entries, not guessed):\n" +
          recalled
            .map((entry) => {
              const evidenceLine = brainKnowledge.evidenceLine(entry);
              const flag = entry.contradiction ? "; unresolved contradiction" : "";
              return `- [${entry.kind}] ${entry.title}: ${entry.body.slice(0, 400)} (${evidenceLine}${flag})`;
            })
            .join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n");
      notes.push(`recalled ${recalled.length} stored knowledge record(s)`);
    } else {
      notes.push("freshness: no knowledge hits to age-check");
    }

    if (deep) {
      clockStage(markId, "reason", stage, "reason");
      try {
        reasoning = reasonAbout({
          prompt,
          evidence,
          worldSummary,
          ...(meta ? { metaAction: meta.action } : {}),
          knowledgeHops: hopLabels,
          contradictions: recalled
            .filter((entry) => entry.contradiction)
            .map((entry) => entry.body),
        });
        notes.push(reasoning.publicNote);
        if (reasoning.subproblems.length > 1) {
          notes.push(
            `reasoning subproblems: ${reasoning.subproblems.length} (least-to-most gather)`,
          );
        }
        if (reasoning.consistency === "split") {
          notes.push("reasoning consistency: split — prefer uncertainty over a forced fact");
        }
        if (reasoning.alternatives[0]) {
          notes.push(`reasoning alternatives: ${reasoning.alternatives[0]}`);
        }
        if (reasoning.contradictions[0]) {
          notes.push(`reasoning contradiction: ${reasoning.contradictions[0]}`);
        }
        turnDone(markId, "reason", reasoning.publicNote.slice(0, 80));
      } catch {
        notes.push("reasoning: unreadable");
        turnDone(markId, "reason", "unreadable");
      }
    }

    if (
      (options.allowTools ?? true) &&
      (this.needsWeb(prompt) || meta?.action === "research" || classified.action === "research")
    ) {
      let knowledgeStatus = "";
      try {
        knowledgeStatus = brainKnowledge.queryStatus(prompt).status;
      } catch {
        /* optional */
      }
      const live = looksLikeLiveFact(prompt) || this.needsWeb(prompt);
      if (
        !live &&
        !shouldResearch({
          status: knowledgeStatus,
          liveFact: false,
          knowledgeAsk: looksLikeKnowledgeAsk(prompt),
          retrievalGrade,
        })
      ) {
        notes.push("research skipped — Self-RAG: stored knowledge is usable");
      } else {
        const queries = formulateQueries(prompt);
        const query =
          queries[0] ?? prompt.replace(/^\s*(search|google|look ?up)\s+/i, "").slice(0, 200);
        stage?.("thinking.cognition", `web search: ${query}`);
        turnMark(markId, "web-search");
        if (!browserAvailable()) {
          notes.push("web search unavailable in this build — answering from memory only");
          turnDone(markId, "web-search", "unavailable");
        } else {
          try {
            // Spoken: one search, bounded; a late or empty result means the answer comes from memory.
            let response = spoken
              ? await withDeadline(
                  webSearch(query, 6),
                  VOICE_WEB_DEADLINE_MS,
                  {
                    ok: false,
                    query,
                    results: [],
                    error: `web search timed out after ${VOICE_WEB_DEADLINE_MS / 1000}s — answering without live results`,
                  },
                  { runId: markId, stage: "web-search" },
                )
              : await webSearch(query, 6);
            if (!spoken && response.ok && !response.results.length && queries[1]) {
              notes.push("research: first query empty — one expanded retry");
              response = await webSearch(queries[1], 6);
            }
            turnDone(
              markId,
              "web-search",
              response.ok ? `${response.results.length} result(s)` : (response.error ?? "failed"),
            );
            if (response.ok && response.results.length) {
              const ranked = rankSources(response.results);
              const judged = evaluateSources(ranked, prompt);
              notes.push(`web grade: ${judged.grade} (${judged.reason})`);
              if (judged.grade === "incorrect" || !judged.usable.length) {
                notes.push("CRAG: web hits too weak — not treating as fact");
                tools.push({
                  tool: "web-search",
                  query,
                  ok: true,
                  detail: "results discarded as too weak",
                });
              } else {
                judged.usable.slice(0, 6).forEach((result) => {
                  sources.push({
                    title: result.title,
                    url: result.url,
                    ...(result.snippet ? { snippet: result.snippet } : {}),
                  });
                });
                evidence = researchNote(judged.usable);
                tools.push({
                  tool: "web-search",
                  query,
                  ok: true,
                  detail: `${judged.usable.length} usable result(s)`,
                });
                this.state.searches += 1;
                try {
                  ingestKnowledge({
                    text: judged.usable.map((row) => `${row.title} ${row.snippet}`).join("\n"),
                    source: "web-search",
                    kind: "web",
                  });
                } catch {
                  /* ingest is best-effort */
                }
              }
            } else {
              tools.push({
                tool: "web-search",
                query,
                ok: false,
                detail: response.error ?? "no results",
              });
              notes.push("web search returned nothing — say so instead of guessing");
            }
          } catch (error) {
            turnDone(markId, "web-search", String(error));
            tools.push({ tool: "web-search", query, ok: false, detail: String(error) });
            notes.push("web search failed — answer from what is known and say the search failed");
          }
        }
      }
    }

    // Installed skills are part of the turn, not a separate panel: when the
    // request clearly maps to one of the owner's safe skills, it is executed
    // for real and its actual output becomes the basis of the answer.
    if (options.allowTools ?? true) {
      // Managing skills by chat ("what skills do you have", "disable the secret scan skill") is answered from
      // what actually happened; changes go through the owner's approval gate. Such a turn runs no skill or agent.
      stage?.("agents.skills", "checking for a skill management request");
      // Plugins are managed the same way ("what did my plugins notice", "turn off the break reminder plugin").
      const managed =
        (await managePluginsFromPrompt(prompt)) ?? (await manageSkillsFromPrompt(prompt));
      if (managed) {
        tools.push({
          tool: "skill",
          query: managed.kind,
          ok: managed.ok,
          detail: managed.text.slice(0, 160),
        });
        evidence = [
          evidence,
          `Result of the skill management you just did on this machine. Answer from it, in your own words, and say plainly if a change is only waiting for approval:\n${managed.text}`,
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      // Typed: each router runs when its turn comes, as before. Spoken: all six start now, together, and share
      // one deadline, so a slow or hung router costs the deadline once and not six times over.
      const {
        routeSkills,
        routeAgents,
        routeTools,
        routeModules,
        routeConnectors,
        routeWorkflows,
      } = spoken
        ? togetherRouters(prompt, managed !== null && managed !== undefined, markId)
        : {
            routeSkills: routeSkillsRaw,
            routeAgents: routeAgentsRaw,
            routeTools: routeToolsRaw,
            routeModules: routeModulesRaw,
            routeConnectors: routeConnectorsRaw,
            routeWorkflows: routeWorkflowsRaw,
          };
      stage?.("agents.skills", "matching installed skills");
      turnMark(markId, "skill-route");
      const skillRuns = managed ? [] : await routeSkills(prompt).catch(() => []);
      turnDone(
        markId,
        "skill-route",
        skillRuns.length
          ? skillRuns.map((run) => `${run.name} ${run.ok ? "ok" : "failed"}`).join(", ")
          : "none",
      );
      if (skillRuns.length) {
        for (const skill of skillRuns) {
          dispatchPluginHook("on-skill-run", {
            skillId: skill.id,
            name: skill.name,
            ok: skill.ok,
            detail: skill.detail,
          });
          stage?.("execution.runners", `${skill.name} — ${skill.detail}`);
          tools.push({
            tool: "skill",
            query: skill.name,
            ok: skill.ok,
            detail: skill.detail,
          });
          if (skill.ok) {
            evidence = [
              evidence,
              `Output of your own "${skill.name}" skill, which you just ran on this machine. Answer from it:\n${describeSkillValue(skill.value)}`,
            ]
              .filter(Boolean)
              .join("\n\n");
          } else {
            notes.push(
              `the "${skill.name}" skill failed (${skill.detail}) — say so instead of pretending it ran`,
            );
          }
        }
      }

      turnMark(markId, "agent-route");
      stage?.("agents.registry", "matching installed agents");
      const agentRuns = managed ? [] : await routeAgents(prompt).catch(() => []);
      turnDone(
        markId,
        "agent-route",
        agentRuns.length
          ? agentRuns
              .map((run) => `${run.name} ${run.ok ? "ok" : run.skipped ? "skipped" : "failed"}`)
              .join(", ")
          : "none",
      );
      if (agentRuns.length) {
        noteObserve({ tool: agentRuns[agentRuns.length - 1]!.id });
        for (const agent of agentRuns) {
          stage?.("execution.runners", `${agent.name} — ${agent.detail}`);
          if (agent.skipped) {
            // A role agent with nothing installed matched a word in the prompt
            // ("voice", "code"). It is not a tool call and not a failure. Only
            // an explicit ask for an agent is told so; otherwise the model
            // reads it as the feature being broken.
            if (/\bagents?\b/i.test(prompt)) {
              notes.push(
                `the "${agent.name}" agent has nothing installed to run here — say that plainly; it is not a fault in the feature it is named after`,
              );
            }
            continue;
          }
          tools.push({
            tool: "agent",
            query: agent.name,
            ok: agent.ok,
            detail: agent.detail,
          });
          if (agent.ok) {
            evidence = [
              evidence,
              `Output of your own "${agent.name}" agent, which you just ran on this machine. Answer from it:\n${describeAgentValue(agent.value)}`,
            ]
              .filter(Boolean)
              .join("\n\n");
          } else {
            notes.push(
              `the "${agent.name}" agent failed (${agent.detail}) — say so instead of pretending it ran`,
            );
          }
        }
      }

      turnMark(markId, "tool-route");
      stage?.("agents.tools", "matching installed tools");
      const toolRuns = await routeTools(prompt).catch(() => []);
      turnDone(
        markId,
        "tool-route",
        toolRuns.length
          ? toolRuns.map((run) => `${run.name} ${run.ok ? "ok" : "failed"}`).join(", ")
          : "none",
      );
      if (toolRuns.length) {
        noteObserve({ tool: toolRuns[toolRuns.length - 1]!.id });
        for (const tool of toolRuns) {
          stage?.("execution.runners", `${tool.name} — ${tool.detail}`);
          tools.push({
            tool: "tool",
            query: tool.name,
            ok: tool.ok,
            detail: tool.detail,
          });
          if (tool.ok) {
            evidence = [
              evidence,
              `Output of your own "${tool.name}" tool, which you just ran on this machine. Answer from it:\n${describeToolValue(tool.value)}`,
            ]
              .filter(Boolean)
              .join("\n\n");
          } else {
            notes.push(
              `the "${tool.name}" tool failed (${tool.detail}) — say so instead of pretending it ran`,
            );
          }
        }
      }

      turnMark(markId, "module-route");
      stage?.("agents.modules", "matching installed modules");
      const moduleRuns = await routeModules(prompt).catch(() => []);
      turnDone(
        markId,
        "module-route",
        moduleRuns.length
          ? moduleRuns.map((run) => `${run.name} ${run.ok ? "ok" : "failed"}`).join(", ")
          : "none",
      );
      if (moduleRuns.length) {
        noteObserve({ tool: moduleRuns[moduleRuns.length - 1]!.id });
        for (const pack of moduleRuns) {
          stage?.("execution.runners", `${pack.name} — ${pack.detail}`);
          tools.push({
            tool: "module",
            query: pack.name,
            ok: pack.ok,
            detail: pack.detail,
          });
          if (pack.ok) {
            evidence = [
              evidence,
              `Output of your own "${pack.name}" module, which you just ran on this machine. Answer from it:\n${describeModuleValue(pack.value)}`,
            ]
              .filter(Boolean)
              .join("\n\n");
          } else {
            notes.push(
              `the "${pack.name}" module failed (${pack.detail}) — say so instead of pretending it ran`,
            );
          }
        }
      }

      turnMark(markId, "connector-route");
      stage?.("agents.connectors", "matching connected services");
      const connectorRuns = await routeConnectors(prompt).catch(() => []);
      turnDone(
        markId,
        "connector-route",
        connectorRuns.length
          ? connectorRuns.map((run) => `${run.name} ${run.ok ? "ok" : "failed"}`).join(", ")
          : "none",
      );
      if (connectorRuns.length) {
        noteObserve({ tool: connectorRuns[connectorRuns.length - 1]!.id });
        for (const connector of connectorRuns) {
          stage?.("execution.runners", `${connector.name} — ${connector.detail}`);
          tools.push({
            tool: "connector",
            query: connector.name,
            ok: connector.ok,
            detail: connector.detail,
          });
          if (connector.ok) {
            evidence = [
              evidence,
              `Output of your own "${connector.name}" connector, which you just ran on this machine. Answer from it:\n${describeConnectorValue(connector.value)}`,
            ]
              .filter(Boolean)
              .join("\n\n");
          } else {
            notes.push(
              `the "${connector.name}" connector failed (${connector.detail}) — say so instead of pretending it ran`,
            );
          }
        }
      }

      turnMark(markId, "workflow-route");
      stage?.("agents.workflows", "matching installed workflows");
      const workflowRuns = await routeWorkflows(prompt).catch(() => []);
      turnDone(
        markId,
        "workflow-route",
        workflowRuns.length
          ? workflowRuns.map((run) => `${run.name} ${run.ok ? "ok" : "failed"}`).join(", ")
          : "none",
      );
      if (workflowRuns.length) {
        noteObserve({ tool: workflowRuns[workflowRuns.length - 1]!.id });
        for (const flow of workflowRuns) {
          stage?.("execution.runners", `${flow.name} — ${flow.detail}`);
          tools.push({
            tool: "workflow",
            query: flow.name,
            ok: flow.ok,
            detail: flow.detail,
          });
          if (flow.ok) {
            evidence = [
              evidence,
              `Output of your own "${flow.name}" workflow, which you just ran on this machine. Answer from it:\n${describeWorkflowValue(flow.value)}`,
            ]
              .filter(Boolean)
              .join("\n\n");
          } else {
            notes.push(
              `the "${flow.name}" workflow failed (${flow.detail}) — say so instead of pretending it ran`,
            );
          }
        }
      }

      if (
        !skillRuns.length &&
        !agentRuns.length &&
        !toolRuns.length &&
        !moduleRuns.length &&
        !connectorRuns.length &&
        !workflowRuns.length
      ) {
        if (looksLikeAgentGap(prompt)) {
          const draft = fileAgentGapDraft(prompt);
          notes.push(
            `no matching agent — filed agent-forge draft ${draft.id}; install waits for your approval`,
          );
          tools.push({
            tool: "agent",
            query: "agent-forge",
            ok: false,
            detail: `draft ${draft.id} (${draft.stage}) — not installed`,
          });
        } else if (looksLikeModuleGap(prompt)) {
          const draft = fileModuleGapDraft(prompt);
          notes.push(
            `no matching module — filed module-forge draft ${draft.id}; install waits for your approval`,
          );
          tools.push({
            tool: "module",
            query: "module-forge",
            ok: false,
            detail: `draft ${draft.id} (${draft.stage}) — not installed`,
          });
        } else if (looksLikePluginGap(prompt)) {
          const draft = filePluginGapDraft(prompt);
          notes.push(
            `no matching plugin — filed plugin-forge draft ${draft.id}; install waits for your approval`,
          );
          tools.push({
            tool: "plugin",
            query: "plugin-forge",
            ok: false,
            detail: `draft ${draft.id} (${draft.stage}) — not installed`,
          });
        } else if (looksLikeWorkflowGap(prompt)) {
          const draft = fileWorkflowGapDraft(prompt);
          notes.push(
            `no matching workflow — filed workflow-forge draft ${draft.id}; install waits for your approval`,
          );
          tools.push({
            tool: "workflow",
            query: "workflow-forge",
            ok: false,
            detail: `draft ${draft.id} (${draft.stage}) — not installed`,
          });
        } else if (looksLikeCapabilityGap(prompt)) {
          const draft = fileSkillGapDraft(prompt);
          notes.push(
            `no matching skill — filed skill-forge draft ${draft.id}; install waits for your approval`,
          );
          tools.push({
            tool: "skill",
            query: "skill-forge",
            ok: false,
            detail: `draft ${draft.id} (${draft.stage}) — not installed`,
          });
        }
      }
    }

    // Self-knowledge: when the question is about FRIDAY's own application,
    // capabilities, features, UI, or current working status, hand the model
    // the live registries instead of letting it guess.
    if (SELF_HINTS.test(prompt) || looksLikeSelfStatusQuestion(prompt) || selfTopic(prompt)) {
      const topic = selfTopic(prompt);
      const direct = topic ? answerSelf(topic, prompt) : null;
      // What the owner's plugins noticed (warnings only) is part of FRIDAY's own status.
      const noticed = await pluginWarnings().catch(() => "");
      const facts = [
        describeLiveSelf(prompt),
        direct && "text" in direct ? direct.text : "",
        noticed,
      ]
        .filter((part) => part.trim())
        .join("\n\n");
      if (facts.trim()) {
        notes.push("answer from the live registries below, not from assumptions");
        evidence = [evidence, `FRIDAY live registries:\n${facts}`].filter(Boolean).join("\n\n");
      }
    }

    let control: CognitiveCycle | undefined;
    let liveContext = false;
    if (sources.length) untrustedKinds.add("web");
    for (const used of tools) {
      if (used.tool === "connector" || used.tool === "web-search") untrustedKinds.add(used.tool);
    }
    if (systemContext) untrustedKinds.add("system");
    if (/Untrusted screen data/i.test(options.extra ?? "")) untrustedKinds.add("screen");
    if (/^FILE: |The owner attached \d+ file/m.test(options.extra ?? ""))
      untrustedKinds.add("file");
    try {
      const consequential = classified.klass === "high-stakes";
      const contradicted = memoryConflict || Boolean(reasoning?.contradictions.length);
      const claims = recalled.map((entry) => ({
        key: (entry.title || entry.kind).slice(0, 80),
        value: entry.body.slice(0, 180),
        source: entry.source || "knowledge",
        at: entry.freshnessAt ?? entry.updatedAt,
        confidence: entry.confidence,
        stale: Date.now() - (entry.freshnessAt ?? entry.updatedAt) > 14 * 86_400_000,
        provenance: entry.provenance,
      }));
      for (const entry of recalled) {
        if (!entry.contradiction) continue;
        claims.push({
          key: (entry.title || entry.kind).slice(0, 80),
          value: `conflicting record ${entry.contradictedBy?.join(",") || "unresolved"}`,
          source: "knowledge-contradiction",
          at: entry.updatedAt,
          confidence: Math.min(entry.confidence, 0.5),
          stale: false,
          provenance: "observed" as const,
        });
      }
      const drafts: {
        id: string;
        role: "goal" | "fact" | "safety" | "failure";
        text: string;
        source: string;
        at: string;
        confidence: number;
        conflict?: boolean;
      }[] = [];
      if (understanding.resolvedGoal) {
        drafts.push({
          id: "goal",
          role: "goal",
          text: understanding.resolvedGoal.slice(0, 240),
          source: "intent-engine",
          at: new Date().toISOString(),
          confidence: understanding.understandingConfidence,
        });
      }
      // The quoted-data block stays whole, as quoted data: it is never re-listed line by line as a "fact".
      const evidenceLines = evidence
        .replace(/Quoted data from imported[\s\S]*?QUOTED DATA>>>/g, "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 12)
        .slice(0, 8);
      evidenceLines.forEach((line, index) => {
        drafts.push({
          id: `fact-${index}`,
          role: "fact",
          text: line.slice(0, 400),
          source: "turn-evidence",
          at: new Date().toISOString(),
          confidence: 0.6,
          conflict: /contradict/i.test(line),
        });
      });
      if (consequential) {
        drafts.push({
          id: "safety",
          role: "safety",
          text: "This can change the machine. Cognition hands it to authority and does not execute it.",
          source: "action-risk",
          at: new Date().toISOString(),
          confidence: 1,
        });
      }
      const toolFailed = tools.some((tool) => !tool.ok);
      if (toolFailed) {
        drafts.push({
          id: "failure",
          role: "failure",
          text: "A tool on this turn failed. The answer has to name that failure.",
          source: "tool-route",
          at: new Date().toISOString(),
          confidence: 0.9,
        });
      }
      const liveFact = this.needsWeb(prompt) || classified.action === "research";
      control = finishCognitiveCycle({
        prompt,
        plan: depthPlan,
        route: classified,
        goal: understanding.resolvedGoal,
        strategy: strategy.strategy,
        confidence: understanding.understandingConfidence,
        ambiguous: understanding.ambiguous,
        consequential,
        contradicted,
        toolFailed,
        liveFact,
        liveSources: sources.length,
        hasEvidence: sources.length > 0 || recalled.length > 0,
        paused: strategy.strategy === "defer",
        claims,
        drafts,
      });
      liveContext = tools.length > 0 || sources.length > 0 || systemContext;
      notes.push(`cognitive control: ${control.publicNote}`);
      notes.push(`runtime: ${control.runtime.state} (${control.runtime.outcome})`);
      if (control.mind.line) notes.push(`mind: ${control.mind.line}`);
      if (control.context.included.length) {
        const packet = control.context.included
          .map((item) => `- [${item.role}] ${item.text} (${item.reason})`)
          .join("\n");
        evidence = [`Cognitive context packet:\n${packet}`, evidence].filter(Boolean).join("\n\n");
      }
    } catch {
      notes.push("cognitive control: unreadable");
    }

    const extraParts = spoken
      ? // Spoken: the caller's stable lines, the identity directive, then only the evidence and the few notes
        // that change the answer. The full trace stays in `Cognition.notes` for the owner, not in the prompt.
        ([
          options.extra,
          IDENTITY_DIRECTIVE,
          capSpoken(evidence, SPOKEN_EVIDENCE_CHARS),
          spokenNotes(notes),
        ].filter(Boolean) as string[])
      : ([options.extra, evidence].filter(Boolean) as string[]);
    if (!spoken) {
      if (notes.length) extraParts.push(notes.map((n) => `Note: ${n}`).join("\n"));
      extraParts.push(IDENTITY_DIRECTIVE);
    }

    turnMark(markId, "prepareTurn");
    stage?.("thinking.prepare", "context + routing");
    const prepared = prepareTurn(prompt, {
      mode,
      ...(options.surface ? { surface: options.surface } : {}),
      // Owner setting still wins for ordinary turns. High-stakes always
      // fans out (multi-model + later verify) without changing prepareTurn's
      // default for other routes.
      multiModel: classified.action === "multi-verify" ? true : (options.multiModel ?? true),
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
      extra: extraParts.join("\n\n"),
      ...(stage ? { onStage: stage } : {}),
      ...(vectorHits.length ? { vectorHits } : {}),
    });
    const dispatch = await refineTurnWithDispatchRole(prompt, prepared, {
      ...(stage ? { onStage: stage } : {}),
    });
    turnDone(markId, "prepareTurn", dispatch.routing);
    if (dispatch.quotedRows) untrustedKinds.add("document");

    // Even an owner-pinned model has to satisfy the usage policy: under
    // "free only" a paid model is never dispatched, whoever selected it.
    const pinned = allowedModelIds((options.pinnedModelIds ?? []).filter(Boolean));
    const modelIds = pinned.length ? pinned : this.preferred(kind, dispatch.modelIds);

    const blocked =
      isConsequential(prompt) ||
      looksLikeLiveFact(prompt) ||
      looksLikeLiveState(prompt) ||
      liveContext ||
      this.needsWeb(prompt) ||
      sources.length > 0;
    const sensitive = looksSensitive(prompt);
    let localMind: LocalMindDecision = {
      skipModel: false,
      reply: null,
      reason: "unreadable",
      confidence: 0,
      cardId: null,
      appliedToPolicy: false,
      omittedChars: 0,
    };
    let ledgerId: number | undefined;
    try {
      // A correction, or the same ask again, right after a saved answer lowers that card first.
      const lowered = watchLearnedAnswer({ prompt, learn: autoLearn });
      if (lowered) notes.push(`local mind: a saved answer was ${lowered} after your follow-up`);
      localMind = consultLocalMind({
        prompt,
        blocked,
        sensitive,
        now: Date.now(),
        ...(options.history ? { history: options.history } : {}),
      });
      noteCardAnswer({
        prompt,
        cardId: localMind.skipModel ? localMind.cardId : null,
        learn: autoLearn,
      });
      const gate = localMind.gate;
      if (gate) {
        const pct = (value: number) => Math.round(value * 100);
        notes.push(
          `brain-first gate: ${gate.skippedModel ? "answered by saved card" : "model kept"} (score ${pct(gate.score)}% of ${pct(gate.threshold)}% needed; ${gate.reason})`,
        );
        // The server is not known yet: only an all-local route is called local. finishAnswer settles it.
        ledgerId = recordAnswer({
          kind,
          source: gate.skippedModel
            ? "learned-card"
            : routeIsLocal(modelIds)
              ? "local-model"
              : "unknown-model",
          escalated: !gate.skippedModel,
          confidence: localMind.confidence,
          tier: sensitive ? "SENSITIVE" : "STANDARD",
        });
        noteLedgerTurn({ prompt, id: ledgerId, learn: autoLearn });
        stage?.(
          "thinking.cognition",
          `brain-first gate: score ${pct(gate.score)}% / ${pct(gate.threshold)}% · ${gate.reason} · model ${gate.skippedModel ? "skipped" : "kept"}`,
        );
      }
      if (localMind.skipModel && localMind.cardId) {
        commitLocalAnswer(localMind.cardId, dispatch.system.length + prompt.length);
        notes.push("local mind: FRIDAY answers from what she already learned; model stays idle");
      } else {
        noteModelTurn();
        const packed = packHistory(options.history ?? []);
        if (packed.omittedChars > 0) {
          notes.push(
            `local mind: earlier turns stay on this PC (${packed.omittedChars} characters kept off the model)`,
          );
        }
        notes.push(`local mind: ${localMind.reason}`);
      }
    } catch {
      notes.push("local mind: unreadable");
    }

    this.state.turns += 1;
    this.last = {
      at: Date.now(),
      prompt: prompt.length > 140 ? `${prompt.slice(0, 137)}…` : prompt,
      route: `${classified.klass} → ${classified.action}`,
      effort: reasoningEffortFor(classified.action, depthPlan.depth),
      models: modelIds,
      routing: localMind.skipModel
        ? "local mind — model stayed idle"
        : pinned.length
          ? `${pinned.length} model(s) pinned by owner`
          : dispatch.routing,
      notes: notes.slice(-14),
      checked: checksFor(prompt),
      issues: [],
      verified: null,
      sources: sources.length,
      tools: tools.map((tool) => `${tool.tool}${tool.ok ? "" : " (failed)"}`),
    };
    this.emit();

    return {
      taskId: newTaskId(),
      prompt,
      mode,
      system: dispatch.system,
      modelIds,
      routing: localMind.skipModel
        ? "local mind — model stayed idle"
        : pinned.length
          ? `${pinned.length} model(s) pinned by owner`
          : dispatch.routing,
      context: dispatch.context,
      tools,
      sources,
      notes,
      dispatch,
      startedAt: Date.now(),
      useKnowledge,
      useProjectMemory,
      autoLearn,
      understanding,
      strategy: strategy.strategy,
      reasoningEffort: reasoningEffortFor(classified.action, depthPlan.depth),
      routeAction: classified.action,
      ...(options.surface ? { surface: options.surface } : {}),
      ...(liveContext ? { liveContext: true } : {}),
      ...(untrustedKinds.size ? { untrustedKinds: [...untrustedKinds] } : {}),
      ...(control ? { control } : {}),
      localMind,
      ...(ledgerId !== undefined ? { ledgerId } : {}),
      ...(meta ? { meta } : {}),
      ...(reasoning
        ? {
            reasoning: {
              publicNote: reasoning.publicNote,
              verified: reasoning.verified,
              groundedness: reasoning.groundedness,
            },
          }
        : {}),
    };
  }

  /** Live snapshot of every model, tool, skill and system path she can use. */
  capabilities(refresh = false): CapabilitySnapshot {
    return refresh ? capabilityRegistry.refresh() : capabilityRegistry.getSnapshot();
  }

  /**
   * Cross-checks the answers several engines produced for one turn, picks the
   * best verified one, records what each engine did, and returns the answer in
   * FRIDAY's own voice. Single-engine turns pass straight through.
   */
  reconcileTurn(cognition: Cognition, answers: ModelAnswer[]): Reconciliation {
    const scores: Record<string, number> = {};
    for (const answer of answers) {
      if (!answer.ok) continue;
      scores[answer.modelId] = this.verify(cognition, answer.text, true).score;
    }
    const result = reconcileAnswers(answers, {
      scores,
      requireSources: cognition.sources.length > 0,
    });
    // Every engine that ran is measured, not just the winner — that is what
    // keeps routing preferences honest over time.
    for (const answer of answers) {
      const kind = taskKind(cognition.prompt);
      const key = `${kind}|${answer.modelId}`;
      const stat = this.state.models[key] ?? { runs: 0, ok: 0, ms: 0 };
      const won = answer.modelId === result.winner;
      this.state.models[key] = {
        runs: stat.runs + 1,
        ok: stat.ok + (answer.ok && won ? 1 : 0),
        ms: Math.round((stat.ms * stat.runs + (answer.ms ?? 0)) / (stat.runs + 1)),
      };
    }
    this.settleLedger(cognition, result.winner);
    this.emit();
    return result;
  }

  /**
   * Settle this turn's ledger entry with the model that answered. With no served model the entry
   * becomes local only when the whole route was local, else unknown: never guessed cloud or local.
   */
  settleLedger(cognition: Cognition, servedModelId?: string | null): void {
    if (cognition.ledgerId === undefined) return;
    const tier = looksSensitive(cognition.prompt) ? "SENSITIVE" : "STANDARD";
    const record = servedModelId ? brainModelRegistry.get(servedModelId) : undefined;
    if (!record) {
      finishAnswer(cognition.ledgerId, {
        source: routeIsLocal(cognition.modelIds) ? "local-model" : "unknown-model",
        tier,
      });
      return;
    }
    if (record.kind === "local") {
      finishAnswer(cognition.ledgerId, { source: "local-model", tier });
      return;
    }
    finishAnswer(cognition.ledgerId, {
      source: "cloud",
      tier,
      paid: record.cost === "metered",
      paidApproved: allowedModelIds([record.id]).length > 0,
    });
  }

  /** Strips a foreign engine identity from any single answer. */
  speakAsFriday(text: string): string {
    return reviseConversationalAnswer(enforceIdentity(text));
  }

  /**
   * Self-evaluation. Honest heuristics only — it checks that something real
   * came back, that a failed tool was not answered over, and that sourced
   * questions came back with sources.
   */
  verify(cognition: Cognition, answer: string, ok: boolean, error?: string): Verification {
    const issues: string[] = [];
    const text = (answer ?? "").trim();
    if (!ok) issues.push(error ? `run failed: ${error}` : "run failed");
    if (!text) issues.push("no answer text produced");
    else if (text.length < 3) issues.push("answer too short to be a response");
    if (/\b(as an ai language model|i cannot access)\b/i.test(text)) {
      issues.push("engine deflected instead of answering");
    }
    // A spoken answer is read aloud and carries no link by rule: the sources sit in the panel instead.
    if (cognition.sources.length && cognition.surface !== "voice" && !/https?:\/\//i.test(text)) {
      issues.push("web sources were retrieved but not cited in the answer");
    }
    // A sentence that carries a link must be about what that source says.
    if (cognition.sources.length) {
      for (const problem of checkCitations(text, cognition.sources).slice(0, 2)) {
        issues.push(`a citation does not hold: ${problem.reason} (${problem.url})`);
      }
    }
    // What the ask required and can be counted or parsed (limits, bullets, JSON, language, a sum).
    for (const failure of checkAnswer(cognition.prompt, text).failures) {
      if (failure.id !== "identity") issues.push(failure.message);
    }
    let selfEvalRan = false;
    turnMark("verify", "self-eval");
    try {
      const selfEval = evaluateAnswer({
        prompt: cognition.prompt,
        answer: text,
        ...(cognition.meta ? { meta: cognition.meta } : {}),
        ...(cognition.understanding?.resolvedGoal
          ? { goal: cognition.understanding.resolvedGoal }
          : {}),
        toolsFailed: cognition.tools.some((tool) => !tool.ok),
        knowledgeSupported: !cognition.notes.some((note) =>
          /knowledge status: unknown|retrieval grade: incorrect|CRAG: web hits too weak/.test(note),
        ),
        ...(typeof cognition.reasoning?.groundedness === "number"
          ? { groundedness: cognition.reasoning.groundedness }
          : {}),
      });
      if (selfEval.ran) {
        selfEvalRan = true;
        issues.push(...selfEval.issues);
        if (!selfEval.ok) {
          try {
            proposeFabricLimitation({
              id: `self-eval-${selfEval.issues[0] ?? "issue"}`.slice(0, 80),
              title: "Self-evaluation found a consequential-answer issue",
              rationale: selfEval.reason,
              evidence: selfEval.issues,
              kind: "code-change",
              risk: "review",
            });
          } catch {
            /* filing a gap must never break verify */
          }
        }
      }
      const decided = lastDecision();
      const fit = evaluateConversationalFit({
        prompt: cognition.prompt,
        answer: text,
        ...(cognition.understanding?.resolvedGoal
          ? { goal: cognition.understanding.resolvedGoal }
          : {}),
        ...(cognition.strategy ? { strategy: cognition.strategy } : {}),
        correction: cognition.understanding?.conversationalMove === "correction",
        frustrated: /frustrat|cautious|urgent/.test(cognition.notes.join(" ")),
        ...(decided ? { selectedDecision: decided.selected, rejected: decided.rejected } : {}),
      });
      if (fit.ran) {
        const remaining = fit.issues.filter((issue) => issue !== "answer opened with filler");
        issues.push(...remaining);
      }
      turnDone(
        "verify",
        "self-eval",
        selfEval.ran ? `${selfEval.issues.length} issue(s)` : "skipped",
      );
    } catch {
      turnDone("verify", "self-eval", "unreadable");
    }
    // evaluateAnswer already flags an unmentioned tool failure when it runs.
    if (
      !selfEvalRan &&
      cognition.tools.some((t) => !t.ok) &&
      !/search|could not|unavailable|failed/i.test(text)
    ) {
      issues.push("a tool failed but the answer does not mention it");
    }
    const score = Math.max(0, 1 - issues.length * 0.34);
    if (this.last && this.last.prompt.startsWith(cognition.prompt.slice(0, 40))) {
      this.last = {
        ...this.last,
        issues: issues.slice(0, 6),
        verified: ok && Boolean(text) && issues.length === 0,
        checked: [
          ...new Set([...this.last.checked, ...checkAnswer(cognition.prompt, text).checked]),
        ],
      };
    }
    return {
      ok: ok && Boolean(text) && issues.length === 0,
      score,
      issues,
      detail: issues.length ? issues.join("; ") : "verified: real answer produced",
    };
  }

  /**
   * Close the loop: verify, feed the existing learning path, record routing
   * quality and keep genuinely useful facts (sources, corrections).
   * Incremental: no model retrain is required for these writes.
   */
  reflect(input: {
    cognition: Cognition;
    answer: string;
    ok: boolean;
    ms?: number;
    error?: string;
    /** Personality → Learn from conversations. Default follows cognition.autoLearn. */
    learn?: boolean;
    /** The model that actually answered, when the caller knows it. */
    servedModelId?: string;
  }): Verification {
    this.load();
    const { cognition } = input;
    this.settleLedger(cognition, input.servedModelId);
    const ms = input.ms ?? Date.now() - cognition.startedAt;
    const verification = this.verify(cognition, input.answer, input.ok, input.error);
    const kind = taskKind(cognition.prompt);
    const learn = input.learn ?? cognition.autoLearn !== false;

    for (const id of cognition.modelIds) {
      const key = `${kind}|${id}`;
      const stat = this.state.models[key] ?? { runs: 0, ok: 0, ms: 0 };
      this.state.models[key] = {
        runs: stat.runs + 1,
        ok: stat.ok + (verification.ok ? 1 : 0),
        ms: Math.round((stat.ms * stat.runs + ms) / (stat.runs + 1)),
      };
    }
    const keys = Object.keys(this.state.models);
    if (keys.length > MAX_MODEL_STATS) {
      for (const key of keys.slice(0, keys.length - MAX_MODEL_STATS)) delete this.state.models[key];
    }
    if (verification.ok) this.state.verified += 1;
    else this.state.rejected += 1;

    if (!verification.ok && cognition.control?.experience) {
      try {
        learning.fileAntiAnchor({
          taskId: cognition.taskId,
          failedStrategy: cognition.control.experience.failedStrategy,
          alternative: cognition.control.experience.alternative,
          whyDifferent: cognition.control.experience.whyDifferent,
          cause: verification.detail,
        });
      } catch {
        /* a candidate must never block the reply */
      }
    }

    // Keep sourced research with URLs. Web snippets stay observed, not verified.
    const keepKnowledge = learn && cognition.useKnowledge !== false;
    if (
      keepKnowledge &&
      verification.ok &&
      cognition.sources.length &&
      !looksSensitive(cognition.prompt)
    ) {
      try {
        brainKnowledge.remember({
          kind: "knowledge",
          title: `Researched — ${cognition.prompt.slice(0, 70)}`,
          body: `${input.answer.slice(0, 600)}\nSources: ${cognition.sources
            .map((s) => s.url)
            .join(", ")}`,
          tags: ["research", kind, "unverified"],
          source: "web-search",
          provenance: "observed",
          confidence: 0.55,
        });
      } catch {
        /* knowledge is best-effort, never blocks a reply */
      }
    }

    try {
      if (learn && verification.ok && !cognition.localMind?.skipModel) {
        distillLocalAnswer({
          prompt: cognition.prompt,
          answer: input.answer,
          blocked:
            isConsequential(cognition.prompt) ||
            looksLikeLiveFact(cognition.prompt) ||
            looksLikeLiveState(cognition.prompt) ||
            cognition.liveContext === true ||
            cognition.tools.length > 0 ||
            cognition.sources.length > 0,
          sensitive: looksSensitive(`${cognition.prompt}\n${input.answer}`),
          now: Date.now(),
        });
      }
    } catch {
      /* a local card must never block the reply */
    }

    try {
      const title = cognition.prompt.slice(0, 80);
      const policy = considerMemory({
        text: cognition.prompt,
        title,
        ok: verification.ok,
        kind,
        sourced: cognition.sources.length > 0,
      });
      if (learn && policy.keep) {
        consolidateEvent({
          text: `${cognition.prompt}\n${verification.detail}`.slice(0, 4000),
          title,
          source: `task/${cognition.taskId}`,
          context: `${cognition.mode}:${kind}`,
          ok: verification.ok,
          sourced: cognition.sources.length > 0,
          confidence: Math.min(policy.confidence, verification.score),
          verified: verification.ok,
          ...(verification.ok ? {} : shouldWriteLessons() ? { kindHint: "failure" as const } : {}),
        });
      }
    } catch {
      /* same */
    }

    try {
      // An answer built from a web page, a file, the screen or a connector is not the owner's own knowledge:
      // it is not learned as a conversation fact.
      if (
        keepKnowledge &&
        verification.ok &&
        !cognition.sources.length &&
        !cognition.untrustedKinds?.length &&
        !looksSensitive(`${cognition.prompt}\n${input.answer}`)
      ) {
        ingestKnowledge({
          text: `${cognition.prompt}\n${input.answer}`,
          source: `conversation/${cognition.taskId}`,
          kind: "conversation",
        });
      }
    } catch {
      /* ingestion is best-effort */
    }

    try {
      if (learn) {
        learning.observeConversationalOutcome({
          prompt: cognition.prompt,
          ...(cognition.understanding?.conversationalMove
            ? { move: cognition.understanding.conversationalMove }
            : {}),
          styleCue: cognition.understanding?.resolvedIntent.styleCue ?? null,
          accepted: verification.ok,
        });
      }
    } catch {
      /* conversational learning must never break a turn */
    }

    try {
      snapshotCurrentSituation();
    } catch {
      /* compact snapshot must never break a turn */
    }

    completeTurn({
      taskId: cognition.taskId,
      mode: cognition.mode,
      prompt: cognition.prompt,
      answer: input.answer,
      ok: verification.ok,
      ms,
      modelIds: cognition.modelIds,
      ...(input.error ? { error: input.error } : {}),
    });

    this.emit();
    return verification;
  }

  /**
   * Self-improvement: FRIDAY may only ever *propose*. Governance holds the
   * item until the owner approves it, so no code or system change is applied
   * behind the owner's back.
   */
  async proposeUpgrade(input: {
    title: string;
    rationale: string;
    evidence?: string[];
  }): Promise<string | null> {
    try {
      const item = await governance.submit({
        kind: "self-upgrade",
        title: input.title,
        rationale: input.rationale,
        risk: "review",
        ...(input.evidence ? { evidence: input.evidence } : {}),
        apply: async () => ({
          ok: true,
          detail: "Approved by the owner — recorded as an accepted improvement.",
        }),
      });
      return item.id;
    } catch {
      return null;
    }
  }

  /** Turns measured weakness into an approval-gated proposal. Never applies. */
  async reviewSelf(): Promise<string | null> {
    this.load();
    const weak = Object.entries(this.state.models)
      .filter(([, stat]) => stat.runs >= 4 && stat.ok / stat.runs < 0.6)
      .sort((a, b) => a[1].ok / a[1].runs - b[1].ok / b[1].runs)[0];
    if (!weak) return null;
    const [key, stat] = weak;
    const [kind, modelId] = key.split("|");
    return this.proposeUpgrade({
      title: `Reroute ${kind} away from ${modelId}`,
      rationale: `${modelId} verified only ${stat.ok}/${stat.runs} ${kind} turns (avg ${(
        stat.ms / 1000
      ).toFixed(1)}s). Suggest preferring a stronger engine for this task kind.`,
      evidence: [`measured over ${stat.runs} runs by FRIDAY's Core Brain`],
    });
  }
}

export const coreBrain = new CoreBrain();
