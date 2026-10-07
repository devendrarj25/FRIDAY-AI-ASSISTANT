/**
 * FRIDAY · Provider Registry (authoritative).
 *
 * ONE canonical view of every AI provider FRIDAY knows about — local engines
 * and cloud APIs alike — used by System Status, the Models page, chat routing,
 * Auto mode, Diagnostics, Install Manager and startup so no two screens can
 * disagree about what is configured, reachable or healthy.
 *
 * `buildRegistry` is pure: it takes the real inventory that
 * `electron/models.cjs` collected, the stored key ids, the environment and the
 * router health snapshot, and derives the record. No HTTP, no Electron — the
 * unit tests drive exactly the same function the app runs.
 *
 * Secrets never enter a record: only WHETHER a key exists and where it came
 * from is reported, never the key itself.
 */

const modelAccess = require("./model-access.cjs");

const LOCAL_PROVIDER_IDS = new Set([
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
  "localai",
  "jan",
  "mlx",
  "local",
]);

/** Route modes. Each one decides which provider kinds may serve a request. */
const MODES = ["local-only", "cloud-only", "hybrid", "auto", "multi"];
const DEFAULT_MODE = "auto";
const normaliseMode = (value) => (MODES.includes(value) ? value : DEFAULT_MODE);

/**
 * Which provider kinds a mode allows. `auto`/`hybrid`/`multi` allow both, so a
 * cloud-only owner is never told to install Ollama, and a local-only owner
 * never has a request leave the machine.
 */
function kindsForMode(mode) {
  switch (normaliseMode(mode)) {
    case "local-only":
      return ["local"];
    case "cloud-only":
      return ["cloud"];
    default:
      return ["local", "cloud"];
  }
}

/** True when this provider may serve requests under the given mode. */
const providerAllowedInMode = (provider, mode) =>
  kindsForMode(mode).includes(provider?.kind === "local" ? "local" : "cloud");

/**
 * Health of one provider derived from the per-model health entries the router
 * recorded. The worst live signal wins so a rate-limited provider is never
 * displayed as healthy.
 */
function healthForProvider(providerId, healthEntries, now) {
  const mine = (healthEntries || []).filter(
    (entry) => String(entry.modelId || "").split(":")[0] === providerId,
  );
  if (!mine.length) {
    return {
      health: "unknown",
      category: null,
      cooldownUntil: 0,
      coolingDown: false,
      failures: 0,
      latencyMs: null,
      lastError: null,
      lastSuccess: 0,
    };
  }
  const cooldownUntil = mine.reduce((max, e) => Math.max(max, e.cooldownUntil || 0), 0);
  const lastSuccess = mine.reduce((max, e) => Math.max(max, e.lastOkAt || 0), 0);
  const failures = mine.reduce((sum, e) => sum + (e.failures || 0), 0);
  const degraded = mine.find((e) => e.category);
  const latencies = mine.map((e) => e.latencyMs).filter((v) => typeof v === "number");
  const coolingDown = cooldownUntil > now;
  const healthy = mine.some((e) => e.status === "available");
  return {
    health: coolingDown ? degraded?.category || "cooling-down" : healthy ? "healthy" : "unknown",
    category: degraded?.category || null,
    cooldownUntil,
    coolingDown,
    failures,
    latencyMs: latencies.length ? Math.round(Math.min(...latencies)) : null,
    lastError: degraded?.lastError || null,
    lastSuccess,
  };
}

function cloudValidation(provider, configured) {
  const current = provider?.validation || {};
  return modelAccess.validationState({
    keyConfigured: configured,
    authenticated: current.authenticated ?? (configured && Boolean(provider?.online)),
    catalogueAvailable:
      current.catalogueAvailable ??
      current.catalogueFetched ??
      (Boolean(provider?.online) && (provider?.models || []).length > 0),
    pricingKnown: current.pricingKnown,
    freeEligibilityKnown: current.freeEligibilityKnown,
    freeModelAvailable: current.freeModelAvailable,
    liveChatVerified: current.liveChatVerified ?? current.chatVerified,
    streamVerified: current.streamVerified,
  });
}

/**
 * Build the canonical registry.
 *
 * @param {object} input
 * @param {object} input.inventory  result of models.inventory()
 * @param {object} input.cloudSpecs models.CLOUD (id → spec) — the ONE catalogue
 * @param {string[]} input.storedKeyIds provider ids that have a stored key
 * @param {object} input.env process.env (or a test double)
 * @param {Array}  input.health router health snapshot entries
 */
function buildRegistry({
  inventory = {},
  cloudSpecs = {},
  storedKeyIds = [],
  env = {},
  health = [],
  now = Date.now(),
} = {}) {
  const stored = new Set(storedKeyIds);
  const byId = new Map();

  for (const provider of inventory.providers || []) {
    const id = provider.id;
    const spec = cloudSpecs[id] || null;
    const kind = provider.kind || (LOCAL_PROVIDER_IDS.has(id) ? "local" : "cloud");
    const hasStored = stored.has(id);
    const hasEnv = Boolean(spec?.env && env[spec.env]);
    const configured = kind === "local" ? true : hasStored || hasEnv;
    const state = healthForProvider(id, health, now);

    byId.set(id, {
      id,
      name: provider.name || spec?.name || id,
      kind,
      type: kind,
      endpoint: provider.endpoint || spec?.chat || null,
      configured,
      // A cloud provider is "authenticated" once a key exists AND the models
      // call using it came back. Local engines need no credential.
      authenticated: kind === "local" ? Boolean(provider.online) : configured && !!provider.online,
      reachable: Boolean(provider.online),
      keySource: kind === "local" ? null : hasStored ? "stored" : hasEnv ? "environment" : null,
      models: (provider.models || []).map((m) => m.id),
      modelCount: (provider.models || []).length,
      validation: kind === "cloud" ? cloudValidation(provider, configured) : null,
      latencyMs: provider.latencyMs ?? state.latencyMs,
      lastChecked: inventory.at || now,
      lastSuccess: state.lastSuccess || (provider.online ? inventory.at || now : 0),
      lastError: provider.error || state.lastError || null,
      ...state,
      // The inventory latency is the freshest reachability signal.
      ...(provider.latencyMs != null ? { latencyMs: provider.latencyMs } : {}),
    });
  }

  // Cloud providers with a key but no successful inventory call must still be
  // listed — "configured but not reachable" is real state, not an omission.
  for (const [id, spec] of Object.entries(cloudSpecs)) {
    if (byId.has(id)) continue;
    const hasStored = stored.has(id);
    const hasEnv = Boolean(spec?.env && env[spec.env]);
    byId.set(id, {
      id,
      name: spec.name || id,
      kind: "cloud",
      type: "cloud",
      endpoint: spec.chat || null,
      configured: hasStored || hasEnv,
      authenticated: false,
      reachable: false,
      keySource: hasStored ? "stored" : hasEnv ? "environment" : null,
      models: [],
      modelCount: 0,
      latencyMs: null,
      lastChecked: now,
      lastSuccess: 0,
      lastError: null,
      validation: cloudValidation(null, hasStored || hasEnv),
      ...healthForProvider(id, health, now),
    });
  }

  const providers = [...byId.values()].sort(
    (a, b) => Number(b.reachable) - Number(a.reachable) || a.id.localeCompare(b.id),
  );

  return {
    at: now,
    providers,
    totals: {
      total: providers.length,
      configured: providers.filter((p) => p.configured).length,
      reachable: providers.filter((p) => p.reachable).length,
      local: providers.filter((p) => p.kind === "local" && p.reachable).length,
      cloud: providers.filter((p) => p.kind === "cloud" && p.reachable).length,
      models: providers.reduce((n, p) => n + p.modelCount, 0),
    },
  };
}

/**
 * Can the requested mode be served right now? Used to answer honestly instead
 * of silently falling back into a mode the owner did not choose.
 */
function modeReadiness(registry, mode) {
  const wanted = normaliseMode(mode);
  const kinds = kindsForMode(wanted);
  const usable = (registry?.providers || []).filter(
    (p) => kinds.includes(p.kind) && p.reachable && p.configured && p.modelCount > 0,
  );
  return {
    mode: wanted,
    ready: usable.length > 0,
    providers: usable.map((p) => p.id),
    reason: usable.length
      ? null
      : wanted === "cloud-only"
        ? "No cloud provider has a working API key yet. Add one in Models."
        : wanted === "local-only"
          ? "No local engine is serving a model. Start Ollama, LM Studio or llama.cpp."
          : "No provider is reachable. Add a cloud API key or start a local engine.",
  };
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  normaliseMode,
  kindsForMode,
  providerAllowedInMode,
  healthForProvider,
  buildRegistry,
  modeReadiness,
};
