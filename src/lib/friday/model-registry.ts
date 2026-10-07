/**
 * FRIDAY · dynamic model registry (renderer).
 *
 * The single data source for the chat model selector. Nothing here is
 * hard-coded: it mirrors what the main process really detected — local
 * runtimes, downloaded models and cloud providers whose key answered a real
 * API call — together with each model's free/paid classification and live
 * health.
 *
 * Refresh happens on start, when provider settings change, when a key is
 * added or removed, when a model reports a health change, when the selector
 * opens and, gently, in the background. Results are cached so opening the
 * menu never costs a round of discovery.
 */
import { readLocalState, writeState } from "./persist";
import {
  type ModelRoutingContract,
  type QualityTarget,
  type RouteStrategy,
  type RoutingTask,
  type RoutingRequirements,
  createRoutingContract,
  normaliseCostPolicy,
  normaliseQualityTarget,
  normaliseStrategy,
  QUALITY_TARGETS,
  ROUTE_STRATEGIES,
} from "./model-routing-contract";

export type ModelAccess = "free" | "paid" | "unknown";
export type UsagePolicy = "free-only" | "free-preferred" | "allow-paid" | "paid-only";

/**
 * The routing modes the main-process router (electron/model-router.cjs)
 * really implements. This list mirrors its ROUTE_MODES constant — the router
 * stays the authority, this is only the owner-facing vocabulary.
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

export const ROUTE_MODE_LABELS: Record<RouteMode, string> = {
  auto: "Auto",
  "local-only": "Local only",
  "cloud-only": "Cloud only",
  hybrid: "Hybrid",
  manual: "Manual (one picked model)",
  multi: "Multi (run picked models together)",
};

export const ROUTE_MODE_HINTS: Record<RouteMode, string> = {
  auto: "FRIDAY picks, free first",
  "local-only": "Never leaves this PC",
  "cloud-only": "Skip local runtimes",
  hybrid: "Local first, cloud as backup",
  manual: "Your pick, with fallback",
  multi: "Your picks run in parallel",
};

/** Modes where the owner's explicit picks ARE the pool. */
export const MODES_NEEDING_PICKS = new Set<RouteMode>(["manual", "multi"]);

export { QUALITY_TARGETS, ROUTE_STRATEGIES };
export type { QualityTarget, RouteStrategy };

export const QUALITY_TARGET_LABELS: Record<QualityTarget, string> = {
  balanced: "Balanced",
  fastest: "Fastest",
  "best-quality": "Best quality",
  cheapest: "Cheapest",
  private: "Private",
  reliable: "Reliable",
  "deep-reasoning": "Deep reasoning",
  "research-grade": "Research",
  "local-preferred": "Local preferred",
  "cloud-preferred": "Cloud preferred",
  diverse: "Diverse",
};

export const ROUTE_STRATEGY_LABELS: Record<RouteStrategy, string> = {
  auto: "Auto",
  single: "Single",
  fallback: "Fallback",
  parallel: "Parallel",
  race: "Race",
  cascade: "Cascade",
  pipeline: "Pipeline",
  "primary-critic": "Critic",
  "primary-verifier": "Verifier",
  "candidate-judge": "Judge",
};

export type RegistryModel = {
  id: string;
  label: string;
  provider: string;
  providerId: string;
  providerModelId?: string;
  displayName?: string;
  canonicalModelId?: string;
  endpoint?: string;
  wireProtocol?: string;
  kind?: "local" | "cloud";
  capabilities?: Record<string, unknown>;
  pricing?: Record<string, unknown> | null;
  entitlement?: string | null;
  verification?: string;
  lastSeen?: number;
  lastVerified?: number;
  modelName: string;
  type: "local" | "cloud";
  access: ModelAccess;
  role: string;
  contextK: number;
  available: boolean;
  eligible: boolean;
  health: string;
  healthCategory: string | null;
  coolingDown: boolean;
  cooldownUntil: number;
  latencyMs: number | null;
  priority: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  resident: boolean;
  sizeGb: number;
  /** Selector fields from usableModels(). Absent on an older snapshot. */
  providerName?: string;
  choiceLabel?: string;
  badge?: string;
  visibility?: "show" | "disabled" | "hide";
  disabledReason?: string | null;
  /** Why a row is hidden. The chat selector does not render hidden rows. */
  reason?: string | null;
  marks?: string[];
};

export type RegistryState = {
  at: number;
  loading: boolean;
  policy: UsagePolicy;
  models: RegistryModel[];
  /** Explicit picks. Empty = Auto (the router decides). */
  selected: string[];
  /** Local/cloud/auto/manual/multi routing, shared with the main router. */
  routeMode: RouteMode;
  /** Score modifier. Balanced keeps today's order. Private stays on this PC. */
  qualityTarget: QualityTarget;
  /** How a multi run is shaped. Auto keeps today's parallel collaboration. */
  strategy: RouteStrategy;
  /**
   * Model menus show installed / reachable models only by default; this
   * opens the full catalog for advanced use.
   */
  showAll: boolean;
  error: string | null;
  hint: string;
};

/** Narrow view of the desktop bridge this store needs (absent in the browser). */
type RegistryBridge = {
  modelRegistry?: (
    force?: boolean,
  ) => Promise<{ at: number; policy: string; models: unknown[]; hint?: string }>;
  setModelUsagePolicy?: (policy: string) => Promise<unknown>;
  modelRouteMode?: () => Promise<{ mode: string }>;
  setModelRouteMode?: (mode: string) => Promise<{ mode: string }>;
  modelQualityTarget?: () => Promise<{ qualityTarget: string }>;
  setModelQualityTarget?: (value: string) => Promise<{ qualityTarget: string }>;
  modelRouteStrategy?: () => Promise<{ strategy: string }>;
  setModelRouteStrategy?: (value: string) => Promise<{ strategy: string }>;
  modelSelection?: () => Promise<{ ids?: string[] }>;
  setModelSelection?: (ids: string[]) => Promise<{ ids?: string[] }>;
  onModelRegistryChanged?: (cb: () => void) => () => void;
  onModelHealthChanged?: (cb: () => void) => () => void;
  onModelPolicy?: (cb: () => void) => () => void;
};

const bridge = (): RegistryBridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: RegistryBridge }).friday ?? null);

const SELECTION_KEY = "friday.models.selection.v1";
const ROUTE_MODE_KEY = "friday.models.route-mode.v1";
const QUALITY_TARGET_KEY = "friday.models.quality-target.v1";
const ROUTE_STRATEGY_KEY = "friday.models.route-strategy.v1";
const SHOW_ALL_KEY = "friday.models.show-all.v1";
const FRESH_MS = 20_000;
const BACKGROUND_MS = 120_000;

export const normaliseRouteMode = (value: unknown): RouteMode =>
  ROUTE_MODES.includes(value as RouteMode) ? (value as RouteMode) : "auto";

const empty: RegistryState = {
  at: 0,
  loading: false,
  policy: "free-preferred",
  models: [],
  selected: [],
  routeMode: "auto",
  qualityTarget: "balanced",
  strategy: "auto",
  showAll: false,
  error: null,
  hint: "",
};

class ModelRegistryStore {
  private state: RegistryState = empty;
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wired = false;

  getSnapshot = (): RegistryState => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    this.start();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  };

  private emit(patch: Partial<RegistryState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  /** Boot: restore the owner's picks, discover once, then keep it warm. */
  private start() {
    if (this.wired) {
      if (!this.timer && typeof window !== "undefined") {
        this.timer = setInterval(() => void this.refresh(), BACKGROUND_MS);
      }
      return;
    }
    this.wired = true;
    if (typeof window === "undefined") return;
    const saved = readLocalState<string[]>(SELECTION_KEY);
    if (Array.isArray(saved)) this.state = { ...this.state, selected: saved };
    const savedMode = readLocalState<string>(ROUTE_MODE_KEY);
    if (savedMode) this.state = { ...this.state, routeMode: normaliseRouteMode(savedMode) };
    const savedQuality = readLocalState<string>(QUALITY_TARGET_KEY);
    if (savedQuality) {
      this.state = { ...this.state, qualityTarget: normaliseQualityTarget(savedQuality) };
    }
    const savedStrategy = readLocalState<string>(ROUTE_STRATEGY_KEY);
    if (savedStrategy) this.state = { ...this.state, strategy: normaliseStrategy(savedStrategy) };
    if (readLocalState<boolean>(SHOW_ALL_KEY) === true) {
      this.state = { ...this.state, showAll: true };
    }
    // The main-process router is the authority: adopt whatever it has stored.
    void bridge()
      ?.modelRouteMode?.()
      .then((result) => this.emit({ routeMode: normaliseRouteMode(result?.mode) }))
      .catch(() => undefined);
    void bridge()
      ?.modelQualityTarget?.()
      .then((result) => this.emit({ qualityTarget: normaliseQualityTarget(result?.qualityTarget) }))
      .catch(() => undefined);
    void bridge()
      ?.modelRouteStrategy?.()
      .then((result) => this.emit({ strategy: normaliseStrategy(result?.strategy) }))
      .catch(() => undefined);
    void bridge()
      ?.modelSelection?.()
      .then((result) => {
        if (Array.isArray(result?.ids)) this.emit({ selected: result.ids.filter(Boolean) });
      })
      .catch(() => undefined);

    const api = bridge();
    api?.onModelRegistryChanged?.(() => void this.refresh(true));
    api?.onModelHealthChanged?.(() => void this.refresh(true));
    api?.onModelPolicy?.(() => void this.refresh(true));
    void this.refresh(true);
    this.timer = setInterval(() => void this.refresh(), BACKGROUND_MS);
  }

  /** Discovery, de-duplicated and cached. `force` skips the freshness check. */
  refresh = async (force = false): Promise<void> => {
    if (typeof window === "undefined") return;
    const api = bridge();
    if (!api?.modelRegistry) return;
    if (!force && Date.now() - this.state.at < FRESH_MS) return;
    if (this.inFlight) return this.inFlight;
    this.emit({ loading: true });
    this.inFlight = (async () => {
      try {
        const result = await api.modelRegistry!(force);
        const models = (result?.models ?? []) as RegistryModel[];
        // Drop picks that no longer exist (model removed, key deleted).
        const live = new Set(models.map((m) => m.id));
        const selected = this.state.selected.filter((id) => live.has(id));
        this.emit({
          at: result?.at || Date.now(),
          policy: (result?.policy as UsagePolicy) || "free-preferred",
          models,
          selected,
          hint: String(result?.hint || ""),
          error: null,
          loading: false,
        });
      } catch (error) {
        this.emit({
          loading: false,
          error: error instanceof Error ? error.message : "model discovery failed",
        });
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  };

  /** Multi-select: an explicit pool for the router, or Auto when empty. */
  toggle(id: string) {
    // "manual" is a single-model mode in the router, so picking there swaps
    // the choice instead of growing the pool.
    const single = this.state.routeMode === "manual";
    const has = this.state.selected.includes(id);
    const selected = single
      ? has
        ? []
        : [id]
      : has
        ? this.state.selected.filter((x) => x !== id)
        : [...this.state.selected, id];
    this.emit({ selected });
    writeState(SELECTION_KEY, selected);
    void bridge()
      ?.setModelSelection?.(selected)
      ?.catch(() => undefined);
  }

  /** Auto mode: hand the routing decision back to the free-first router. */
  clearSelection() {
    this.emit({ selected: [] });
    writeState(SELECTION_KEY, []);
    void bridge()
      ?.setModelSelection?.([])
      ?.catch(() => undefined);
  }

  /** Routing mode — persisted here AND pushed to the main-process router. */
  async setRouteMode(mode: RouteMode) {
    const next = normaliseRouteMode(mode);
    this.emit({ routeMode: next });
    writeState(ROUTE_MODE_KEY, next);
    try {
      const result = await bridge()?.setModelRouteMode?.(next);
      if (result?.mode) this.emit({ routeMode: normaliseRouteMode(result.mode) });
    } catch {
      /* offline / browser preview: the local choice still stands */
    }
    await this.refresh(false);
  }

  routeMode(): RouteMode {
    return this.state.routeMode;
  }

  async setQualityTarget(value: QualityTarget) {
    const next = normaliseQualityTarget(value);
    this.emit({ qualityTarget: next });
    writeState(QUALITY_TARGET_KEY, next);
    try {
      const result = await bridge()?.setModelQualityTarget?.(next);
      if (result?.qualityTarget) {
        this.emit({ qualityTarget: normaliseQualityTarget(result.qualityTarget) });
      }
    } catch {
      /* offline / browser preview: the local choice still stands */
    }
  }

  async setStrategy(value: RouteStrategy) {
    const next = normaliseStrategy(value);
    this.emit({ strategy: next });
    writeState(ROUTE_STRATEGY_KEY, next);
    try {
      const result = await bridge()?.setModelRouteStrategy?.(next);
      if (result?.strategy) this.emit({ strategy: normaliseStrategy(result.strategy) });
    } catch {
      /* offline / browser preview: the local choice still stands */
    }
  }

  /** Installed-only (default) vs the whole catalog in the model menus. */
  setShowAll(showAll: boolean) {
    this.emit({ showAll });
    writeState(SHOW_ALL_KEY, showAll);
  }

  isAuto(): boolean {
    return this.state.selected.length === 0;
  }

  /** The ids to pin for the next turn ([] = Auto). */
  selectedIds(): string[] {
    return [...this.state.selected];
  }

  async setPolicy(policy: UsagePolicy) {
    this.emit({ policy });
    await bridge()?.setModelUsagePolicy?.(policy);
    await this.refresh(true);
  }

  getRoutingContract(
    task: RoutingTask = "chat",
    requirements: RoutingRequirements = {},
  ): ModelRoutingContract {
    return createRoutingContract({
      routeMode: this.state.routeMode,
      selectedModelIds: [...this.state.selected],
      costPolicy: normaliseCostPolicy(this.state.policy),
      task,
      requirements,
      qualityTarget: this.state.qualityTarget,
      strategy: this.state.strategy,
    });
  }
}

/**
 * Label the conversation header with the engine that will (or did) answer.
 *
 * The models-engine routing table (`routing.brain`) is a static default and
 * must not be shown as the live engine. Prefer the run's real model id; fall
 * back to the owner's picks, or Auto before a turn is sent.
 * `will` is the model that will answer. `used` is the model that did.
 */
export function conversationEngineLabel(input: {
  routeMode: RouteMode;
  selected: string[];
  models: RegistryModel[];
  liveLabel?: string | undefined;
  phase?: "will" | "used";
}): string {
  const live = String(input.liveLabel || "").trim();
  const labels = input.selected
    .map((id) => {
      const model = input.models.find((item) => item.id === id);
      return model?.choiceLabel || model?.label || id;
    })
    .filter(Boolean);
  const planned =
    input.routeMode === "auto" && input.selected.length === 0
      ? "Auto"
      : labels.length === 1
        ? labels[0]!
        : labels.length > 1
          ? labels.join(" + ")
          : ROUTE_MODE_HINTS[input.routeMode];
  if (input.phase === "used") return `used ${live || planned}`;
  if (input.phase === "will") return `will use ${planned}`;
  if (live) return live;
  return planned;
}

export const modelRegistry = new ModelRegistryStore();

/**
 * The same "Installed" rule the /models page applies, in one place: a model
 * counts as installed/active when discovery found it locally present or its
 * cloud provider answered a real call. Anything else is catalog-only.
 */
export const isInstalledModel = (m: RegistryModel): boolean => m.available;

/** Selector groups: Local first, then one group per provider display name. */
export function groupModels(models: RegistryModel[], showAll = false) {
  const pool = models.filter((model) => {
    if (model.visibility === "hide") return false;
    if (model.visibility === "show" || model.visibility === "disabled") return true;
    if (!showAll && model.type === "cloud" && !model.eligible && !model.coolingDown) return false;
    return showAll || model.available || model.coolingDown;
  });
  const byPriority = (a: RegistryModel, b: RegistryModel) => b.priority - a.priority;
  const local = pool.filter((model) => model.type === "local").sort(byPriority);
  const groups: { label: string; models: RegistryModel[] }[] = [];
  if (local.length) groups.push({ label: "Local", models: local });
  const names: string[] = [];
  const buckets = new Map<string, RegistryModel[]>();
  for (const model of pool) {
    if (model.type === "local") continue;
    const name = model.providerName || model.providerId || "Cloud";
    if (!buckets.has(name)) {
      buckets.set(name, []);
      names.push(name);
    }
    buckets.get(name)?.push(model);
  }
  for (const name of names) {
    const rows = buckets.get(name) || [];
    if (rows.length) groups.push({ label: name, models: [...rows].sort(byPriority) });
  }
  return groups;
}
