/**
 * FRIDAY · model capability registry
 *
 * One place that knows every model FRIDAY can actually use right now — the
 * local models discovered on this PC and the cloud models whose provider is
 * configured — together with what each one is good at and how it has behaved
 * in practice.
 *
 * Capability facts come from the catalog and from the live models engine
 * (installed, runtimes, benchmarks, provider probes). Performance facts are
 * measured by FRIDAY itself and persisted, so the registry keeps improving
 * across restarts. Nothing here is invented: a model with no measurements
 * simply has none, and the orchestrator treats it as unproven.
 */

import {
  modelById,
  modelCatalog,
  routeRefs,
  type ModelSpec,
  type ProviderId,
} from "../model-catalog";
import { modelRegistry as usageRegistry } from "../model-registry";
import { models } from "../models-engine";
import { readLocalState, restoreFromDisk, writeState } from "../persist";
import { CONFIDENT_THRESHOLD } from "./confidence";

/** Extra ranking weight when a local model has already beaten the domain threshold. */
export const PROVEN_LOCAL_BOOST = 2.4;

export type ModelRole =
  "planner" | "coder" | "reviewer" | "tester" | "reasoner" | "fast" | "vision" | "audio";

export type ModelPerformance = {
  modelId: string;
  runs: number;
  successes: number;
  failures: number;
  /** Rolling averages over completed runs. */
  avgMs: number;
  avgTokensPerSec: number;
  lastUsedAt: number | null;
  lastError: string | null;
};

export type ModelCapabilityRecord = {
  id: string;
  name: string;
  version: string;
  provider: ProviderId;
  kind: "local" | "cloud";
  /** Roles this model is genuinely suited to, strongest first. */
  roles: ModelRole[];
  contextK: number;
  vision: boolean;
  audio: boolean;
  tools: boolean;
  /** Measured tokens/sec when FRIDAY has benchmarked or run it, else null. */
  speed: number | null;
  /** GB of VRAM/RAM the model wants; 0 for hosted models. */
  vramGb: number;
  ramGb: number;
  sizeGb: number;
  /** "free" for local models, "metered" for cloud models. */
  cost: "free" | "metered";
  available: boolean;
  availability: string;
  /** Live main-process health when the usage registry has seen this model. */
  health?: string;
  healthCategory?: string | null;
  /** True while the desktop router has this endpoint in cooldown. */
  coolingDown?: boolean;
  /** 0–1 from real runs; null until FRIDAY has used it. */
  reliability: number | null;
  performance: ModelPerformance | null;
};

/** Live health rows from the usage registry / main-process router. */
export type LiveModelHealth = {
  id: string;
  modelName?: string;
  coolingDown?: boolean;
  health?: string;
  healthCategory?: string | null;
};

const normId = (value: string): string =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * Overlay desktop router cooldowns onto catalog records. Catalog ids
 * (`qwen2.5-32b`) rarely equal engine tags (`ollama:qwen2.5:32b`), so matching
 * uses `routeRefs` plus the same normalised-name fallback the engine matcher
 * already uses. Empty live input is a no-op — tests and preview stay honest.
 */
export function withLiveHealth(
  records: ModelCapabilityRecord[],
  live: LiveModelHealth[],
): ModelCapabilityRecord[] {
  if (!live.length) return records;
  const byKey = new Map<string, LiveModelHealth>();
  const add = (key: string | undefined, row: LiveModelHealth) => {
    const raw = String(key || "").trim();
    if (!raw) return;
    if (!byKey.has(raw)) byKey.set(raw, row);
    const n = normId(raw);
    if (n && !byKey.has(n)) byKey.set(n, row);
  };
  for (const row of live) {
    add(row.id, row);
    add(row.modelName, row);
  }
  return records.map((record) => {
    const refs = [record.id, ...routeRefs([record.id])];
    let hit: LiveModelHealth | undefined;
    for (const ref of refs) {
      hit = byKey.get(ref) ?? byKey.get(normId(ref));
      if (hit) break;
    }
    if (!hit) return record;
    const coolingDown = Boolean(hit.coolingDown);
    return {
      ...record,
      coolingDown,
      ...(hit.health ? { health: hit.health } : {}),
      healthCategory: hit.healthCategory ?? null,
      availability: coolingDown
        ? `cooling down${hit.healthCategory ? ` (${hit.healthCategory})` : ""}`
        : record.availability,
    };
  });
}

/** Installed/configured AND not in provider cooldown — the orchestrator's pool. */
export function isRoutable(record: ModelCapabilityRecord): boolean {
  return record.available && !record.coolingDown;
}

function liveHealthRows(): LiveModelHealth[] {
  try {
    const rows = usageRegistry.getSnapshot().models ?? [];
    return rows.map((row) => ({
      id: row.id,
      modelName: row.modelName,
      coolingDown: row.coolingDown,
      health: row.health,
      healthCategory: row.healthCategory,
    }));
  } catch {
    return [];
  }
}

const STORAGE_KEY = "friday.models.performance.v1";

const emptyPerf = (modelId: string): ModelPerformance => ({
  modelId,
  runs: 0,
  successes: 0,
  failures: 0,
  avgMs: 0,
  avgTokensPerSec: 0,
  lastUsedAt: null,
  lastError: null,
});

/** Catalog category → the roles a model of that category can carry. */
function rolesFor(spec: ModelSpec): ModelRole[] {
  const roles: ModelRole[] = [];
  switch (spec.category) {
    case "Coding":
      roles.push("coder", "reviewer", "tester");
      break;
    case "Reasoning":
      roles.push("reasoner", "planner", "reviewer");
      break;
    case "Chat":
      roles.push("planner", "reviewer");
      break;
    case "Vision":
    case "Multimodal":
      roles.push("vision");
      break;
    case "Speech to Text":
    case "Text to Speech":
      roles.push("audio");
      break;

    default:
      break;
  }
  if (spec.caps.includes("vision") && !roles.includes("vision")) roles.push("vision");
  if (spec.caps.includes("audio") && !roles.includes("audio")) roles.push("audio");
  // Small models answer quickly; that is a capability of its own.
  if (spec.sizeGb > 0 && spec.sizeGb <= 6 && !roles.includes("fast")) roles.push("fast");
  return roles;
}

/**
 * Ranking used by `candidates()`. Extracted so tests can prove a measured
 * local model outranks cloud when its reliability already beats the domain
 * confidence threshold — without needing a live installed pool.
 */
export function scoreForRole(
  record: ModelCapabilityRecord,
  role: ModelRole,
  options: { preferLocal?: boolean; vramGb?: number; ramGb?: number } = {},
): number {
  const preferLocal = options.preferLocal ?? true;
  const index = record.roles.indexOf(role);
  let score = 0;
  if (index >= 0) score += (3 - index) * 0.6;
  if (preferLocal && record.kind === "local") score += 1.2;
  // Proven behaviour outranks assumptions, in both directions.
  if (record.reliability !== null) score += (record.reliability - 0.5) * 2;
  // Local-first economics: a local model that already meets CONFIDENT_THRESHOLD
  // must outrank an otherwise similar cloud candidate before cost-policy runs.
  if (
    preferLocal &&
    record.kind === "local" &&
    record.reliability !== null &&
    record.reliability >= CONFIDENT_THRESHOLD
  ) {
    score += PROVEN_LOCAL_BOOST;
  }
  if (record.speed) score += Math.min(1, record.speed / 80);
  if (record.performance?.avgMs) {
    score += Math.min(0.35, 400 / Math.max(80, record.performance.avgMs));
  }
  if (record.kind === "local") score += 0.15;
  if (record.cost === "free") score += 0.1;
  if (record.vision && role === "vision") score += 0.4;
  if (record.audio && role === "audio") score += 0.4;
  if (record.kind === "local" && record.vramGb > (options.vramGb ?? Infinity)) score -= 1.5;
  if (record.kind === "local" && record.ramGb > (options.ramGb ?? Infinity)) score -= 2;
  if (record.contextK >= 64) score += 0.2;
  if (record.performance) {
    const wins = record.performance.successes;
    const runs = Math.max(1, record.performance.runs);
    score += Math.min(0.35, (wins / runs) * 0.35);
  }
  // Same order of magnitude as electron/model-router.cjs: a cooling endpoint
  // must not win just because its catalog score is otherwise high.
  if (record.coolingDown) score -= 50;
  return score;
}

class ModelRegistry {
  private perf = new Map<string, ModelPerformance>();
  private listeners = new Set<() => void>();
  private snapshot: ModelCapabilityRecord[] = [];
  private snapshotAt = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    const stop = models.subscribe(() => {
      this.snapshotAt = 0;
      fn();
    });
    return () => {
      this.listeners.delete(fn);
      stop();
    };
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    const local = readLocalState<ModelPerformance[]>(STORAGE_KEY);
    if (Array.isArray(local)) local.forEach((row) => this.perf.set(row.modelId, row));
    restoreFromDisk<ModelPerformance[]>(STORAGE_KEY, (disk) => {
      if (!Array.isArray(disk) || !disk.length) return;
      disk.forEach((row) => this.perf.set(row.modelId, row));
      this.snapshotAt = 0;
      this.listeners.forEach((fn) => fn());
    });
  }

  private save() {
    if (typeof window === "undefined" || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeState(STORAGE_KEY, [...this.perf.values()]);
    }, 600);
  }

  /** Every model FRIDAY knows about, with live availability and measurements. */
  list(): ModelCapabilityRecord[] {
    this.load();
    const state = models.getSnapshot();
    // Recompute the catalog snapshot at most a few times per second; live
    // cooldown overlay always re-reads the usage registry so a 429 is not
    // planned as "best" for the rest of that window.
    if (!(this.snapshot.length && Date.now() - this.snapshotAt < 400)) {
      const imported = state.imported.map((item) => item.id);
      const records = modelCatalog.map((spec) => {
        const installed = state.installed[spec.id] ?? null;
        const provider = state.providerState[spec.provider];
        const benchmark = state.benchmarks[spec.id];
        const runtime = state.runtimes[spec.id];
        const perf = this.perf.get(spec.id) ?? null;

        const local = spec.kind === "local";
        const available = local
          ? Boolean(installed) || imported.includes(spec.id)
          : Boolean(provider?.online && provider?.apiKey);
        const availability = available
          ? local
            ? `installed ${installed ?? "(imported)"}`
            : "provider online"
          : local
            ? "not installed"
            : provider?.apiKey
              ? (provider.error ?? "provider offline")
              : "no API key configured";

        const speed =
          benchmark?.tokensPerSec ?? runtime?.tokensPerSec ?? perf?.avgTokensPerSec ?? 0;
        const reliability =
          perf && perf.runs > 0 ? Number((perf.successes / perf.runs).toFixed(3)) : null;

        return {
          id: spec.id,
          name: spec.name,
          version: spec.version,
          provider: spec.provider,
          kind: spec.kind,
          roles: rolesFor(spec),
          contextK: spec.ctxK,
          vision: spec.caps.includes("vision"),
          audio: spec.caps.includes("audio"),
          tools: spec.caps.includes("tools"),
          speed: speed > 0 ? Number(speed.toFixed(1)) : null,
          vramGb: spec.vramGb,
          ramGb: spec.ramGb,
          sizeGb: spec.sizeGb,
          cost: local ? "free" : "metered",
          available,
          availability,
          reliability,
          performance: perf,
        } satisfies ModelCapabilityRecord;
      });

      this.snapshot = records;
      this.snapshotAt = Date.now();
    }
    return withLiveHealth(this.snapshot, liveHealthRows());
  }

  available(): ModelCapabilityRecord[] {
    return this.list().filter(isRoutable);
  }

  get(modelId: string): ModelCapabilityRecord | null {
    return this.list().find((record) => record.id === modelId) ?? null;
  }

  /** Candidates for a role, best first, according to what FRIDAY has measured. */
  candidates(role: ModelRole, options: { preferLocal?: boolean } = {}): ModelCapabilityRecord[] {
    const system = models.getSnapshot().system;
    const preferLocal = options.preferLocal ?? true;
    return this.available()
      .filter((record) => record.roles.includes(role))
      .map((record) => ({
        record,
        score: scoreForRole(record, role, {
          preferLocal,
          vramGb: system.vramGb,
          ramGb: system.ramGb,
        }),
      }))
      .sort((a, b) => b.score - a.score)
      .map((row) => row.record);
  }

  /** Record what really happened, so the next choice is better informed. */
  recordRun(input: {
    modelId: string;
    ok: boolean;
    ms: number;
    tokensPerSec?: number;
    error?: string;
  }): ModelPerformance {
    this.load();
    const perf = this.perf.get(input.modelId) ?? emptyPerf(input.modelId);
    const runs = perf.runs + 1;
    perf.runs = runs;
    if (input.ok) perf.successes += 1;
    else perf.failures += 1;
    perf.avgMs = Math.round(perf.avgMs + (input.ms - perf.avgMs) / runs);
    if (input.tokensPerSec && input.tokensPerSec > 0) {
      perf.avgTokensPerSec = Number(
        (perf.avgTokensPerSec + (input.tokensPerSec - perf.avgTokensPerSec) / runs).toFixed(1),
      );
    }
    perf.lastUsedAt = Date.now();
    perf.lastError = input.ok ? null : (input.error ?? "unknown failure");
    this.perf.set(input.modelId, perf);
    this.snapshotAt = 0;
    this.listeners.forEach((fn) => fn());
    this.save();
    return perf;
  }

  performance(): ModelPerformance[] {
    this.load();
    return [...this.perf.values()].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  }

  /** Human label for a model id, falling back to the id itself. */
  label(modelId: string): string {
    return modelById.get(modelId)?.name ?? modelId;
  }
}

export const modelRegistry = new ModelRegistry();
