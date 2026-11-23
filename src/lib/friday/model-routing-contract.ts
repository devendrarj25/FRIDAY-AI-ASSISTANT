/**
 * FRIDAY · Authoritative Model Routing Contract.
 *
 * Single shared contract used across UI/manual selection, Brain, Electron,
 * model-router, and Kernel. Every inference request passes through this
 * exact structure so no layer can silently translate or downgrade routing mode.
 */

import { languageId } from "./asr-bias";
import { replyLanguage } from "./voice-session";

export const ROUTE_MODES = [
  "auto",
  "local-only",
  "cloud-only",
  "hybrid",
  "manual",
  "multi",
] as const;

export type RouteMode = (typeof ROUTE_MODES)[number];

export const COST_POLICIES = [
  "free-only",
  "free-first",
  "balanced",
  "quality-first",
  "paid",
  "paid-only",
] as const;

export type CostPolicy = (typeof COST_POLICIES)[number];

export const ROUTING_TASKS = [
  "chat",
  "reasoning",
  "coding",
  "vision",
  "tools",
  "research",
  "embeddings",
  "audio",
  "fast",
] as const;

export type RoutingTask = (typeof ROUTING_TASKS)[number];

/** Optional score modifiers. `balanced` is today's order. `private` is a hard local filter. */
export const QUALITY_TARGETS = [
  "balanced",
  "fastest",
  "best-quality",
  "cheapest",
  "private",
  "reliable",
  "deep-reasoning",
  "research-grade",
  "local-preferred",
  "cloud-preferred",
  "diverse",
] as const;

export type QualityTarget = (typeof QUALITY_TARGETS)[number];

export const ROUTE_STRATEGIES = [
  "auto",
  "single",
  "fallback",
  "parallel",
  "race",
  "cascade",
  "pipeline",
  "primary-critic",
  "primary-verifier",
  "candidate-judge",
] as const;

export type RouteStrategy = (typeof ROUTE_STRATEGIES)[number];

export interface RoutingRequirements {
  streaming?: boolean;
  structuredOutput?: boolean;
  tools?: boolean;
  json?: boolean;
  vision?: boolean;
  contextK?: number;
  maxLatencyMs?: number;
  locality?: "local" | "cloud" | "any";
  privacy?: "private" | "standard";
  /** Drop inferred evidence for the task capability, not only vision and tools. */
  strictEvidence?: boolean;
  /** Permit name-only evidence for vision and tools. */
  allowInferred?: boolean;
  /** Drop free models whose provider may train on prompts. Default off. */
  strictPrivacy?: boolean;
}

export interface ModelRoutingContract {
  routeMode: RouteMode;
  selectedModelIds: string[];
  selectedProviderIds: string[];
  costPolicy: CostPolicy;
  task: RoutingTask;
  requirements: RoutingRequirements;
  qualityTarget: QualityTarget;
  strategy: RouteStrategy;
}

export const DEFAULT_ROUTING_CONTRACT: ModelRoutingContract = Object.freeze({
  routeMode: "auto",
  selectedModelIds: [],
  selectedProviderIds: [],
  costPolicy: "free-first",
  task: "chat",
  requirements: {},
  qualityTarget: "balanced",
  strategy: "auto",
});

export function normaliseRouteMode(value: unknown): RouteMode {
  const s = String(value || "")
    .toLowerCase()
    .trim();
  return (ROUTE_MODES as readonly string[]).includes(s) ? (s as RouteMode) : "auto";
}

export function normaliseCostPolicy(value: unknown): CostPolicy {
  const s = String(value || "")
    .toLowerCase()
    .trim();
  if (s === "free-preferred") return "free-first";
  if (s === "allow-paid") return "quality-first";
  return (COST_POLICIES as readonly string[]).includes(s) ? (s as CostPolicy) : "free-first";
}

export function normaliseRoutingTask(value: unknown): RoutingTask {
  const s = String(value || "")
    .toLowerCase()
    .trim();
  if (s === "code") return "coding";
  if (s === "embed") return "embeddings";
  return (ROUTING_TASKS as readonly string[]).includes(s) ? (s as RoutingTask) : "chat";
}

export function normaliseQualityTarget(value: unknown): QualityTarget {
  const s = String(value || "")
    .toLowerCase()
    .trim();
  return (QUALITY_TARGETS as readonly string[]).includes(s) ? (s as QualityTarget) : "balanced";
}

export function normaliseStrategy(value: unknown): RouteStrategy {
  const s = String(value || "")
    .toLowerCase()
    .trim();
  return (ROUTE_STRATEGIES as readonly string[]).includes(s) ? (s as RouteStrategy) : "auto";
}

export function normaliseRoutingRequirements(reqs: unknown): RoutingRequirements {
  if (!reqs || typeof reqs !== "object") return {};
  const r = reqs as Record<string, unknown>;
  const out: RoutingRequirements = {};
  if (typeof r["streaming"] === "boolean") out.streaming = r["streaming"];
  if (typeof r["structuredOutput"] === "boolean") out.structuredOutput = r["structuredOutput"];
  if (typeof r["tools"] === "boolean") out.tools = r["tools"];
  if (typeof r["json"] === "boolean") out.json = r["json"];
  if (typeof r["vision"] === "boolean") out.vision = r["vision"];
  if (typeof r["contextK"] === "number" && Number.isFinite(r["contextK"]))
    out.contextK = r["contextK"];
  if (typeof r["maxLatencyMs"] === "number" && Number.isFinite(r["maxLatencyMs"]))
    out.maxLatencyMs = r["maxLatencyMs"];
  if (r["locality"] === "local" || r["locality"] === "cloud" || r["locality"] === "any")
    out.locality = r["locality"];
  if (r["privacy"] === "private" || r["privacy"] === "standard") out.privacy = r["privacy"];
  if (typeof r["strictEvidence"] === "boolean") out.strictEvidence = r["strictEvidence"];
  if (typeof r["allowInferred"] === "boolean") out.allowInferred = r["allowInferred"];
  if (r["strictPrivacy"] === true) out.strictPrivacy = true;
  return out;
}

export function createRoutingContract(
  partial?: Partial<ModelRoutingContract>,
): ModelRoutingContract {
  return {
    routeMode: normaliseRouteMode(partial?.routeMode),
    selectedModelIds: Array.isArray(partial?.selectedModelIds)
      ? partial!.selectedModelIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [],
    selectedProviderIds: Array.isArray(partial?.selectedProviderIds)
      ? partial!.selectedProviderIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [],
    costPolicy: normaliseCostPolicy(partial?.costPolicy),
    task: normaliseRoutingTask(partial?.task),
    requirements: normaliseRoutingRequirements(partial?.requirements),
    qualityTarget: normaliseQualityTarget(partial?.qualityTarget),
    strategy: normaliseStrategy(partial?.strategy),
  };
}

/** Chat and Manual rank for quality. Auto and Voice rank for latency. One pool. */
export type SurfaceRank = "latency-first" | "quality-first";

export function surfaceRank(surface: "voice" | "chat" | "manual" | string): SurfaceRank {
  return surface === "voice" ? "latency-first" : "quality-first";
}

/** A spoken turn stays on one model. A hedged chat still goes through the billing firewall. */
export function hedgeAllowed(surface: "voice" | "chat" | string): boolean {
  return surface !== "voice";
}

const RESTART_OR_SHUTDOWN = /\b(restart|shut\s*down|shutdown)\b/i;

/**
 * Chat and Voice share tools, approval, and route. The surface only changes
 * how the answer is delivered. Restart and shutdown always need approval.
 */
export function sharedTurnPlan(input: {
  surface: "chat" | "voice";
  tools: readonly string[];
  approval: boolean;
  routeMode: string;
  prompt?: string;
}): {
  tools: string[];
  approval: boolean;
  routeMode: string;
  style: "spoken" | "screen";
} {
  const restart = RESTART_OR_SHUTDOWN.test(input.prompt || "");
  return {
    tools: [...input.tools].map((tool) => String(tool)).sort(),
    approval: Boolean(input.approval) || restart,
    routeMode: input.routeMode,
    style: input.surface === "voice" ? "spoken" : "screen",
  };
}

export interface RankedModel {
  id?: string;
  available?: boolean;
  eligible?: boolean;
  latencyMs?: number | null;
  quality?: number | null;
  contextK?: number;
  resident?: boolean;
  priority?: number;
  access?: string;
}

/**
 * Same eligible pool for both surfaces. Voice orders by measured latency.
 * Chat and Manual order by quality, then context. Hidden or ineligible rows
 * never enter the order. A paid row is included only when the caller has
 * already marked it eligible.
 */
export function rankForSurface<T extends RankedModel>(
  models: readonly T[],
  surface: "voice" | "chat" | string,
): T[] {
  const pool = models.filter((model) => model.available !== false && model.eligible !== false);
  const ranked = [...pool];
  const voice = surfaceRank(surface) === "latency-first";
  ranked.sort((a, b) => {
    if (voice) {
      const left = a.latencyMs && a.latencyMs > 0 ? a.latencyMs : Number.POSITIVE_INFINITY;
      const right = b.latencyMs && b.latencyMs > 0 ? b.latencyMs : Number.POSITIVE_INFINITY;
      if (left !== right) return left - right;
    } else {
      const left = a.quality ?? a.contextK ?? 0;
      const right = b.quality ?? b.contextK ?? 0;
      if (left !== right) return right - left;
    }
    const resident = (b.resident ? 1 : 0) - (a.resident ? 1 : 0);
    if (resident !== 0) return resident;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });
  return ranked;
}

/** The typed outcome when no live registry row can answer this turn. The id is always null. */
export const NO_LIVE_MODEL = "no-live-model" as const;

export type NoLiveModelReason = "no-rows" | "none-eligible" | "offline" | "private";

export interface LiveRouteRow extends RankedModel {
  id: string;
  label: string;
  modelName?: string;
  type?: "local" | "cloud";
}

export type LiveRoute =
  | { outcome: "model"; id: string; label: string }
  | { outcome: "auto"; id: null; label: string }
  | { outcome: typeof NO_LIVE_MODEL; id: null; label: string; reason: NoLiveModelReason };

/**
 * The one place a turn's model is resolved against the live registry, for chat and for voice.
 * Only a live row that is available and eligible (the billing gate already applied by the registry) is
 * ever returned. A private turn takes local rows only; offline takes local rows only. A static
 * catalogue id that no live row confirms is never returned: with nothing live the outcome is
 * `no-live-model`. Surfaces differ only in the order of the pool.
 */
export function resolveLiveRoute(input: {
  live: { models: readonly LiveRouteRow[]; selected: readonly string[]; routeMode: string };
  routing: Readonly<Record<string, string | null | undefined>>;
  task: string;
  surface: "voice" | "chat" | string;
  privacy?: "private" | "standard";
  offline?: boolean;
}): LiveRoute {
  const { live, routing, task, surface } = input;
  const usable = live.models.filter((m) => {
    if (!m.available || !m.eligible) return false;
    if (m.type === "cloud" && (input.privacy === "private" || input.offline)) return false;
    return true;
  });
  const none = (): LiveRoute => {
    const cloudOnlyBlocked = live.models.some(
      (m) => m.available && m.eligible && m.type === "cloud",
    );
    const reason: NoLiveModelReason =
      live.models.length === 0
        ? "no-rows"
        : cloudOnlyBlocked && input.privacy === "private"
          ? "private"
          : cloudOnlyBlocked && input.offline
            ? "offline"
            : "none-eligible";
    return { outcome: NO_LIVE_MODEL, id: null, label: "no live model", reason };
  };
  if (usable.length === 0) return none();
  const find = (ref: string) => usable.find((m) => m.id === ref || m.modelName === ref);
  if (live.routeMode === "auto" && live.selected.length === 0) {
    return { outcome: "auto", id: null, label: "Auto" };
  }
  for (const ref of live.selected) {
    const picked = find(ref);
    if (picked) return { outcome: "model", id: picked.id, label: picked.label };
  }
  const candidate = routing[task] ?? routing["brain"];
  const match = candidate ? find(candidate) : undefined;
  if (match) return { outcome: "model", id: match.id, label: match.label };
  const first = rankForSurface(usable, surface)[0];
  return first ? { outcome: "model", id: first.id, label: first.label } : none();
}

type OwnerLanguage = "en" | "hi" | "hinglish";

/** Devanagari is Hindi; Roman Hindi words are Hinglish; the rest English. Reuses the two language helpers. */
function ownerLanguage(prompt: string): OwnerLanguage {
  const id = languageId(prompt);
  if (id !== "en") return id;
  return replyLanguage(prompt) === "hi" ? "hinglish" : "en";
}

const NO_LIVE_LINES: Record<NoLiveModelReason, Record<OwnerLanguage, string>> = {
  "no-rows": {
    en: "No AI model is reachable right now, so I can't answer this one; connect or start a model in Models.",
    hi: "अभी कोई एआई मॉडल जुड़ा नहीं है, इसलिए मैं इसका जवाब नहीं दे सकती; मॉडल्स में कोई मॉडल जोड़ें या शुरू करें।",
    hinglish:
      "Abhi koi AI model connected nahi hai, isliye main iska jawab nahi de sakti; Models mein model jodo ya start karo.",
  },
  "none-eligible": {
    en: "No model I'm allowed to use is ready (paid models are off), so I can't answer this one; start a local or free model in Models.",
    hi: "अभी कोई ऐसा मॉडल तैयार नहीं है जिसे मैं इस्तेमाल कर सकूँ (पेड मॉडल बंद हैं); मॉडल्स में लोकल या फ्री मॉडल शुरू करें।",
    hinglish:
      "Abhi koi allowed model ready nahi hai (paid models band hain), isliye main jawab nahi de sakti; Models mein local ya free model start karo.",
  },
  offline: {
    en: "You're offline and no local model is ready, so I can't answer this one; start a local model in Models.",
    hi: "आप ऑफ़लाइन हैं और कोई लोकल मॉडल तैयार नहीं है, इसलिए मैं जवाब नहीं दे सकती; मॉडल्स में लोकल मॉडल शुरू करें।",
    hinglish:
      "Aap offline ho aur koi local model ready nahi hai, isliye main jawab nahi de sakti; Models mein local model start karo.",
  },
  private: {
    en: "This line is private and must stay on this PC, but no local model is ready; start one in Models.",
    hi: "यह बात निजी है और इसी पीसी पर रहनी चाहिए, पर कोई लोकल मॉडल तैयार नहीं है; मॉडल्स में एक शुरू करें।",
    hinglish:
      "Yeh baat private hai aur is PC par hi rehni chahiye, par koi local model ready nahi hai; Models mein ek start karo.",
  },
};

/** One plain line, in the language the owner wrote, for a turn that has no live model. */
export function noLiveModelLine(prompt: string, reason: NoLiveModelReason): string {
  return NO_LIVE_LINES[reason][ownerLanguage(prompt)];
}

export function validateRoutingContract(contract: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!contract || typeof contract !== "object") {
    return { ok: false, errors: ["Routing contract must be an object"] };
  }
  const c = contract as Record<string, unknown>;
  if (!c["routeMode"] || !(ROUTE_MODES as readonly string[]).includes(String(c["routeMode"]))) {
    errors.push(`Invalid routeMode: ${String(c["routeMode"])}`);
  }
  if (c["costPolicy"] && !(COST_POLICIES as readonly string[]).includes(String(c["costPolicy"]))) {
    errors.push(`Invalid costPolicy: ${String(c["costPolicy"])}`);
  }
  if (c["task"] && !(ROUTING_TASKS as readonly string[]).includes(String(c["task"]))) {
    errors.push(`Invalid task: ${String(c["task"])}`);
  }
  if (c["selectedModelIds"] !== undefined && !Array.isArray(c["selectedModelIds"])) {
    errors.push("selectedModelIds must be an array of strings");
  }
  if (c["selectedProviderIds"] !== undefined && !Array.isArray(c["selectedProviderIds"])) {
    errors.push("selectedProviderIds must be an array of strings");
  }
  if (
    c["qualityTarget"] !== undefined &&
    !(QUALITY_TARGETS as readonly string[]).includes(String(c["qualityTarget"]))
  ) {
    errors.push(`Invalid qualityTarget: ${String(c["qualityTarget"])}`);
  }
  if (
    c["strategy"] !== undefined &&
    !(ROUTE_STRATEGIES as readonly string[]).includes(String(c["strategy"]))
  ) {
    errors.push(`Invalid strategy: ${String(c["strategy"])}`);
  }
  return { ok: errors.length === 0, errors };
}
