/**
 * FRIDAY · Authoritative Model Routing Contract.
 *
 * Single shared contract used across UI/manual selection, Brain, Electron,
 * model-router, and Kernel. Every inference request passes through this
 * exact structure so no layer can silently translate or downgrade routing mode.
 */

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
