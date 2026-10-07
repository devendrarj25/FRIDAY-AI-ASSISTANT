/**
 * FRIDAY · runtime flow
 *
 * The single path every request takes, whichever mode asked for it:
 *
 *   prompt → memory recall → FRIDAY's identity, rules and knowledge
 *          → model routing (her own router over the installed local/cloud
 *            models) → execution → verification → memory + learning
 *
 * Manual Mode (chat) and Auto Mode (voice) both go through the brain store,
 * and the brain store goes through here — that is what keeps the two modes,
 * the brain, memory, the model system and self-progress on one state.
 *
 * Nothing here invents a result. If no model is available the dispatch says so
 * and the caller surfaces it instead of pretending to answer.
 */

import { identity } from "./brain/identity";
import { manualChatGuide } from "./chat-turn";
import { looksLikeCorrection } from "./brain/intent-engine";
import { affect } from "./brain/affect";
import { classifyPriority } from "./brain/priority";
import { systemContextPrompt } from "./system-context";
import { brainKnowledge, claimActive } from "./brain/knowledge-base";
import { expertiseContext } from "./brain/expertise";
import {
  dispatchRole,
  pickHealthyModelId,
  planPipeline,
  recordStep,
  type Pipeline,
} from "./brain/orchestrator";
import { turnDone, turnMark } from "./brain/turn-timing";
import type { StageReporter } from "./brain/turn-trace";
import { modelRegistry } from "./brain/model-registry";
import { allowedModelIds, currentPolicy, describePolicy } from "./brain/cost-policy";
import { recordDecision } from "./brain/decision-trace";
import { estimateConfidence } from "./brain/confidence";
import {
  capabilityRegistry,
  type ResourceType,
  type CapabilityResource,
} from "./brain/capability-registry";
import { hub, type HubKind } from "./hub-engine";
import { watchStartup } from "./startup";
import { ensureEssentialCapabilities } from "./capability-seed";
import { buildCapabilityGroups, type CapabilityKind } from "./capabilities";
import { deliverSenses, emptySenseGate } from "./assistant-conduct";
import { noteSense } from "./control-center";
import { desktopApi, getWorkspaceScan, onWorkspaceScanChange } from "./desktop";
import { preferences } from "./preferences";
import { approvedFolderList, isSenseId, switchesFromToggles } from "./senses";
import { autonomy } from "./self/autonomy";
import { listCapabilities, type CapabilityItem } from "./capability-trees";
import { type ModelsState } from "./models-engine";
import { listConnectors } from "./connectors";

/** Workspace capability kinds mapped onto the one registry's resource types. */
const WORKSPACE_TYPE: Partial<Record<CapabilityKind, ResourceType>> = {
  models: "model",
  tools: "tool",
  skills: "skill",
  agents: "agent",
  modules: "module",
  plugins: "plugin",
  workflows: "workflow",
};

/** Hub kinds mapped onto the capability-registry resource types. */
const HUB_TYPE: Record<HubKind, ResourceType> = {
  model: "model",
  tool: "tool",
  skill: "skill",
  agent: "agent",
  module: "module",
  plugin: "plugin",
  workflow: "workflow",
  runtime: "system",
  unknown: "tool",
};

import { memory } from "./self/memory-engine";
import {
  describeEvidence,
  formatEvidenceLine,
  type RankSignals,
  type VectorSnippet,
} from "./brain/retrieval";
import { learning } from "./self/learning-engine";
import { conversationDigest } from "./brain/conversation-state";
import { boundLines } from "./brain/local-mind";
import {
  governRecall,
  memoryCacheEpoch,
  memoryFabricEnabled,
  takeCompiledMemory,
} from "./brain/memory-fabric";
import { models } from "./models-engine";
import type { RoutingTask } from "./model-catalog";

export type TurnMode = "manual" | "auto";

export type TurnDispatch = {
  /** The system prompt: identity + rules + recalled context. */
  system: string;
  /** Models to run, strongest first. Empty means nothing is available. */
  modelIds: string[];
  /** Human-readable routing note for the run log. */
  routing: string;
  pipeline: Pipeline;
  /** Memory lines that were injected, for the run detail panels. */
  context: string[];
};

export type TurnOutcome = {
  taskId: string;
  mode: TurnMode;
  prompt: string;
  answer: string;
  ok: boolean;
  ms: number;
  modelIds: string[];
  error?: string;
  correction?: string;
};

const CODE = /\b(code|bug|error|refactor|compile|build|typescript|python|script|function)\b/i;
const REASON = /\b(why|plan|design|compare|analyse|analyze|decide|strategy|architecture)\b/i;
const VISION = /\b(image|screenshot|picture|photo|diagram)\b/i;

/** Memory + knowledge worth putting in front of the model for this prompt. */
function recallContext(prompt: string, depth: number, vectorHits?: VectorSnippet[]): string[] {
  const lines: string[] = [];
  const cap = Math.min(depth, 6);
  const vectorOpt = vectorHits?.length ? { vectorHits } : {};
  try {
    const session = conversationDigest();
    const hits = memory.retrieve(prompt, cap, {
      ...(session ? { context: session } : {}),
      ...vectorOpt,
    });
    const reflections = memory
      .retrieve(prompt, Math.max(2, cap), vectorOpt)
      .filter((hit) => hit.item.tags.includes("reflection"));
    const merged = [...reflections, ...hits].filter(
      (hit, index, all) => all.findIndex((row) => row.item.id === hit.item.id) === index,
    );
    const snapshot = memory.getSnapshot();
    const cacheKey = `${memoryCacheEpoch()}:${snapshot.lastWriteAt}:${cap}:${Boolean(vectorHits?.length)}:${prompt}`;
    const packet = takeCompiledMemory(cacheKey, () => {
      const selected = memoryFabricEnabled()
        ? governRecall({
            prompt,
            hits: merged,
            archive: snapshot.items,
            now: Date.now(),
            budget: cap,
            vectorsAvailable: Boolean(vectorHits?.length),
          }).admitted
        : merged.slice(0, cap);
      return selected.map((hit) => {
        const peers = snapshot.items
          .filter((item) => (hit.item.relatedIds ?? []).includes(item.id))
          .map(memoryToSignals);
        const card = describeEvidence(memoryToSignals(hit.item), peers);
        return `[${hit.item.tier}] ${hit.item.title}: ${hit.item.text} (${formatEvidenceLine(card)})`;
      });
    });
    lines.push(...packet.lines);
  } catch {
    /* memory is optional context, never a hard dependency */
  }
  try {
    for (const entry of brainKnowledge.recall(prompt, {
      k: Math.max(2, Math.floor(cap / 2)),
      ...vectorOpt,
    })) {
      if (!claimActive(entry, Date.now())) continue;
      const evidence = brainKnowledge.evidenceLine(entry);
      const flag = entry.contradiction ? " [contradiction flagged]" : "";
      lines.push(`[${entry.kind}] ${entry.title}: ${entry.body}${flag} (${evidence})`);
    }
  } catch {
    /* same */
  }
  try {
    // FRIDAY's own built-in tool/error/coding expertise, so a model answers
    // with her knowledge of this machine instead of generic advice.
    lines.push(...expertiseContext(prompt, 2));
  } catch {
    /* same */
  }
  return lines.slice(0, cap + 2);
}

function memoryToSignals(item: {
  title: string;
  text: string;
  tags: string[];
  source: string;
  confidence: number;
  updatedAt: number;
  freshnessAt?: number;
  verified?: boolean;
  contradiction?: boolean;
  pinned: boolean;
  uses: number;
  scope?: string;
  tier: string;
}): RankSignals {
  const signals: RankSignals = {
    title: item.title,
    text: item.text,
    tags: item.tags,
    source: item.source,
    confidence: item.confidence,
    updatedAt: item.updatedAt,
    pinned: item.pinned,
    uses: item.uses,
    permanent: item.tier === "permanent",
  };
  if (item.scope) signals.scope = item.scope;
  if (item.freshnessAt !== undefined) signals.freshnessAt = item.freshnessAt;
  if (item.verified !== undefined) signals.verified = item.verified;
  if (item.contradiction !== undefined) signals.contradiction = item.contradiction;
  return signals;
}

/**
 * FRIDAY's own router: her capability registry picks the models, and the
 * routing the owner pinned in the Models page always wins for its task.
 */
function routeModels(
  prompt: string,
  multi: boolean,
): { ids: string[]; pipeline: Pipeline; note: string } {
  const pipeline = planPipeline({
    prompt,
    needsCode: CODE.test(prompt),
    needsReasoning: REASON.test(prompt),
    needsVision: VISION.test(prompt),
  });

  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  // 1. Pinned routing for the task the prompt looks like.
  const routing = models.getSnapshot().routing;
  const task: RoutingTask = CODE.test(prompt)
    ? "coding"
    : REASON.test(prompt)
      ? "reasoning"
      : VISION.test(prompt)
        ? "vision"
        : "brain";
  add(routing[task] ?? routing.brain ?? routing.fast ?? null);

  // 2. Then the roles her own registry chose for this request.
  for (const step of pipeline.steps) add(step.modelId);

  // 3. Safety net only: when the smart path produced no candidates, any
  //    active model keeps a configured machine from going mute. Do not fan
  //    every available id in front of dispatchRole.
  if (!ids.length) {
    for (const record of modelRegistry.available()) add(record.id);
  }

  // The owner's usage policy is the last word over every source above — a
  // pinned or fallback model must obey it just like a planned one does.
  const policy = currentPolicy();
  const permitted = allowedModelIds(ids, policy);

  const selected = multi ? permitted.slice(0, 3) : permitted.slice(0, 1);
  const note = selected.length
    ? `${selected.length} model(s) · ${pipeline.steps.map((step) => `${step.role}:${step.modelLabel}`).join(", ")} · ${describePolicy(policy)}`
    : "no model available — install a local model or configure a provider";
  return { ids: selected, pipeline, note };
}

/**
 * Confirm the routed models through `dispatchRole` (reuse / ledger) without
 * dropping the existing empty-pool safety net. A failure here keeps the
 * ids `prepareTurn` already chose.
 */
export async function refineTurnWithDispatchRole(
  prompt: string,
  dispatch: TurnDispatch,
  options: { onStage?: StageReporter } = {},
): Promise<TurnDispatch> {
  const role = dispatch.pipeline.steps[0]?.role ?? "fast";
  const picked = pickHealthyModelId(role, dispatch.modelIds);
  const seed = picked.modelId;
  if (!seed) {
    const note = `dispatchRole: no candidates — keeping the existing safety net · ${dispatch.routing}`;
    options.onStage?.("orchestrator.pipeline", note);
    return { ...dispatch, routing: note };
  }
  try {
    const routed = await dispatchRole({
      role,
      // Distinct from the owner's prompt so a later role execution cannot
      // reuse this selection record as if it were the chat answer.
      prompt: `orchestrator.route ${role}: ${prompt}`,
      allowReuse: false,
      measure: false,
      run: async () => ({ modelId: seed, result: seed }),
    });
    const rest = dispatch.modelIds.filter((id) => id !== routed.modelId);
    const modelIds = [routed.modelId, ...rest];
    const switchNote = picked.reason ? `${picked.reason} · ` : "";
    const note = `${switchNote}dispatchRole ${role} → ${routed.modelId} · ${dispatch.routing}`;
    options.onStage?.("orchestrator.pipeline", note);
    return { ...dispatch, modelIds, routing: note };
  } catch {
    options.onStage?.(
      "orchestrator.pipeline",
      `dispatchRole unresolved — keeping ${dispatch.routing}`,
    );
    return dispatch;
  }
}

/** Everything the brain needs to run one turn. Pure — it changes no state. */
export function prepareTurn(
  prompt: string,
  options: {
    mode?: TurnMode;
    multiModel?: boolean;
    depth?: number;
    extra?: string;
    onStage?: StageReporter;
    /** Optional kernel vector hits for hybrid recall. Empty means skip. */
    vectorHits?: VectorSnippet[];
  } = {},
): TurnDispatch {
  const mode = options.mode ?? "manual";
  const tRecall = Date.now();
  const context = recallContext(prompt, options.depth ?? 6, options.vectorHits);
  options.onStage?.(
    "memory.tiers",
    context.length ? `${context.length} recalled line(s)` : "no recalled memory",
  );
  turnMark("prepare", "recall");
  turnDone("prepare", "recall", `${context.length} lines in ${Date.now() - tRecall}ms`);
  // Read the OS clock at dispatch time so "today", "now" and "latest" are
  // never answered from a cached or trained-in date.
  const parts: string[] = [systemContextPrompt()];
  // Read the owner's tone from what he actually wrote, and let FRIDAY's own
  // working state shape how she answers. Simulated states only — the fragment
  // itself forbids claiming human feelings.
  try {
    affect.observePrompt(prompt);
    parts.push(affect.prompt());
    const verdict = classifyPriority({ text: prompt });
    parts.push(
      `Priority of this request: ${verdict.priority}${verdict.reasons.length ? ` (${verdict.reasons.join("; ")})` : ""}.`,
    );
  } catch {
    /* affect is guidance, never a hard dependency of a turn */
  }
  const boundedMemory = boundLines(context, 2400);
  if (boundedMemory.lines.length) {
    parts.push(
      "What you already know that is relevant (your own memory — use it, do not repeat it back verbatim):",
      ...boundedMemory.lines.map((line) => `- ${line}`),
    );
    if (boundedMemory.omittedChars > 0) {
      parts.push(
        `Further memory stays on this PC (${boundedMemory.omittedChars} characters were not sent).`,
      );
    }
  }
  if (mode === "auto") {
    parts.push(
      [
        "AUTO MODE — you are speaking out loud, like a phone voice assistant.",
        "Answer in at most 2 short spoken sentences (roughly 40 words). Never list, never use markdown, bullets, headings, code fences, emoji or URLs — they cannot be heard.",
        "Give the direct answer first. Offer one short follow-up question only when you genuinely need a missing detail.",
        "If the answer is long, say the one-line summary out loud and put the rest in the panel instead of reading it.",
        "Any action that changes files, apps or system state has already been confirmed by the owner before it reaches you.",
      ].join(" "),
    );
  } else {
    parts.push(manualChatGuide(prompt, identity.getSnapshot().profile.replyLanguage));
  }

  if (options.extra) parts.push(options.extra);

  // Auto Mode is spoken out loud, so it answers with the single best model to
  // keep latency low; Manual Mode may fan the turn out across models.
  const tPlan = Date.now();
  const { ids, pipeline, note } = routeModels(
    prompt,
    mode === "auto" ? false : (options.multiModel ?? true),
  );
  options.onStage?.(
    "thinking.planner",
    pipeline.steps.map((step) => `${step.role}:${step.modelLabel}`).join(", ") || "no roles",
  );
  options.onStage?.("orchestrator.pipeline", note);
  turnMark("prepare", "plan");
  turnDone("prepare", "plan", `${Date.now() - tPlan}ms ${note}`);
  // Record the REAL routing decision for this turn so the owner can ask "why
  // did you use that model" later and get this exact evidence back.
  try {
    recordDecision({
      at: Date.now(),
      mode,
      prompt,
      modelIds: ids,
      routing: note,
      policy: currentPolicy(),
      confidence: estimateConfidence(prompt),
    });
  } catch {
    /* tracing must never break a turn */
  }
  return {
    system: identity.compile(parts.join("\n")),
    modelIds: ids,
    routing: note,
    pipeline,
    context,
  };
}

/**
 * Close the loop: score the models that ran, write the episode to memory and
 * let the learning engine decide whether it becomes lasting knowledge.
 * Permanent memory is never written from here — only verified patterns and
 * explicit corrections are promoted, inside the learning engine.
 */
export function completeTurn(outcome: TurnOutcome): void {
  try {
    affect.observeOutcome({ ok: outcome.ok, ms: outcome.ms });
  } catch {
    /* never let state bookkeeping break a finished turn */
  }

  for (const modelId of outcome.modelIds) {
    recordStep({
      taskId: outcome.taskId,
      role: "planner",
      modelId,
      ok: outcome.ok,
      ms: outcome.ms,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  const correction =
    outcome.correction?.trim() ||
    (looksLikeCorrection(outcome.prompt) ? outcome.prompt : undefined);

  learning.evaluate({
    taskId: outcome.taskId,
    kind: `${outcome.mode}-turn`,
    title: outcome.prompt.slice(0, 80),
    success: outcome.ok,
    // A finished answer is verified; a stream that broke is not.
    verified: outcome.ok && outcome.answer.trim().length > 0,
    ms: outcome.ms,
    detail: outcome.ok ? outcome.answer.slice(0, 400) : (outcome.error ?? "no answer"),
    models: outcome.modelIds,
    ...(correction ? { correction } : {}),
  });
}

let booted = false;

/** Live mirror of the desktop capability index, kept fresh by its own event. */
let installedCapabilities: CapabilityItem[] = [];

async function reloadInstalledCapabilities(): Promise<void> {
  try {
    const index = await listCapabilities();
    installedCapabilities = index?.items ?? [];
    capabilityRegistry.refresh();
  } catch {
    /* the registry keeps its previous view rather than losing capabilities */
  }
}

/**
 * One idempotent start-up pass. Restores her identity to disk (so the Python
 * kernel injects the same persona), warms the capability registry from the
 * models that are really installed, and leaves everything else to the stores
 * that already hydrate themselves.
 */
/** A sense event is offered through the life-offer gate and does not run a tool. */
function bindSenseOffers(): void {
  const api = desktopApi() as {
    onSenseEvent?: (
      cb: (raw: {
        sense?: string;
        at?: number;
        text?: string;
        path?: string;
        hour?: number;
      }) => void,
    ) => () => void;
  } | null;
  if (!api?.onSenseEvent) return;
  let state = emptySenseGate();
  api.onSenseEvent((raw) => {
    try {
      if (!raw || typeof raw.sense !== "string" || !isSenseId(raw.sense)) return;
      const prefs = preferences.getSnapshot();
      const dial = autonomy.getSnapshot();
      const hourValue = raw.hour;
      const hour =
        typeof hourValue === "number" && Number.isFinite(hourValue) ? Math.floor(hourValue) : 12;
      const at = Number.isFinite(raw.at) ? Number(raw.at) : 0;
      const next = deliverSenses({
        switches: switchesFromToggles(prefs.toggles),
        raw: [
          {
            sense: raw.sense,
            at,
            text: typeof raw.text === "string" ? raw.text : "",
            path: typeof raw.path === "string" ? raw.path : "",
            approvedFolders: approvedFolderList(prefs.fields["senseFolders"]),
          },
        ],
        now: at,
        hour,
        level: dial.approvalLevel,
        halted: dial.halted,
        state,
      });
      state = next.state;
      const heard = next.events[next.events.length - 1];
      if (heard) noteSense(heard.at);
    } catch {
      /* a sense must never take the UI down */
    }
  });
}

export function bootRuntime(): void {
  if (booted || typeof window === "undefined") return;
  booted = true;
  try {
    identity.sync();
    modelRegistry.list();
    // Everything the owner approved in the Friday Hub becomes routable again,
    // with its real state (kind, path, health, active flag) restored from disk.
    capabilityRegistry.registerProvider(() =>
      hub.activeResources().map((resource) => ({
        id: `hub:${resource.kind}:${resource.name}`,
        type: HUB_TYPE[resource.kind],
        name: resource.name,
        ref: resource.name,
        capabilities: resource.capabilities,
        available: resource.health === "ready" || resource.health === "unknown",
        health:
          resource.health === "ready"
            ? "ready"
            : resource.health === "failed"
              ? "offline"
              : resource.health === "degraded"
                ? "degraded"
                : "unknown",
        reliability: null,
        latencyMs: null,
        cost: "local-compute",
        permission: resource.permission,
        detail: `Friday Hub · ${resource.kind}${resource.path ? ` · ${resource.path}` : ""}`,
      })),
    );
    // Everything that really exists inside the FRIDAY folder — the same
    // workspace scan the composer's capability chips are built from — becomes
    // one and the same registry the brain routes with. Chat, voice, manual and
    // auto mode all read this snapshot, so a newly installed skill/tool is
    // usable everywhere the moment the scan sees it, with no per-mode wiring.
    capabilityRegistry.registerProvider(() => {
      const scan = getWorkspaceScan();
      let snapshot: ModelsState | null;
      try {
        snapshot = models.getSnapshot();
      } catch {
        snapshot = null;
      }
      const out: CapabilityResource[] = [];
      for (const group of buildCapabilityGroups(snapshot, scan)) {
        const type = WORKSPACE_TYPE[group.kind];
        if (!type) continue;
        for (const item of group.items) {
          if (!item.live) continue; // never advertise a preview-only placeholder
          out.push({
            id: `${type}:${item.ref || item.name}`,
            type,
            name: item.name,
            ref: item.ref || item.name,
            capabilities: [group.kind, item.name.toLowerCase()],
            available: true,
            health: "ready",
            reliability: null,
            latencyMs: null,
            cost: type === "model" ? "local-compute" : "free",
            permission: type === "tool" ? "ask" : "open",
            detail: item.detail || `workspace ${group.kind}`,
          });
        }
      }
      return out;
    });
    // Installed capability packs — the SAME manifest-driven index the Agents,
    // Skills, Tools, Modules, Workflows and Plugins pages render. Registering
    // it here means a pack that installs and passes its sandbox test becomes
    // routable from chat, voice, manual mode, auto mode and the phone
    // companion immediately, with no restart and no per-surface wiring.
    capabilityRegistry.registerProvider(() =>
      installedCapabilities
        .filter((item) => item.enabled && item.tree !== "models")
        .map((item) => {
          const type = (WORKSPACE_TYPE[item.tree as CapabilityKind] ?? "tool") as ResourceType;
          return {
            id: `${type}:${item.id}`,
            type,
            name: item.name,
            ref: item.id,
            capabilities: [
              item.tree,
              item.category,
              item.role,
              item.name.toLowerCase(),
              ...(item.skills ?? []),
            ].filter(Boolean),
            skills: item.skills ?? [],
            workflows: item.workflows ?? [],
            role: item.role || "",
            available: true,
            health: "ready" as const,
            reliability: null,
            latencyMs: null,
            cost: "free" as const,
            permission: item.risk === "safe" ? ("open" as const) : ("ask" as const),
            detail: item.description || `${item.tree}/${item.segment}`,
          };
        }),
    );
    // The capability index broadcasts a change the instant an install, a
    // verification result or a removal lands — the same event every section
    // page listens to — so the registry never lags behind the UI.
    void reloadInstalledCapabilities();
    (
      desktopApi() as unknown as {
        onCapabilitiesChanged?: (cb: () => void) => () => void;
      } | null
    )?.onCapabilitiesChanged?.(() => void reloadInstalledCapabilities());
    // Connected services are the same list the Connectors page renders.
    // Load them at boot so chat, capability chips and companion live see
    // them without waiting for the owner to open /connectors.
    void listConnectors();
    (
      desktopApi() as unknown as {
        onConnectorsChanged?: (cb: () => void) => () => void;
      } | null
    )?.onConnectorsChanged?.(() => void listConnectors());
    // A fresh scan (a capability was installed, imported or removed) rebuilds
    // the one registry instead of any screen keeping a private copy.
    onWorkspaceScanChange(() => {
      try {
        capabilityRegistry.refresh();
      } catch {
        /* a resync failure must never take the UI down */
      }
    });
    capabilityRegistry.refresh();

    // Provider health lives in the model registry. A disconnect or a recovered
    // key must rebuild the one capability snapshot chat, voice, Auto Mode and
    // the phone already read — not a second list.
    modelRegistry.subscribe(() => {
      try {
        capabilityRegistry.refresh();
      } catch {
        /* a resync failure must never take the UI down */
      }
    });

    // Re-verify the active ones in the background; never blocks the UI.
    void hub.boot().then(() => capabilityRegistry.refresh());
    // The desktop startup flow (scan → services → verify → readiness) owns the
    // real machine state. When it reports READY, resynchronize FRIDAY's own
    // registries so both modes, the brain and every screen agree on what is
    // actually usable right now.
    watchStartup(() => {
      try {
        modelRegistry.list();
        capabilityRegistry.refresh();
      } catch {
        /* a resync failure must never take the UI down */
      }
    });
    // Ship-with-FRIDAY starter kit: install any missing preinstalled skill,
    // tool, agent, module, plugin or workflow into the workspace once, in the
    // background. Idempotent — existing capabilities are never touched.
    bindSenseOffers();
    void ensureEssentialCapabilities()
      .then((result) => {
        if (result.installed.length) capabilityRegistry.refresh();
      })
      .catch(() => {
        /* seeding is best-effort; FRIDAY still boots without the starter kit */
      });
  } catch {
    /* boot must never block the UI */
  }
}
