/**
 * FRIDAY · free-first model router (main process, authoritative).
 *
 * One place that decides WHICH model answers a request. It classifies every
 * routable model as free or paid, keeps a live health/cooldown state per
 * model, scores the eligible candidates and enforces the billing policy —
 * even if a paid model somehow reaches the registry.
 *
 * Pure logic only: no HTTP, no Electron. `electron/main.cjs` feeds it the
 * models `electron/models.cjs` really detected, and the unit tests drive the
 * same functions directly.
 */

const modelCapabilities = require("./model-capabilities.cjs");
const modelAccess = require("./model-access.cjs");

// ---------------------------------------------------------------- policy ---
/** Billing policy. Free-first is the default; paid use is gated separately. */
const POLICIES = ["free-only", "free-preferred", "allow-paid", "paid-only"];
const DEFAULT_POLICY = "free-preferred";

const normalisePolicy = (value) => (POLICIES.includes(value) ? value : DEFAULT_POLICY);

/**
 * Route modes. The owner decides WHERE inference may happen; a fallback never
 * leaves the chosen mode, so cloud-only never needs a local engine installed
 * and local-only never sends a prompt off the machine.
 */
const ROUTE_MODES = ["auto", "local-only", "cloud-only", "hybrid", "manual", "multi"];
const DEFAULT_ROUTE_MODE = "auto";
const normaliseRouteMode = (value) => (ROUTE_MODES.includes(value) ? value : DEFAULT_ROUTE_MODE);

/**
 * Modes where the owner's explicit picks are the WHOLE eligible pool.
 * "manual" is a single-model pool with ordered fallback; "multi" is the same
 * pool run concurrently when parallel execution is asked for.
 */
const EXCLUSIVE_MODES = new Set(["manual", "multi"]);
const isExclusiveMode = (mode) => EXCLUSIVE_MODES.has(normaliseRouteMode(mode));

/**
 * Modes where the owner's picks (when any exist) are the WHOLE eligible pool.
 * manual/multi always use that pool. local-only / cloud-only reuse the same
 * filter when the owner has picked models — empty picks still mean "every
 * model of that type", which is today's behaviour.
 */
function usesOwnerPool(mode, preferred = []) {
  const route = normaliseRouteMode(mode);
  if (isExclusiveMode(route)) return true;
  return (route === "local-only" || route === "cloud-only") && (preferred || []).length > 0;
}

/**
 * Owner-facing cost modes. They are the vocabulary of the settings UI; the
 * router itself only ever enforces the hard policies above, so every cost
 * mode maps onto exactly one of them. Paid modes still pass through the
 * billing lock in `billing-policy.cjs` before any money can be spent.
 */
const COST_MODES = ["free-only", "free-first", "balanced", "quality-first", "paid", "paid-only"];
const DEFAULT_COST_MODE = "free-first";
const normaliseCostMode = (value) => (COST_MODES.includes(value) ? value : DEFAULT_COST_MODE);

const COST_MODE_POLICY = {
  "free-only": "free-only",
  "free-first": "free-preferred",
  balanced: "free-preferred",
  "quality-first": "allow-paid",
  paid: "allow-paid",
  "paid-only": "paid-only",
};

/** The hard policy a cost mode requests (the billing lock may still refuse). */
function policyForCostMode(mode) {
  return COST_MODE_POLICY[normaliseCostMode(mode)] || DEFAULT_POLICY;
}

const ROUTING_TASKS = [
  "chat",
  "reasoning",
  "coding",
  "vision",
  "tools",
  "research",
  "embeddings",
  "audio",
  "fast",
];

function normaliseRoutingTask(value) {
  const s = String(value || "")
    .toLowerCase()
    .trim();
  if (s === "code") return "coding";
  if (s === "embed") return "embeddings";
  return ROUTING_TASKS.includes(s) ? s : "chat";
}

/**
 * Optional quality modifiers. `balanced` is today's score. The others only
 * adjust that score, except `private`, which is a hard local filter.
 */
const QUALITY_TARGETS = [
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
];
const DEFAULT_QUALITY_TARGET = "balanced";
const ROUTE_STRATEGIES = [
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
];
const DEFAULT_ROUTE_STRATEGY = "auto";
/** Name-only evidence is not enough for these capabilities. */
const EVIDENCE_GATED = new Set(["vision", "tools"]);

function normaliseQualityTarget(value) {
  const s = String(value || "")
    .toLowerCase()
    .trim();
  return QUALITY_TARGETS.includes(s) ? s : DEFAULT_QUALITY_TARGET;
}

function normaliseStrategy(value) {
  const s = String(value || "")
    .toLowerCase()
    .trim();
  return ROUTE_STRATEGIES.includes(s) ? s : DEFAULT_ROUTE_STRATEGY;
}

function normalizeRoutingRequirements(reqs) {
  if (!reqs || typeof reqs !== "object") return {};
  const out = {};
  if (typeof reqs.streaming === "boolean") out.streaming = reqs.streaming;
  if (typeof reqs.structuredOutput === "boolean") out.structuredOutput = reqs.structuredOutput;
  if (typeof reqs.tools === "boolean") out.tools = reqs.tools;
  if (typeof reqs.json === "boolean") out.json = reqs.json;
  if (typeof reqs.vision === "boolean") out.vision = reqs.vision;
  if (typeof reqs.contextK === "number" && Number.isFinite(reqs.contextK))
    out.contextK = reqs.contextK;
  if (typeof reqs.maxLatencyMs === "number" && Number.isFinite(reqs.maxLatencyMs))
    out.maxLatencyMs = reqs.maxLatencyMs;
  if (reqs.locality === "local" || reqs.locality === "cloud" || reqs.locality === "any")
    out.locality = reqs.locality;
  if (reqs.privacy === "private" || reqs.privacy === "standard") out.privacy = reqs.privacy;
  if (typeof reqs.strictEvidence === "boolean") out.strictEvidence = reqs.strictEvidence;
  if (typeof reqs.allowInferred === "boolean") out.allowInferred = reqs.allowInferred;
  if (reqs.strictPrivacy === true) out.strictPrivacy = true;
  return out;
}

function createRoutingContract(partial = {}) {
  const p = partial && typeof partial === "object" ? partial : {};
  return {
    routeMode: normaliseRouteMode(p.routeMode || p.mode),
    selectedModelIds: Array.isArray(p.selectedModelIds || p.preferred)
      ? (p.selectedModelIds || p.preferred).map((id) => String(id || "").trim()).filter(Boolean)
      : [],
    selectedProviderIds: Array.isArray(p.selectedProviderIds)
      ? p.selectedProviderIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [],
    costPolicy: normaliseCostMode(p.costPolicy || p.policy),
    task: normaliseRoutingTask(p.task),
    requirements: normalizeRoutingRequirements(p.requirements),
    qualityTarget: normaliseQualityTarget(p.qualityTarget),
    strategy: normaliseStrategy(p.strategy),
  };
}

function validateRoutingContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== "object") {
    return { ok: false, errors: ["Routing contract must be an object"] };
  }
  if (!contract.routeMode || !ROUTE_MODES.includes(contract.routeMode)) {
    errors.push(`Invalid routeMode: ${contract.routeMode}`);
  }
  if (
    contract.costPolicy &&
    !COST_MODES.includes(contract.costPolicy) &&
    !POLICIES.includes(contract.costPolicy)
  ) {
    errors.push(`Invalid costPolicy: ${contract.costPolicy}`);
  }
  if (
    contract.task &&
    !ROUTING_TASKS.includes(contract.task) &&
    !Object.keys(TASK_CAPABILITY).includes(contract.task)
  ) {
    errors.push(`Invalid task: ${contract.task}`);
  }
  if (contract.selectedModelIds !== undefined && !Array.isArray(contract.selectedModelIds)) {
    errors.push("selectedModelIds must be an array");
  }
  if (contract.selectedProviderIds !== undefined && !Array.isArray(contract.selectedProviderIds)) {
    errors.push("selectedProviderIds must be an array");
  }
  if (contract.qualityTarget !== undefined && !QUALITY_TARGETS.includes(contract.qualityTarget)) {
    errors.push(`Invalid qualityTarget: ${contract.qualityTarget}`);
  }
  if (contract.strategy !== undefined && !ROUTE_STRATEGIES.includes(contract.strategy)) {
    errors.push(`Invalid strategy: ${contract.strategy}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Model types a route mode may use. */
function typesForMode(mode, offline = false) {
  const route = normaliseRouteMode(mode);
  // Offline removes cloud; it does not override an explicit Cloud-only
  // boundary by silently switching to local.
  if (offline) return route === "cloud-only" ? [] : ["local"];
  switch (route) {
    case "local-only":
      return ["local"];
    case "cloud-only":
      return ["cloud"];
    default:
      return ["local", "cloud"];
  }
}

// --------------------------------------------------------------- access ----
/**
 * Coarse free / paid / unknown. Proof lives in `electron/model-access.cjs`.
 * A provider-wide free tier or a `:free` suffix is never enough on its own.
 */
function classifyAccess(model) {
  return modelAccess.classifyAccess(model);
}

function accessRecordOf(model) {
  return modelAccess.accessOf(model);
}

/**
 * Capability metadata for a model. Provider-declared metadata first, then the
 * curated registry, and only then a name-pattern guess — see
 * `electron/model-capabilities.cjs`.
 */
function capabilitiesOf(model) {
  return modelCapabilities.resolveCapabilities(model);
}

/** Which capability a task needs before a model may serve it. */
const TASK_CAPABILITY = {
  chat: "chat",
  fast: "chat",
  reasoning: "reasoning",
  code: "coding",
  coding: "coding",
  vision: "vision",
  tools: "tools",
  embed: "embeddings",
  embeddings: "embeddings",
  audio: "audio",
  research: "research",
};

const ROLE_BY_TASK = {
  chat: "brain",
  reasoning: "brain",
  code: "coder",
  coding: "coder",
  fast: "fast",
  research: "researcher",
  vision: "brain",
  tools: "brain",
  embed: "embed",
  embeddings: "embed",
  audio: "brain",
};

// ----------------------------------------------------- error classification -
/**
 * Turn a provider failure into one of FRIDAY's health categories. The category
 * decides whether we fall back, how long the model sits out, and what the
 * owner is told.
 */
function cooldownJitter(ms, salt = 0) {
  const base = Number(ms) || 0;
  const wobble = Math.abs(Number(salt) || 0) % 1000;
  return base + wobble;
}

function headerValue(input, name) {
  if (!input || typeof input !== "object") return undefined;
  const headers = input.headers && typeof input.headers === "object" ? input.headers : {};
  const wanted = String(name || "").toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/** Groq documents x-ratelimit-remaining-requests as the daily (RPD) counter. */
function dailyRemaining(input) {
  const raw = headerValue(input, "x-ratelimit-remaining-requests");
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const NEXT_STEP = Object.freeze({
  rate_limited: "Wait for the per-minute limit, then try this model again.",
  daily_limit: "The daily limit is used. Wait until it resets, or use another free model.",
  quota_exceeded: "This account's quota is used. Wait, or use a different provider.",
  billing_required:
    "This model needs paid access. Other free models can still be tried. Turn paid access on only if you mean to spend.",
  invalid_key: "Check this provider's API key in Models.",
  model_access: "This key cannot use this model. Other models on this provider are still eligible.",
  region_block: "This model is blocked in this region. Pick a model that is available here.",
  model_unavailable: "This model id is gone. FRIDAY will try the next candidate.",
  offline: "The engine is not running. Start it, then try again.",
  network: "The network could not reach this provider. Check the connection, then try again.",
  account_setting_required:
    "OpenRouter is hiding free models that may train on prompts. Open Privacy at https://openrouter.ai/settings/privacy and allow those models, then try again.",
  kernel_down: "The local AI service did not answer. FRIDAY will try to bring it back.",
  ipc_budget:
    "The wait limit expired. The work was not cancelled and another model is not tried for that alone.",
  timeout: "The provider timed out. FRIDAY will try a smaller reply, then another model.",
  provider_error: "The provider failed. FRIDAY will try a different provider.",
});

const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
  "localai",
  "jan",
  "mlx",
  "local",
]);

function spendCapAllows(model) {
  const cap = Number(model?.spendCapUsd ?? model?.meta?.spendCapUsd);
  return Number.isFinite(cap) && cap > 0;
}

function preferredHit(model, preferred) {
  return (preferred || []).some((id) => matchPreferred([model], id) === model);
}

function strictPrivacyBlocks(model, requirements) {
  if (!requirements || requirements.strictPrivacy !== true) return false;
  const pid = String(model?.providerId || model?.meta?.providerId || "");
  const name = String(model?.providerModelId || model?.id || "");
  return pid === "openrouter" && (name.endsWith(":free") || name.includes("openrouter/free"));
}

function kindFromModel(modelId) {
  const head = String(modelId || "").split(":")[0];
  if (LOCAL_PROVIDERS.has(head)) return "local";
  if (head && head !== String(modelId || "")) return "cloud";
  return "";
}

/** Redacted facts for one failed attempt. Prompts and secrets stay out. */
function attemptFacts(input) {
  const source = input && typeof input === "object" ? input : { message: input };
  const body = source.body && typeof source.body === "object" ? source.body : null;
  const inner = body && body.error && typeof body.error === "object" ? body.error : null;
  const snippet = redactRouterText(
    inner
      ? `${inner.code || inner.type || ""} ${inner.message || ""}`
      : String(source.body || source.message || ""),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  const status = Number(source.status || 0);
  return {
    provider: String(source.provider || source.providerId || "").slice(0, 40),
    modelId: String(source.modelId || "").slice(0, 120),
    path: String(source.path || source.urlPath || "")
      .replace(/^https?:\/\/[^/]+/i, "")
      .slice(0, 160),
    status: status > 0 ? status : null,
    code: String(source.code || source.errorCode || inner?.code || "").slice(0, 80),
    body: snippet,
    elapsedMs: Number(source.elapsedMs || source.latencyMs || 0) || null,
    retryAfter: cooldownFromRetryAfter(source) || null,
  };
}

function classifyError(input) {
  const text = String(input?.message || input || "").toLowerCase();
  const status = Number(input?.status || /http (\d{3})/.exec(text)?.[1] || 0);
  const code = String(input?.code || input?.errorCode || "").toLowerCase();
  const kind =
    input?.kind === "local" || input?.kind === "cloud" ? input.kind : kindFromModel(input?.modelId);

  const has = (...needles) => needles.some((n) => text.includes(n));
  const withStep = (row) => {
    let category = row.category;
    if (kind === "cloud" && category === "offline") category = "network";
    return {
      ...row,
      category,
      nextStep: NEXT_STEP[category] || "",
      facts: attemptFacts(input),
    };
  };
  if (
    status === 200 &&
    input &&
    typeof input === "object" &&
    (input.streamError || (input.body && input.body.error))
  ) {
    const inner = input.streamError || input.body.error || {};
    return classifyError({
      message: inner.message || input.message,
      status: Number(inner.status || 502),
      code: inner.code || inner.type || "",
      provider: input.provider,
      modelId: input.modelId,
      kind,
      path: input.path,
      elapsedMs: input.elapsedMs,
    });
  }
  if (code === "ipc_budget" || has("ipc budget expired")) {
    return withStep({ category: "ipc_budget", retryable: false, cooldownMs: 0 });
  }
  if (code === "data_policy" || has("no endpoints found matching your data policy")) {
    return withStep({
      category: "account_setting_required",
      retryable: false,
      cooldownMs: 30 * 60_000,
    });
  }

  if (status === 429 || has("rate limit", "rate-limit", "rate_limit", "too many requests")) {
    const retryAfter = cooldownFromRetryAfter(input);
    if (has("quota", "insufficient_quota", "billing", "exceeded your current quota")) {
      return withStep({
        category: "quota_exceeded",
        retryable: true,
        cooldownMs: retryAfter || 30 * 60_000,
      });
    }
    // A DAILY cap (OpenRouter's free tier is 50/day under 10 credits, 1000/day
    // after) is not the same as a per-minute burst limit. Groq's
    // x-ratelimit-remaining-requests header is the daily counter.
    const remaining = dailyRemaining(input);
    if (remaining === 0 || has("per day", "per-day", "daily", "free-models-per-day")) {
      return withStep({
        category: "daily_limit",
        retryable: true,
        cooldownMs: retryAfter || 60 * 60_000,
      });
    }
    return withStep({
      category: "rate_limited",
      retryable: true,
      cooldownMs: retryAfter || 60_000,
    });
  }
  if (has("insufficient_quota", "exceeded your current quota", "quota")) {
    return withStep({ category: "quota_exceeded", retryable: true, cooldownMs: 30 * 60_000 });
  }
  if (has("not available in your region", "region block", "geo-blocked")) {
    return withStep({
      category: "region_block",
      retryable: false,
      cooldownMs: cooldownJitter(60 * 60_000, 2),
    });
  }
  if (has("content_filter", "content filter", "content policy")) {
    return withStep({
      category: "content_filter",
      retryable: false,
      cooldownMs: cooldownJitter(60_000, 1),
    });
  }
  if (
    status === 402 ||
    has("payment required", "insufficient credit", "billing_required", "billing required")
  ) {
    return withStep({ category: "billing_required", retryable: false, cooldownMs: 60 * 60_000 });
  }
  if (
    status === 401 ||
    has("invalid_api_key", "invalid api key", "incorrect api key", "api key not valid")
  ) {
    return withStep({ category: "invalid_key", retryable: false, cooldownMs: 15 * 60_000 });
  }
  // 403 is this model or this tier, not a dead key. A bad key is 401 above.
  // Cooling the whole provider here hid every other free model on it.
  if (
    status === 403 ||
    has(
      "free tier is not enabled",
      "free tier not enabled",
      "does not have access to this model",
      "model access denied",
    )
  ) {
    return withStep({
      category: "model_access",
      retryable: false,
      cooldownMs: 15 * 60_000,
    });
  }
  if (has("has been deprecated", "was renamed", "model was removed")) {
    return withStep({
      category: "model_unavailable",
      retryable: false,
      cooldownMs: 10 * 60_000,
      delist: true,
    });
  }
  if (status === 404 || has("model not found", "does not exist", "unknown model")) {
    return withStep({
      category: "model_unavailable",
      retryable: false,
      cooldownMs: 10 * 60_000,
      delist:
        status === 404 ||
        has(
          "model not found",
          "not found",
          "does not exist",
          "unknown model",
          "deprecated",
          "renamed",
        ),
    });
  }
  if (status === 408 || has("timeout", "timed out", "deadline")) {
    return withStep({ category: "timeout", retryable: true, cooldownMs: 30_000 });
  }
  if (has("context length", "context window", "context overflow", "too many tokens")) {
    return { category: "context_overflow", retryable: false, cooldownMs: 5 * 60_000 };
  }
  if (
    has(
      "schema validation",
      "response schema",
      "does not match schema",
      "json schema",
      "schema_failure",
    )
  ) {
    return { category: "schema_failure", retryable: true, cooldownMs: 0 };
  }
  if (has("tool call failed", "tool_call_failed", "function call failed", "tool_use_failed")) {
    return { category: "tool_failure", retryable: true, cooldownMs: 0 };
  }
  if (has("low confidence", "confidence too low", "verification failed", "low_confidence")) {
    return { category: "low_confidence", retryable: true, cooldownMs: 0 };
  }
  if (has("model refused", "model refusal", "refused the request")) {
    return { category: "model_refusal", retryable: true, cooldownMs: 0 };
  }
  if (has("stream failed", "stream failure", "stream closed", "invalid stream")) {
    return withStep({ category: "stream_failure", retryable: true, cooldownMs: 30_000 });
  }
  if (
    has("connection failed to the local ai service") ||
    has("the local ai service disconnected")
  ) {
    return withStep({ category: "kernel_down", retryable: true, cooldownMs: 15_000 });
  }
  const transport =
    /econnrefused|enotfound|econnreset|enetunreach|eai_again|getaddrinfo|fetch failed|all connection attempts failed|connecterror/.test(
      text,
    );
  const loopback = /127\.0\.0\.1|localhost|\[::1\]/.test(text);
  if (transport && (kind === "local" || loopback)) {
    return withStep({ category: "offline", retryable: true, cooldownMs: 60_000 });
  }
  if (
    transport ||
    has("connection failed") ||
    has("could not connect") ||
    has("couldn't connect") ||
    has("cannot connect")
  ) {
    return withStep({ category: "network", retryable: true, cooldownMs: 30_000 });
  }
  if (status >= 500)
    return withStep({ category: "provider_error", retryable: true, cooldownMs: 30_000 });
  // A deterministic 400/422 is the request, not an outage. Do not retry it
  // and do not cool the provider down (cooldown 0 keeps coolingDown false).
  if (
    status === 400 ||
    status === 422 ||
    has("malformed", "invalid request", "unsupported parameter", "invalid_request")
  ) {
    return { category: "invalid_request", retryable: false, cooldownMs: 0 };
  }
  return { category: "unknown", retryable: true, cooldownMs: 15_000 };
}

/** Retry-After on the error object, capped at one hour. Seconds when the number is small. */
function cooldownFromRetryAfter(input) {
  if (!input || typeof input !== "object") return 0;
  const headers = input.headers && typeof input.headers === "object" ? input.headers : {};
  const raw =
    input.retryAfterMs ?? input.retryAfter ?? headers["retry-after"] ?? headers["Retry-After"];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ms = n < 100000 ? Math.round(n * 1000) : Math.round(n);
  return Math.min(ms, 60 * 60_000);
}

/** Owner-facing sentence for a health category. */
const HEALTH_REASON = {
  rate_limited: "rate limit reached (per-minute burst)",
  daily_limit: "daily request limit reached for this account",
  quota_exceeded: "quota exceeded",
  billing_required: "billing required",
  invalid_key: "API key rejected",
  model_access: "this key cannot use this model",
  region_block: "blocked in this region",
  model_unavailable: "model not available",
  timeout: "did not respond in time",
  context_overflow: "context window exceeded",
  model_refusal: "model refused this request",
  tool_failure: "tool call failed",
  schema_failure: "answer did not match the schema",
  low_confidence: "verification confidence was too low",
  stream_failure: "stream failed",
  offline: "not reachable",
  network: "network error",
  account_setting_required: "account setting required",
  kernel_down: "local AI service did not answer",
  provider_error: "provider error",
  invalid_request: "request was rejected",
  unknown: "failed",
};

function redactRouterText(value) {
  return String(value || "")
    .replace(/\b(?:api[_ -]?key|authorization|bearer)\s*[:=]\s*\S+/gi, "secret")
    .replace(/\bsk-[a-z0-9]{8,}\b/gi, "secret");
}

function percentile(samples, pct) {
  const list = (Array.isArray(samples) ? samples : [])
    .filter((n) => typeof n === "number" && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!list.length) return null;
  const index = Math.min(list.length - 1, Math.max(0, Math.ceil((pct / 100) * list.length) - 1));
  return list[index];
}

// --------------------------------------------------------- health tracking -
class ProviderHealthManager {
  constructor() {
    /** modelId → { status, category, cooldownUntil, failures, lastError, lastOkAt, latencyMs } */
    this.state = new Map();
    this.decisions = [];
  }

  get(modelId) {
    return (
      this.state.get(modelId) || {
        modelId,
        status: "unknown",
        category: null,
        cooldownUntil: 0,
        failures: 0,
        lastFailureAt: 0,
        lastError: null,
        lastOkAt: 0,
        latencyMs: null,
      }
    );
  }

  noteSuccess(modelId, latencyMs = null) {
    const entry = this.get(modelId);
    const samples = [...(entry.latencySamples || [])];
    if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
      samples.push(latencyMs);
      if (samples.length > 20) samples.shift();
    }
    this.state.set(modelId, {
      ...entry,
      modelId,
      status: "available",
      category: null,
      cooldownUntil: 0,
      failures: 0,
      lastFailureAt: 0,
      lastError: null,
      lastOkAt: Date.now(),
      latencyMs: latencyMs ?? entry.latencyMs,
      latencySamples: samples,
      consecutive: 0,
      recent: [],
      quarantined: false,
      recoveryProbe: "passed",
      breaker: "CLOSED",
    });
    return this.state.get(modelId);
  }

  /** Stamp a zero-spend probe without changing a cooldown the probe did not open. */
  noteProbe(modelId, now = Date.now()) {
    const entry = this.get(modelId);
    const next = { ...entry, modelId, lastProbeAt: now };
    this.state.set(modelId, next);
    return next;
  }

  /** Records a failure and starts the cooldown that keeps us off that endpoint. */
  noteFailure(modelId, error, now = Date.now()) {
    const payload =
      error && typeof error === "object"
        ? { ...error, modelId: error.modelId || modelId }
        : { message: error, modelId };
    const classified = classifyError(payload);
    const entry = this.get(modelId);
    const failures = entry.failures + 1;
    // Exponential backoff, capped, so a flaky provider is retried sensibly.
    const backoff = Math.min(classified.cooldownMs * Math.min(2 ** (failures - 1), 8), 60 * 60_000);
    const recent = [...(entry.recent || []), { at: now, category: classified.category }]
      .filter((row) => now - row.at < 10 * 60_000)
      .slice(-8);
    const consecutive = classified.category === entry.category ? (entry.consecutive || 0) + 1 : 1;
    // A deterministic 400 is the request. It never opens a provider quarantine.
    const quarantined = classified.cooldownMs > 0 && consecutive >= 3;
    const next = {
      ...entry,
      modelId,
      status: classified.category,
      category: classified.category,
      cooldownUntil: now + backoff,
      failures,
      consecutive,
      recent,
      quarantined,
      failureClass: classified.category,
      lastFailureAt: now,
      lastError: redactRouterText(String(payload.message || error || "")).slice(0, 400),
      facts: classified.facts || null,
      nextStep: classified.nextStep || NEXT_STEP[classified.category] || "",
      breaker: backoff > 0 ? "OPEN" : entry.breaker || "CLOSED",
      recoveryProbe: backoff > 0 ? "pending" : entry.recoveryProbe,
    };

    this.state.set(modelId, next);
    return { ...next, ...classified, cooldownMs: backoff };
  }

  /** A recovery probe after cooldown. Success clears the breaker; failure stays recorded. */
  noteRecovery(modelId, ok, now = Date.now()) {
    if (ok) {
      this.noteSuccess(modelId);
      const entry = this.get(modelId);
      const next = { ...entry, recoveryProbe: "passed", recoveryAt: now };
      this.state.set(modelId, next);
      return next;
    }
    const entry = this.get(modelId);
    const next = { ...entry, modelId, recoveryProbe: "failed", recoveryAt: now };
    this.state.set(modelId, next);
    return next;
  }

  isCoolingDown(modelId, now = Date.now()) {
    return this.breakerState(modelId, now) === "OPEN";
  }

  /** CLOSED, OPEN while cooling, HALF-OPEN for one probe after the cooldown. */
  breakerState(modelId, now = Date.now()) {
    const entry = this.get(modelId);
    if (entry.cooldownUntil > now) return "OPEN";
    if ((entry.consecutive || 0) >= 3 && entry.recoveryProbe !== "passed" && entry.lastFailureAt) {
      return "HALF-OPEN";
    }
    return "CLOSED";
  }

  /** Local cooldown bookkeeping. This never calls a models endpoint. */
  tickCooldowns(now = Date.now()) {
    let expired = 0;
    for (const entry of this.state.values()) {
      if (entry.cooldownUntil && entry.cooldownUntil <= now && entry.breaker === "OPEN")
        expired += 1;
    }
    return { fetched: false, network: false, spend: "zero", expired, at: now };
  }

  noteDecision(row) {
    const decisions = this.decisions || [];
    decisions.push({
      at: row.at || Date.now(),
      modelId: String(row.modelId || "").slice(0, 120),
      why: redactRouterText(row.why || "").slice(0, 240),
      latencyMs: typeof row.latencyMs === "number" ? row.latencyMs : null,
      outcome: String(row.outcome || "").slice(0, 40),
    });
    this.decisions = decisions.slice(-8);
  }

  exportState() {
    return {
      models: this.snapshot().map((entry) => ({
        modelId: entry.modelId,
        status: entry.status,
        category: entry.category,
        cooldownUntil: entry.cooldownUntil,
        failures: entry.failures,
        consecutive: entry.consecutive || 0,
        lastFailureAt: entry.lastFailureAt || 0,
        lastOkAt: entry.lastOkAt || 0,
        latencyMs: entry.latencyMs,
        latencySamples: entry.latencySamples || [],
        recoveryProbe: entry.recoveryProbe || null,
        breaker: entry.breaker || "CLOSED",
        nextStep: entry.nextStep || "",
      })),
      decisions: this.decisions || [],
    };
  }

  importState(saved) {
    this.state.clear();
    const models = Array.isArray(saved?.models) ? saved.models : [];
    for (const row of models) {
      if (!row || !row.modelId) continue;
      this.state.set(row.modelId, {
        ...this.get(row.modelId),
        ...row,
        lastError: null,
      });
    }
    this.decisions = Array.isArray(saved?.decisions) ? saved.decisions.slice(-8) : [];
  }

  debugReport(now = Date.now()) {
    return {
      decisions: this.decisions || [],
      models: this.snapshot(now).map((entry) => ({
        modelId: entry.modelId,
        breaker: this.breakerState(entry.modelId, now),
        category: entry.category,
        nextStep: entry.nextStep || "",
        latencyMs: entry.latencyMs,
        p50Ms: percentile(entry.latencySamples, 50),
        p95Ms: percentile(entry.latencySamples, 95),
        evidence: entry.evidence || null,
      })),
    };
  }

  /** Cooldowns expire on their own; this is how a model gets a second chance. */
  clear(modelId) {
    if (modelId) this.state.delete(modelId);
    else this.state.clear();
  }

  snapshot(now = Date.now()) {
    return [...this.state.values()].map((entry) => ({
      ...entry,
      coolingDown: entry.cooldownUntil > now,
    }));
  }
}

// ------------------------------------------------------------- selection ---
/** Loose name match so a catalogue handle can still pin an engine tag. */
const norm = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function matchPreferred(models, id) {
  const key = norm(id);
  if (!key) return null;
  return (
    models.find((m) => m.id === id) ||
    models.find((m) => m.meta?.modelName === id) ||
    models.find((m) => norm(m.meta?.modelName) === key) ||
    models.find(
      (m) =>
        norm(m.meta?.modelName).startsWith(key) || key.startsWith(norm(m.meta?.modelName || "")),
    ) ||
    null
  );
}

/** Decorate a routable model with access, capabilities and live health. */
function describe(model, health, now = Date.now()) {
  const state = health ? health.get(model.id) : null;
  const accessRecord = accessRecordOf(model);
  const access = modelAccess.coarseAccess(accessRecord);
  const caps = capabilitiesOf(model);
  const qualityProfile = modelCapabilities.resolveQualityProfile
    ? modelCapabilities.resolveQualityProfile(model, caps, {
        latencyMs: state?.latencyMs,
        failures: state?.failures,
      })
    : null;
  const providerId = model.providerId || model.meta?.providerId || model.provider || "unknown";
  const providerModelId =
    model.providerModelId || model.meta?.modelName || model.options?.model || model.id;
  const canonicalModelId = model.canonicalModelId || `${providerId}/${providerModelId}`;

  return {
    ...model,
    registryId: model.registryId || model.id,
    providerId,
    providerModelId,
    displayName: model.displayName || model.label || model.name || providerModelId,
    canonicalModelId,
    wireProtocol: model.wireProtocol || model.provider || "online",
    kind: model.kind || model.type || model.meta?.kind || "cloud",
    type: model.kind || model.type || model.meta?.kind || "cloud",
    pricing: accessRecord?.pricing || accessRecord?.pricingEvidence || null,
    entitlement: accessRecord?.entitlement || null,
    verification: accessRecord?.verification || "UNVERIFIED",
    lastSeen: model.lastSeen || now,
    lastVerified: accessRecord?.lastVerified || model.lastVerified || 0,
    accessRecord,
    access,
    accessStatus: modelAccess.effectiveStatus(accessRecord),
    // Verified means a live probe (or local runtime) proved the class.
    // Unknown and unverified free-class evidence stay out of free-only.
    pricingVerified: accessRecord.verification === "VERIFIED" && access !== "unknown",
    capabilities: caps,
    evidence: {
      capabilities: caps.source || "unknown",
      sources: caps.sources || {},
      verification: accessRecord?.verification || "UNVERIFIED",
    },
    qualityProfile: model.qualityProfile || qualityProfile,
    supportsStreaming:
      model.supportsStreaming !== undefined ? model.supportsStreaming : caps.streaming !== false,
    supportsTools: caps.tools,
    supportsVision: caps.vision,
    health: state?.status || "unknown",
    healthCategory: state?.category || null,
    cooldownUntil: state?.cooldownUntil || 0,
    coolingDown: Boolean(state && state.cooldownUntil > now),
    failures: state?.failures || 0,
    lastFailureAt: state?.lastFailureAt || 0,
    latencyMs: state?.latencyMs ?? model.latencyMs ?? null,
    available: !(state && state.cooldownUntil > now),
    spendCapUsd: Number(model.spendCapUsd ?? model.meta?.spendCapUsd) || 0,
  };
}

/**
 * Extra score for an explicit quality target. Omitted and `balanced` add
 * nothing, so the default order stays the formula below.
 */
function qualityAdjustment(model, qualityTarget, normTask) {
  if (qualityTarget == null || qualityTarget === "") return 0;
  const target = normaliseQualityTarget(qualityTarget);
  if (target === "balanced" || target === "private") return 0;
  const qp = model.qualityProfile || {};
  let extra = 0;
  if (target === "fastest") {
    extra += (qp.speedScore || 0.5) * 4;
    if (typeof model.latencyMs === "number" && model.latencyMs > 0) {
      extra += Math.max(-2, 2 - model.latencyMs / 500);
    }
  } else if (target === "best-quality") {
    extra += (qp.reasoningScore || 0.5) * 3;
    extra += (qp.codingScore || 0.5) * 2;
    if (normTask === "reasoning" || normTask === "coding") extra += 1;
  } else if (target === "cheapest") {
    if (model.access === "free" || model.type === "local") extra += 4;
    if (model.access === "paid") extra -= 4;
  } else if (target === "reliable") {
    if (model.health === "available") extra += 3;
    extra -= Math.min(6, (model.failures || 0) * 1.5);
  } else if (target === "deep-reasoning") {
    extra += (qp.reasoningScore || 0.5) * 4;
  } else if (target === "research-grade") {
    if (model.capabilities?.research) extra += 3;
    if ((model.contextK || 0) >= 64) extra += 1;
  } else if (target === "local-preferred") {
    if (model.type === "local") extra += 4;
  } else if (target === "cloud-preferred") {
    if (model.type === "cloud") extra += 4;
  }
  return extra;
}

/** Score a candidate. Higher wins; the formula stays readable on purpose. */
function scoreModel(
  model,
  {
    task = "chat",
    policy = DEFAULT_POLICY,
    now = Date.now(),
    requirements = {},
    qualityTarget = null,
    surface = null,
  } = {},
) {
  const normTask = normaliseRoutingTask(task);
  const wantedRole = ROLE_BY_TASK[normTask] || ROLE_BY_TASK[task] || "brain";
  const neededCap = TASK_CAPABILITY[normTask] || TASK_CAPABILITY[task] || null;
  let score = 0;

  // Capability fit
  if (model.role === wantedRole) score += 2;
  if (neededCap && model.capabilities[neededCap]) score += 2.5;
  if (model.contextK >= 64) score += 0.4;
  else if (model.contextK >= 32) score += 0.2;

  // Quality profile fit
  const qp = model.qualityProfile || {};
  if (normTask === "reasoning") {
    score += (qp.reasoningScore || 0.5) * 6.0;
    if ((qp.reasoningScore || 0.5) >= 0.85) score += 2.5;
  } else if (normTask === "coding") {
    score += (qp.codingScore || 0.5) * 5.0;
    if ((qp.codingScore || 0.5) >= 0.85) score += 2.0;
  } else if (normTask === "vision") {
    score += (qp.visionScore || 0.5) * 4.5;
  } else if (normTask === "tools") {
    score += (qp.toolScore || 0.5) * 3.5;
  } else if (normTask === "fast") {
    score += (qp.speedScore || 0.5) * 5.0;
    if ((qp.speedScore || 0.5) >= 0.85) score += 2.0;
  } else {
    score += (qp.chatScore || 0.5) * 2.0;
  }

  // Free-first: local is the cheapest, most private and never rate limited.
  // paid-only inverts that: only known-paid models may score as usable.
  const allowsPaid = policy === "allow-paid" || policy === "paid-only";
  const freePriority = modelAccess.freeRank(model.accessRecord);
  if (freePriority && policy !== "paid-only") score += 2 + freePriority * 0.4;
  if (model.access === "free") score += policy === "paid-only" ? -99 : 3;
  if (model.access === "paid") score -= allowsPaid ? 1.5 : 99;
  // Unverified pricing may never outrank a verified free model, and it is
  // blocked outright while the owner is on free-only (see selectEligible).
  if (model.access === "unknown") score -= policy === "allow-paid" ? 1 : 2.5;
  if (model.type === "local") score += policy === "paid-only" ? -99 : 2.5;
  if (model.capabilities?.tools) score += 0.35;
  if (model.capabilities?.vision && normTask === "vision") score += 0.5;
  if (model.capabilities?.reasoning && normTask === "reasoning") score += 0.5;
  const remaining =
    model.accessRecord?.rateLimits?.remainingRequests ??
    model.accessRecord?.quota?.remaining ??
    null;
  if (typeof remaining === "number") score += Math.max(-0.5, Math.min(0.8, remaining / 100));
  if (model.meta?.resident) score += 1; // already loaded in local engine: instant

  // Proven behaviour & Latency
  if (model.health === "available") score += 1.2;
  if (model.latencyMs) score += Math.max(-1, 1 - model.latencyMs / 2000);
  if (surface === "voice") {
    if (model.latencyMs) score += Math.max(-1, 1 - model.latencyMs / 2000) * 2;
    score += (qp.speedScore || 0) * 4;
    if (model.role === "fast") score += 2;
  } else if (surface === "chat") {
    score += (qp.chatScore || qp.reasoningScore || 0.5) * 2;
    if ((qp.chatScore || 0) >= 0.8) score += 1;
  }
  if (requirements.maxLatencyMs && model.latencyMs && model.latencyMs > requirements.maxLatencyMs) {
    score -= 3;
  }
  if (requirements.contextK && model.contextK && model.contextK >= requirements.contextK) {
    score += 0.5;
  }

  const outcomes = model.outcomes || model.meta?.outcomes;
  if (outcomes && typeof outcomes === "object") {
    const trials = Number(outcomes.trials || 0);
    const successes = Number(outcomes.successes || 0);
    if (trials >= 3) score += (successes / trials - 0.5) * 4;
    if (typeof outcomes.meanLatencyMs === "number" && Number.isFinite(outcomes.meanLatencyMs)) {
      score += Math.max(-1, 1 - outcomes.meanLatencyMs / 2000) * 0.5;
    }
    if (typeof outcomes.ownerUp === "number" && Number.isFinite(outcomes.ownerUp)) {
      score += Math.max(-2, Math.min(2, outcomes.ownerUp));
    }
  }

  score -= Math.min(3, model.failures * 0.75);
  if (model.coolingDown) score -= 50;
  // Recency matters more than the raw count: a model that failed minutes ago
  // must not be picked again in the same session just because its cooldown
  // happened to be short. The penalty decays over 30 minutes.
  const sinceFailure = model.lastFailureAt ? now - model.lastFailureAt : Infinity;
  if (sinceFailure < 30 * 60_000) {
    score -= 8 * (1 - sinceFailure / (30 * 60_000));
  }

  // A tiny local model should not win a reasoning task on price alone.
  if (normTask === "reasoning" && model.type === "local" && (model.meta?.sizeGb || 0) < 3)
    score -= 1.5;

  score += qualityAdjustment(model, qualityTarget, normTask);

  return Number(score.toFixed(3));
}

const PROVIDER_NAMES = Object.freeze({
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  groq: "Groq",
  mistral: "Mistral",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  nvidia: "NVIDIA",
  fireworks: "Fireworks AI",
  deepinfra: "DeepInfra",
  cerebras: "Cerebras",
  sambanova: "SambaNova",
  moonshot: "Moonshot",
  zhipu: "Z.ai",
  huggingface: "Hugging Face",
  together: "Together AI",
  xai: "xAI",
  perplexity: "Perplexity",
  nebius: "Nebius",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
  localai: "LocalAI",
  jan: "Jan",
  mlx: "MLX",
  local: "Local",
});

function providerDisplayName(model) {
  const fromMeta = model?.meta?.providerName || model?.providerName;
  if (fromMeta && fromMeta !== "online" && fromMeta !== "openai-compatible")
    return String(fromMeta);
  const id = String(model?.providerId || model?.meta?.providerId || "").toLowerCase();
  if (PROVIDER_NAMES[id]) return PROVIDER_NAMES[id];
  const wire = String(model?.provider || "").toLowerCase();
  if (PROVIDER_NAMES[wire]) return PROVIDER_NAMES[wire];
  return id || "Model";
}

function modelDisplayName(model) {
  return String(
    model?.providerModelId ||
      model?.meta?.modelName ||
      model?.meta?.providerModelId ||
      model?.name ||
      model?.id ||
      "model",
  );
}

function choiceLabelOf(model) {
  return `${providerDisplayName(model)} · ${modelDisplayName(model)}`;
}

function badgeOf(model) {
  if (model?.type === "local" || model?.kind === "local") return "LOCAL";
  if (model?.access === "free") return "FREE";
  if (model?.access === "paid") return "PAID";
  if (model?.access === "unknown") return "cost unknown";
  return "UNKNOWN";
}

function formatRemain(ms) {
  const minutes = Math.max(1, Math.ceil(Number(ms || 0) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} h`;
}

function capabilityMarks(model) {
  const caps = model?.capabilities || {};
  const marks = [];
  if (caps.vision) marks.push("vision");
  if (caps.tools) marks.push("tools");
  if (caps.reasoning) marks.push("reasoning");
  if (caps.longContext) marks.push("long context");
  return marks;
}

/**
 * What the chat selector may show. The router uses the same decision, so a
 * row cannot appear when routing would reject it for cost, or disappear when
 * routing would use it.
 */
function modelAvailability(model, policy, now, task = "chat") {
  const connected = model?.connected !== false && model?.meta?.connected !== false;
  if (!connected) return { visibility: "hide", reason: "not-connected" };
  const life = String(model?.lifecycle || model?.meta?.lifecycle || "").toLowerCase();
  if (life === "retired" || life === "deprecated" || model?.deprecated === true) {
    return { visibility: "hide", reason: "retired" };
  }
  const local = model?.type === "local";
  const paidOn = policy === "allow-paid" || policy === "paid-only";
  const quota =
    model?.accessRecord?.eligibility === "EXHAUSTED" || model?.healthCategory === "quota_exceeded";
  if (quota) return { visibility: "disabled", reason: "out of quota" };
  if (model?.meta?.loaded === false || model?.status === "unavailable") {
    return {
      visibility: "disabled",
      reason: model?.meta?.notice || "Not available locally",
    };
  }
  if (model?.coolingDown) {
    const remain = Math.max(0, (model.cooldownUntil || now) - now);
    return { visibility: "disabled", reason: `limit reached · back in ${formatRemain(remain)}` };
  }
  if (!local) {
    if (policy === "paid-only" && model.access !== "paid") {
      return { visibility: "hide", reason: "paid-only" };
    }
    if (!paidOn && model.access === "paid") return { visibility: "hide", reason: "paid-off" };
    if (!paidOn && model.access !== "free") return { visibility: "hide", reason: "cost-unknown" };
  }
  if (
    (task === "chat" || task === "fast") &&
    model?.capabilities &&
    model.capabilities.chat === false
  ) {
    return { visibility: "hide", reason: "not-chat" };
  }
  return {
    visibility: "show",
    reason: null,
    badge: badgeOf(model),
  };
}

function selectorHint(hiddenPaid, hiddenUnknown, providersWithoutFree) {
  const parts = [];
  const hidden = hiddenPaid + hiddenUnknown;
  if (hidden > 0) {
    parts.push(
      `${hidden} more model${hidden === 1 ? "" : "s"} hidden — turn on paid access to see them`,
    );
  }
  if (providersWithoutFree > 0) {
    parts.push(
      `${providersWithoutFree} provider${providersWithoutFree === 1 ? "" : "s"} connected without free models`,
    );
  }
  return parts.join(". ");
}

function countProvidersWithoutFree(rows) {
  const by = new Map();
  for (const row of rows) {
    if (row.model?.type === "local") continue;
    const id = String(row.model?.providerId || row.providerName || "");
    if (!by.has(id)) by.set(id, { free: false, blocked: false });
    const bucket = by.get(id);
    if (row.model?.access === "free") bucket.free = true;
    if (row.reason === "paid-off" || row.reason === "cost-unknown") bucket.blocked = true;
  }
  let count = 0;
  for (const bucket of by.values()) {
    if (!bucket.free && bucket.blocked) count += 1;
  }
  return count;
}

/**
 * Models that are free right now. A cooldown stays on the board and disabled.
 * Paid and unknown-cost rows stay off. Source and age come from the evidence
 * the access record already stored.
 */
function quotaLine(model) {
  const limits = model?.accessRecord?.rateLimits;
  if (!limits || typeof limits !== "object") return null;
  return {
    remainingRequests: limits.remainingRequests ?? null,
    limitRequests: limits.limitRequests ?? null,
    remainingTokens: limits.remainingTokens ?? null,
    limitTokens: limits.limitTokens ?? null,
    source: limits.source || "response-headers",
  };
}

function freeNowBoard(models, options = {}) {
  const now = options.now || Date.now();
  const view = usableModels(models, {
    ...options,
    policy: options.policy || "free-preferred",
    now,
  });
  const rows = [];
  for (const row of view.rows) {
    const model = row.model || {};
    const local = model.type === "local" || model.kind === "local";
    if (!local && model.access !== "free") continue;
    if (row.visibility === "hide") continue;
    const evidence = model.accessRecord?.evidence || {};
    const checkedAt = Number(evidence.checkedAt || 0);
    const cooling = Boolean(model.coolingDown) || /limit reached/i.test(String(row.reason || ""));
    const marks = [...(row.marks || [])];
    if (local && !marks.includes("local")) marks.push("local");
    if ((model.capabilities?.fast || model.role === "fast") && !marks.includes("speed")) {
      marks.push("speed");
    }
    rows.push({
      id: model.id,
      label: row.choiceLabel,
      source: evidence.source || (local ? "local_runtime" : "unknown"),
      sourceUrl: String(evidence.url || evidence.sourceUrl || ""),
      checkedAt: checkedAt || null,
      ageMs: checkedAt > 0 ? Math.max(0, now - checkedAt) : null,
      cooling,
      reason: row.disabledReason || null,
      marks,
      quota: quotaLine(model),
      dataUse: String(evidence.dataUse || ""),
    });
  }
  return rows;
}

function usableModels(models, options = {}) {
  const policy = normalisePolicy(options.policy || DEFAULT_POLICY);
  const now = options.now || Date.now();
  const task = normaliseRoutingTask(options.task || "chat");
  const described = (models || []).map((model) =>
    model && model.access && model.capabilities
      ? model
      : describe(model, options.health || null, now),
  );
  const rows = described.map((model) => {
    const avail = modelAvailability(model, policy, now, task);
    return {
      model,
      visibility: avail.visibility,
      reason: avail.reason,
      disabledReason: avail.visibility === "disabled" ? avail.reason : null,
      choiceLabel: choiceLabelOf(model),
      badge: avail.badge || badgeOf(model),
      providerName: providerDisplayName(model),
      marks: [
        ...capabilityMarks(model),
        ...(model?.accessRecord?.evidence?.source === "owner_declared" ? ["owner declared"] : []),
      ],
    };
  });
  const hiddenPaid = rows.filter((row) => row.reason === "paid-off").length;
  const hiddenUnknown = rows.filter((row) => row.reason === "cost-unknown").length;
  const providersWithoutFree = countProvidersWithoutFree(rows);
  return {
    rows,
    hint: selectorHint(hiddenPaid, hiddenUnknown, providersWithoutFree),
    hiddenPaid,
    hiddenUnknown,
    providersWithoutFree,
  };
}

const ANSWER_REASONS = Object.freeze({
  rate_limited: "rate limit",
  quota_exceeded: "quota",
  billing_required: "billing",
  auth: "auth",
  model_unavailable: "unavailable",
  timeout: "timeout",
  provider_outage: "outage",
  network_failure: "network",
});

function formatAnsweredBy({ winner, failures = [], auto = false } = {}) {
  if (!winner) return null;
  const described = winner.access && winner.providerId ? winner : describe(winner);
  const display = choiceLabelOf(described);
  const badge = badgeOf(described);
  const chain = (failures || []).map((failure) => ({
    modelId: failure.modelId || "",
    display: failure.display || failure.label || failure.modelId || "model",
    reason: ANSWER_REASONS[failure.category] || failure.reason || failure.category || "failed",
  }));
  let line = display;
  if (chain.length) {
    const failed = chain.map((item) => `${item.display} failed (${item.reason})`).join("; ");
    line = `${failed} → ${display} answered`;
  } else if (auto) {
    line = `Auto → ${display}`;
  }
  return {
    providerId: described.providerId,
    providerName: providerDisplayName(described),
    modelId: described.id,
    modelName: modelDisplayName(described),
    display,
    badge,
    auto: Boolean(auto) && chain.length === 0,
    chain,
    line,
  };
}

/**
 * Why a described model cannot serve this request. Null means it passed.
 * The order matches the hard filters; a later reason never hides an earlier one.
 */
function hardReject(model, ctx) {
  const m = model;
  if (!ctx.allowedTypes.includes(m.type === "local" ? "local" : "cloud")) return "mode";
  if (ctx.privateRoute && m.type !== "local") return "privacy";
  if (ctx.requirements.locality === "local" && m.type !== "local") return "locality";
  if (ctx.requirements.locality === "cloud" && m.type !== "cloud") return "locality";
  if (ctx.selectedProviderIds.length > 0) {
    const pid = String(m.providerId || m.provider || m.meta?.providerId || "").toLowerCase();
    const match = ctx.selectedProviderIds.some((p) => String(p).toLowerCase() === pid);
    if (!match) return "provider";
  }
  const avail = modelAvailability(m, ctx.usage, ctx.now || Date.now(), ctx.task);
  if (avail.visibility === "hide") {
    if (avail.reason === "retired") return "retired";
    if (avail.reason === "not-connected") return "unconnected";
    if (avail.reason === "not-chat") return "capability";
    return "cost";
  }
  if (avail.visibility === "disabled") {
    if (m.meta?.loaded === false || m.status === "unavailable") return "unavailable";
    return String(avail.reason || "").startsWith("limit reached") ? "cooldown" : "quota";
  }
  if (!ctx.cloudOptIn(m)) return "cloud-opt-in";
  if (strictPrivacyBlocks(m, ctx.requirements)) return "privacy";
  if (ctx.usage === "paid-only") {
    if (m.access !== "paid" && !(m.access === "unknown" && spendCapAllows(m))) return "cost";
  } else if (ctx.usage === "free-only") {
    const retryableLimit =
      m.accessStatus === "FREE_RATE_LIMITED" &&
      m.healthCategory !== "quota_exceeded" &&
      m.healthCategory !== "billing_required";
    if (!modelAccess.isFreeOnlyEligible(m.accessRecord, { retryableLimit })) return "cost";
  } else {
    if (m.access === "paid" && ctx.usage !== "allow-paid") return "cost";
    if (m.access === "unknown" && !spendCapAllows(m)) {
      if (!preferredHit(m, ctx.preferred)) return "cost";
    }
  }
  if (m.meta?.loaded === false || m.status === "unavailable") return "unavailable";
  if (m.coolingDown) return "cooldown";
  if (m.role === "embed" && ctx.task !== "embed" && ctx.task !== "embeddings") return "role";
  const life = String(m.lifecycle || m.meta?.lifecycle || "").toLowerCase();
  if (life === "retired" || life === "deprecated" || m.deprecated === true) return "retired";
  if (ctx.neededCap && !m.capabilities[ctx.neededCap]) return "capability";
  if (ctx.requirements.streaming === true && m.supportsStreaming === false) return "streaming";
  if (ctx.requirements.tools === true && !m.capabilities?.tools) return "tools";
  if (ctx.requirements.vision === true && !m.capabilities?.vision) return "vision";
  if (
    typeof ctx.requirements.contextK === "number" &&
    (m.contextK || 0) < ctx.requirements.contextK
  )
    return "context";
  if (evidenceBlocked(m, ctx)) return "evidence";
  return null;
}

function capabilitySource(model, cap) {
  const sources = model.capabilities?.sources;
  if (sources && typeof sources === "object" && sources[cap]) return sources[cap];
  return model.capabilities?.source || "";
}

/** Inferred vision/tools (or any cap when strict evidence is on) cannot pass. */
function evidenceBlocked(model, ctx) {
  if (ctx.requirements.allowInferred === true) return false;
  const caps = [];
  if (EVIDENCE_GATED.has(ctx.neededCap)) caps.push(ctx.neededCap);
  if (ctx.requirements.strictEvidence === true && ctx.neededCap) caps.push(ctx.neededCap);
  if (ctx.requirements.vision === true) caps.push("vision");
  if (ctx.requirements.tools === true) caps.push("tools");
  for (const cap of caps) {
    if (!cap) continue;
    if (model.capabilities?.[cap] && capabilitySource(model, cap) === "inferred") return true;
  }
  return false;
}

/**
 * Shared route preparation. selectEligible and planRoute both use this so
 * the candidate list and the rejection reasons cannot drift.
 */
function prepareRoute(models, options = {}) {
  const contract =
    options.routeMode || options.costPolicy || options.selectedModelIds
      ? createRoutingContract(options)
      : null;
  const mode = normaliseRouteMode(options.mode || contract?.routeMode || DEFAULT_ROUTE_MODE);
  const task = normaliseRoutingTask(options.task || contract?.task || "chat");
  const preferred =
    (options.preferred?.length ? options.preferred : contract?.selectedModelIds) || [];
  const selectedProviderIds =
    (options.selectedProviderIds?.length
      ? options.selectedProviderIds
      : contract?.selectedProviderIds) || [];
  const policy = normalisePolicy(
    options.policy ||
      (contract?.costPolicy ? policyForCostMode(contract.costPolicy) : DEFAULT_POLICY),
  );
  const requirements = normalizeRoutingRequirements(
    options.requirements || contract?.requirements || {},
  );
  const explicitTarget = options.qualityTarget || contract?.qualityTarget;
  const qualityTarget = explicitTarget
    ? normaliseQualityTarget(explicitTarget)
    : DEFAULT_QUALITY_TARGET;
  const privateRoute = requirements.privacy === "private" || qualityTarget === "private";
  const health = options.health || null;
  const now = options.now || Date.now();
  const limit = options.limit || 4;
  const offline = Boolean(options.offline);

  const usage = policy;
  const allowedTypes = typesForMode(mode, offline);

  const described = (models || []).map((m) => describe(m, health, now));
  const neededCap = TASK_CAPABILITY[task] || null;

  const exclusive = options.exclusive ?? usesOwnerPool(mode, preferred);
  const pool =
    exclusive && preferred.length
      ? described.filter((m) => preferred.some((id) => matchPreferred([m], id)))
      : described;

  /**
   * Free cloud models are in Auto. Paid and unknown-cost models enter only
   * when paid access is on (allow-paid / paid-only), or the owner chose
   * Cloud only / an exclusive pool. The billing firewall still gates spend.
   */
  const cloudChosenByMode = mode === "cloud-only" || isExclusiveMode(mode) || usage === "paid-only";
  const cloudOptIn = (m) =>
    m.type === "local" ||
    m.access === "free" ||
    cloudChosenByMode ||
    (usage === "allow-paid" && m.access === "paid") ||
    (usage === "allow-paid" && m.access === "unknown" && spendCapAllows(m)) ||
    preferred.some((id) => matchPreferred([m], id) === m);

  const ctx = {
    allowedTypes,
    requirements,
    selectedProviderIds,
    cloudOptIn,
    usage,
    task,
    neededCap,
    privateRoute,
    now,
    preferred,
  };
  const rejected = [];
  const eligible = [];
  for (const model of pool) {
    const reason = hardReject(model, ctx);
    if (reason) rejected.push({ id: model.id, reason });
    else eligible.push(model);
  }

  const pinned = [];
  for (const id of preferred) {
    const match = matchPreferred(eligible, id);
    if (match && !pinned.includes(match)) pinned.push(match);
  }

  const rest = eligible
    .filter((m) => !pinned.includes(m))
    .map((m) => ({
      m,
      score: scoreModel(m, {
        task,
        policy: usage,
        now,
        requirements,
        qualityTarget,
        surface: options.surface,
      }),
    }))
    .sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id))
    .map((row) => row.m);

  const ordered = [...pinned, ...rest];
  const chosen =
    qualityTarget === "diverse"
      ? diversifyBy(ordered, Math.max(1, limit), familyOf)
      : diversify(ordered, Math.max(1, limit));
  const strategy = resolveStrategy(mode, chosen.length, options.strategy || contract?.strategy);
  return {
    chosen,
    rejected,
    mode,
    task,
    policy: usage,
    qualityTarget,
    strategy,
    requirements,
    privateRoute,
    offline,
  };
}

/**
 * The ordered list of models FRIDAY may try for this request.
 *
 * Hard rules, in order: route mode, privacy, locality, provider, cloud opt-in,
 * cost, cooldown, role, retired, capability, streaming, tools, vision, context,
 * evidence. Whatever remains is scored, with the owner's explicit picks first.
 * An omitted quality target does not change that score.
 */
function selectEligible(models, options = {}) {
  return prepareRoute(models, options).chosen;
}

/** One sentence the log can show. It does not change who was selected. */
function explainPlan(route) {
  const ids = route.chosen.map((model) => model.id);
  const constraints = [];
  if (route.privateRoute) constraints.push("private keeps the prompt on this PC");
  if (route.mode === "cloud-only") constraints.push("cloud-only allows only cloud models");
  if (route.mode === "local-only") constraints.push("local-only allows only local models");
  if (route.offline && route.mode === "cloud-only") constraints.push("offline removes cloud");
  if (route.policy === "free-only")
    constraints.push("free-only blocks paid and unknown-cost models");
  if (route.policy === "paid-only") constraints.push("paid-only blocks free models");
  if (!ids.length) {
    const why = constraints.length
      ? constraints.join(", and ")
      : "no model passed the route, cost, health, and capability filters";
    return `none: ${why}.`;
  }
  const strategy = route.strategy;
  if (strategy === "cascade") {
    return `cascade: try ${ids.join(", then ")} and stop when the cheaper answer is enough, under ${route.mode}.`;
  }
  if (strategy === "race") {
    return `race: run ${ids.join(", ")} together and keep the first answer, under ${route.mode}.`;
  }
  if (
    strategy &&
    strategy !== "parallel" &&
    strategy !== "auto" &&
    strategy !== "single" &&
    strategy !== "fallback"
  ) {
    return `${strategy}: ${ids.join(", ")} under ${route.mode}.`;
  }
  if (
    strategy === "parallel" ||
    (ids.length >= 2 && route.mode === "multi" && strategy !== "fallback")
  ) {
    return `parallel: run ${ids.join(", ")} together under ${route.mode}.`;
  }
  if (ids.length > 1) {
    return `primary-fallback: try ${ids.join(", then ")} under ${route.mode}.`;
  }
  return `single: ${ids[0]} is the only model in the shortlist for ${route.mode}.`;
}

function resolveStrategy(mode, count, requested) {
  const asked = normaliseStrategy(requested);
  if (count === 0) return "single";
  if (asked !== "auto") return count < 2 && asked !== "single" ? "single" : asked;
  if (count >= 2 && mode === "multi") return "parallel";
  if (count > 1) return "fallback";
  return "single";
}

function planTypeFor(strategy, count) {
  if (count === 0) return "none";
  if (strategy === "parallel") return "parallel";
  if (strategy === "fallback") return "primary-fallback";
  if (strategy === "single") return "single";
  return strategy;
}

/** The owner-facing sentence. Hidden reasoning and secret material stay out. */
function publicDecision(text) {
  return String(text || "")
    .replace(/chain[- ]of[- ]thought/gi, "the decision")
    .replace(/\b(?:api[_ -]?key|secret|password)\s*[:=]\s*\S+/gi, "secret")
    .slice(0, 400);
}

function aggregationFor(strategy, mode) {
  if (strategy === "parallel" || strategy === "race") return "parallel";
  if (strategy === "cascade" || strategy === "pipeline") return "staged";
  if (strategy === "primary-critic") return "critic";
  if (strategy === "primary-verifier") return "verifier";
  if (strategy === "candidate-judge") return "judge";
  if (strategy === "fallback") return "fallback";
  if (mode === "multi") return "parallel";
  return "single";
}

const REFRESH_LAYERS = [
  "manifest",
  "credential",
  "catalogue",
  "detail",
  "pricing",
  "lifecycle",
  "health",
  "local-inventory",
  "artifact-integrity",
];

/**
 * Which catalogue layers a trigger may touch.
 * A chat turn refreshes only a stale catalogue and health. It never walks
 * every provider layer. The Models page is the one trigger that may.
 */
function planRefresh(trigger, state = {}) {
  const ttl = Number(state.catalogueTtlMs) > 0 ? Number(state.catalogueTtlMs) : 10 * 60 * 1000;
  const age = Number(state.catalogueAgeMs);
  const stale = !Number.isFinite(age) || age >= ttl;
  const name = String(trigger || "before-routing");
  const jitter = Math.abs(Number(state.jitterMs) || 0) % 60_000;
  if (name === "startup") {
    return {
      refresh: stale,
      layers: stale ? ["health", "catalogue"] : ["health"],
      reason: "startup checks health and a stale catalogue",
      delayMs: 0,
    };
  }
  if (name === "foreground") {
    return {
      refresh: true,
      layers: REFRESH_LAYERS.slice(),
      reason: "the Models page asked",
      delayMs: 0,
    };
  }
  if (name === "background") {
    return {
      refresh: true,
      layers: ["catalogue", "health", "lifecycle"],
      reason: "background interval",
      delayMs: jitter,
    };
  }
  if (name === "after-failure") {
    return {
      refresh: true,
      layers: ["catalogue", "health"],
      reason: "targeted refresh after a failure",
      delayMs: 0,
    };
  }
  if (!stale) {
    return { refresh: false, layers: [], reason: "catalogue is fresh", delayMs: 0 };
  }
  return {
    refresh: true,
    layers: ["catalogue", "health"],
    reason: "catalogue is stale enough to matter",
    delayMs: 0,
  };
}

/**
 * Background health is a cached models list. It spends no tokens.
 * Privacy mode skips the cloud half. A fresh cache is left alone.
 */
function planHealthProbe(state = {}) {
  const jitter = Math.abs(Number(state.jitterMs) || 0) % 60_000;
  if (state.privacy === true) {
    return {
      run: false,
      spend: "zero",
      reason: "privacy mode — cloud probe paused",
      delayMs: 0,
    };
  }
  const ttl = Number(state.ttlMs) > 0 ? Number(state.ttlMs) : 10 * 60 * 1000;
  const age = Number(state.ageMs);
  const fresh = Number.isFinite(age) && age >= 0 && age < ttl;
  if (fresh) {
    return { run: false, spend: "zero", reason: "health cache is fresh", delayMs: jitter };
  }
  return {
    run: true,
    spend: "zero",
    method: "models-list",
    bounded: true,
    delayMs: jitter,
    reason: "zero-spend models list",
  };
}

function providerOf(model) {
  return String(
    model?.provider || model?.providerId || model?.meta?.providerId || model?.meta?.provider || "",
  ).toLowerCase();
}

/** One GET that lists models or tags. No prompt and no request body. */
function zeroSpendTarget(model) {
  if (!model || !model.id) return null;
  const provider = providerOf(model);
  const kind = String(model.type || model.kind || model.meta?.kind || "");
  const local = kind === "local" || provider === "ollama" || model.local === true;
  if (provider === "ollama") {
    const base = String(model.endpoint || "http://127.0.0.1:11434").replace(/\/$/, "");
    return {
      id: model.id,
      provider,
      url: `${base}/api/tags`,
      method: "GET",
      body: null,
      network: false,
      spend: "zero",
      prompt: false,
    };
  }
  if (local) {
    const base = String(model.endpoint || model.baseUrl || "").replace(/\/$/, "");
    if (!base) return null;
    const url = /\/v1\/models$/.test(base) ? base : `${base.replace(/\/v1$/, "")}/v1/models`;
    return {
      id: model.id,
      provider,
      url,
      method: "GET",
      body: null,
      network: false,
      spend: "zero",
      prompt: false,
    };
  }
  const listUrl = String(model.listUrl || "");
  if (!/^https:\/\//i.test(listUrl)) return null;
  return {
    id: model.id,
    provider,
    url: listUrl,
    method: "GET",
    body: null,
    network: true,
    spend: "zero",
    prompt: false,
    hasKey: Boolean(model.hasKey),
  };
}

/**
 * Per-model probes. Privacy mode keeps local daemons and skips the network.
 * A fresh lastProbeAt is left alone. The plan never contains a key or a prompt.
 */
function planModelProbes(state = {}) {
  const models = Array.isArray(state.models) ? state.models : [];
  const privacy = state.privacy === true;
  const ttl = Number(state.ttlMs) > 0 ? Number(state.ttlMs) : 10 * 60 * 1000;
  const now = Number(state.now) || 0;
  const concurrency = Math.max(1, Math.min(3, Number(state.concurrency) || 3));
  const jitter = Math.abs(Number(state.jitterMs) || 0) % 60_000;
  const probes = [];
  for (const model of models) {
    const target = zeroSpendTarget(model);
    if (!target) continue;
    if (privacy && target.network) continue;
    if (target.network && !model.hasKey) continue;
    const last = Number(model.lastProbeAt || 0);
    if (last > 0 && now > 0 && now - last < ttl) continue;
    probes.push(target);
  }
  return { probes, concurrency, delayMs: jitter, spend: "zero", prompt: false };
}

async function runZeroSpendProbes(plan, options = {}) {
  const probes = Array.isArray(plan?.probes) ? plan.probes : [];
  const fetchImpl = options.fetchImpl;
  const health = options.health;
  const now = Number(options.now) || Date.now();
  if (!fetchImpl || !health || !probes.length) return { ran: 0 };
  const limit = Math.max(1, Math.min(3, Number(plan.concurrency) || 3));
  let cursor = 0;
  let ran = 0;
  async function worker() {
    while (cursor < probes.length) {
      const probe = probes[cursor];
      cursor += 1;
      const started = Date.now();
      try {
        const headers =
          typeof options.headersFor === "function" ? options.headersFor(probe) || {} : {};
        const res = await fetchImpl(probe.url, { method: "GET", headers, body: null });
        if (res && res.ok) health.noteSuccess(probe.id, Date.now() - started);
        else {
          health.noteFailure(
            probe.id,
            {
              message: `probe HTTP ${Number(res && res.status) || 0}`,
              status: Number(res && res.status) || 502,
              modelId: probe.id,
            },
            now,
          );
        }
      } catch (error) {
        health.noteFailure(
          probe.id,
          { message: String((error && error.message) || error), modelId: probe.id },
          now,
        );
      }
      if (typeof health.noteProbe === "function") health.noteProbe(probe.id, now);
      ran += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, probes.length) }, () => worker()));
  return { ran };
}

const BLOCKED_REPAIRS = new Set([
  "rotate-credentials",
  "privacy-mode",
  "upload-weights",
  "enable-paid",
  "delete-selected",
  "replace-pinned",
]);

/** Owner-only repairs stay refused. A stale cache may still be healed. */
function repairModelIssue(kind) {
  const name = String(kind || "").trim();
  if (!name || BLOCKED_REPAIRS.has(name)) {
    return { allowed: false, reason: "that repair stays with the owner" };
  }
  return { allowed: true, reason: "" };
}

/** A bad request is the same on every model. Outages and a bad answer may move. */
function midStreamFallback(category) {
  const resume = ["stream_failure", "timeout", "provider_error", "network"].includes(
    String(category || ""),
  );
  return {
    resume,
    mark: resume ? "Switching to another model." : "",
  };
}

function fallbackAdvances(category, options = {}) {
  const name = String(category || "");
  if (name === "context_overflow" && options.compacted === true) return true;
  return ![
    "invalid_request",
    "context_overflow",
    "content_filter",
    "region_block",
    "ipc_budget",
  ].includes(name);
}

function fallbackTier(candidate, failed) {
  const sameModel =
    candidate.id !== failed.id &&
    ((candidate.canonicalModelId && candidate.canonicalModelId === failed.canonicalModelId) ||
      (candidate.providerModelId && candidate.providerModelId === failed.providerModelId));
  if (sameModel) return 0;
  const provider = candidate.providerId || candidate.meta?.providerId || candidate.provider;
  const failedProvider = failed.providerId || failed.meta?.providerId || failed.provider;
  if (provider && provider === failedProvider) return 1;
  if (familyOf(candidate) === familyOf(failed) && provider !== failedProvider) return 2;
  return 3;
}

/**
 * Order the models still allowed after one failure.
 * Same model on another endpoint, then a sibling, then the same family, then
 * any other model that already passed privacy and billing. A provider outage
 * tries a different backend before another endpoint on the failed one.
 */
function orderFallbacks(candidates, failed, category, options = {}) {
  if (!failed || !fallbackAdvances(category, options)) return [];
  const providerWide =
    category === "offline" ||
    category === "provider_error" ||
    category === "invalid_key" ||
    category === "network" ||
    category === "kernel_down" ||
    category === "account_setting_required";
  const failedBackend = backendOf(failed);
  const rest = (candidates || []).filter((model) => model && model.id && model.id !== failed.id);
  const pool =
    category === "invalid_key" ? rest.filter((model) => backendOf(model) !== failedBackend) : rest;
  return pool
    .map((model, index) => ({
      model,
      index,
      tier: fallbackTier(model, failed),
      skip: providerWide && backendOf(model) === failedBackend ? 1 : 0,
    }))
    .sort((a, b) => a.skip - b.skip || a.tier - b.tier || a.index - b.index)
    .map((row) => row.model);
}

/** Keep the previous catalogue when the next generation is not a list of unique ids. */
function commitCatalogue(previous, next) {
  const prior = Array.isArray(previous) ? previous : [];
  if (!Array.isArray(next)) {
    return { ok: false, snapshot: prior, reason: "catalogue is not a list" };
  }
  const ids = new Set();
  for (const row of next) {
    const id = row && typeof row.id === "string" ? row.id.trim() : "";
    if (!id) return { ok: false, snapshot: prior, reason: "catalogue row has no id" };
    if (ids.has(id)) return { ok: false, snapshot: prior, reason: "catalogue row repeats an id" };
    ids.add(id);
  }
  return { ok: true, snapshot: next.slice(), reason: "" };
}

/** Internal trace. It is not the sentence the owner sees. */
function modelExecutionTrace(input = {}) {
  const rejected = Array.isArray(input.rejected) ? input.rejected : [];
  return {
    task: input.task || "chat",
    mode: input.mode || "auto",
    candidateCount: Array.isArray(input.candidates) ? input.candidates.length : 0,
    filtered: rejected
      .slice(0, 8)
      .map((row) => publicDecision(`${row.id || "model"}: ${row.reason || row.category || ""}`)),
    chosen: input.selected || null,
    planType: input.planType || "single",
    startedAt: Number(input.startedAt) || 0,
    endedAt: Number(input.endedAt) || 0,
    ttftMs: input.ttftMs ?? null,
    tokensPerSec: input.tokensPerSec ?? null,
    tokensIn: input.tokensIn ?? null,
    tokensOut: input.tokensOut ?? null,
    retries: Number(input.retries) || 0,
    fallbacks: Number(input.fallbacks) || 0,
    category: input.category || null,
    validation: input.validation || "unchecked",
    cost: input.cost ?? null,
  };
}

function planKey(parts) {
  let hash = 2166136261;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `route-${(hash >>> 0).toString(16)}`;
}

function familyOf(model) {
  const family = model?.meta?.family || model?.family || model?.capabilities?.registryId;
  return String(family || backendOf(model)).toLowerCase();
}

function diversifyBy(ordered, limit, keyFn) {
  const groups = new Map();
  for (const model of ordered) {
    const key = keyFn(model);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  if (groups.size <= 1) return ordered.slice(0, limit);
  const queues = [...groups.values()];
  const out = [];
  while (out.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      if (out.length >= limit) break;
      const next = queue.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

function costRank(model) {
  if (model.type === "local" || model.access === "free") return 0;
  if (model.access === "paid") return 2;
  return 1;
}

function orderCascade(list) {
  return [...list].sort((a, b) => costRank(a) - costRank(b));
}

/** A short or uncertain cheap answer is not enough to skip the stronger step. */
function cascadeAccepts(text) {
  const value = String(text || "").trim();
  if (value.length < 24) return false;
  if (/\b(i don't know|i do not know|cannot answer|unsure)\b/i.test(value)) return false;
  return true;
}

const TASK_PRESETS = Object.freeze({
  chat: { task: "chat", strategy: "single" },
  coding: { task: "coding", strategy: "fallback" },
  reasoning: { task: "reasoning", strategy: "cascade" },
  vision: { task: "vision", requirements: { vision: true } },
  voice: { task: "fast", requirements: { maxLatencyMs: 800 } },
  embeddings: { task: "embeddings" },
  summarization: { task: "chat" },
  ocr: { task: "vision", requirements: { vision: true } },
});

/** Rules only. This is not a local model classifier. */
function classifyTask(text) {
  const value = String(text || "");
  const lower = value.toLowerCase();
  const hindi = /[\u0900-\u097F]/.test(value);
  const finish = (row) => ({
    ...row,
    hindi,
    hinglish: hindi && /[A-Za-z]/.test(value),
    longContext: value.length > 4000,
  });
  if (!lower.trim()) return finish({ task: "chat", source: "rules", confidence: 0 });
  if (/\b(ocr|screenshot|read this image)\b/.test(lower)) {
    return finish({ task: "vision", source: "rules", confidence: 0.6, preset: "ocr" });
  }
  if (/\b(code|function|bug|typescript|python)\b/.test(lower)) {
    return finish({ task: "coding", source: "rules", confidence: 0.55 });
  }
  if (/\b(prove|reason|why)\b/.test(lower)) {
    return finish({ task: "reasoning", source: "rules", confidence: 0.4 });
  }
  if (/\b(embed|embedding)\b/.test(lower)) {
    return finish({ task: "embeddings", source: "rules", confidence: 0.7 });
  }
  if (/summar/.test(lower)) {
    return finish({ task: "chat", source: "rules", confidence: 0.45, preset: "summarization" });
  }
  if (/\b(translate|translation|anuvad)\b/.test(lower)) {
    return finish({ task: "chat", source: "rules", confidence: 0.5, preset: "translation" });
  }
  if (/\btools\b/.test(lower)) {
    return finish({ task: "tools", source: "rules", confidence: 0.45 });
  }
  return finish({ task: "chat", source: "rules", confidence: 0.3 });
}

function nudgePrior(prior, feedback) {
  const text = String(feedback || "");
  const current = Number(prior);
  const base = Number.isFinite(current) ? current : 0.5;
  if (!text.trim()) return { prior: base, reversible: true, changed: false };
  const bad = /achha nahi|not good|poor/i.test(text);
  const next = Math.max(0, Math.min(1, base + (bad ? -0.05 : 0.05)));
  return { prior: next, reversible: true, changed: true };
}

function localSafetyNet(models) {
  const local = (models || []).find(
    (model) => model && (model.type === "local" || model.kind === "local"),
  );
  return local?.id || null;
}

function routeFreeTurn(models, options = {}) {
  const privacy = options.privacy || options.requirements?.privacy;
  const sensitive = options.sensitive === true || !modelAccess.cloudAllowed(privacy);
  const quotaBlocked = options.quota && modelAccess.fitsQuota(options.quota) === false;
  const pool =
    sensitive || quotaBlocked
      ? (models || []).filter((model) => model.type === "local" || model.kind === "local")
      : models;
  const nudged = nudgePrior(options.prior, options.feedback);
  return prepareRoute(pool, {
    ...options,
    policy: "free-only",
    prior: nudged.prior,
    requirements: {
      ...(options.requirements || {}),
      ...(sensitive ? { privacy: "private" } : {}),
    },
  });
}

function hedgeFree(models, options = {}) {
  const decision = routeFreeTurn(models, { ...options, limit: 2 });
  const ids = (decision.chosen || []).map((model) => model.id);
  const local = localSafetyNet(models);
  return {
    candidates: ids.length ? ids : local ? [local] : [],
    cancelLoser: ids.length === 2,
    local,
    reasons: (decision.rejected || []).slice(0, 6).map((row) => `${row.id}: ${row.reason}`),
  };
}

function previewRoute(models, prompt, options = {}) {
  const judged = classifyTask(prompt);
  const preset = TASK_PRESETS[judged.preset || judged.task] || TASK_PRESETS.chat;
  return {
    judged,
    plan: planRoute(models, {
      ...preset,
      ...options,
      task: options.task || judged.task,
    }),
  };
}

/** Role assignment for a strategy. The judge is a different backend when one exists. */
function assignSteps(models, strategy) {
  const list = (models || []).filter((model) => model && model.id);
  const name = resolveStrategy("multi", list.length, strategy);
  const step = (model, role) => ({ modelEndpointId: model.id, role });
  if (!list.length) return [];
  if (name === "single") return [step(list[0], "answer")];
  if (name === "fallback") {
    return list.map((model, index) => step(model, index === 0 ? "primary" : "fallback"));
  }
  if (name === "cascade") {
    const ordered = orderCascade(list);
    return ordered.map((model, index) =>
      step(model, index === ordered.length - 1 ? "strong" : "cheap"),
    );
  }
  if (name === "race") {
    return list.map((model) => step(model, "racer"));
  }
  if (name === "primary-critic") {
    return [step(list[0], "primary"), step(list[1], "critic")];
  }
  if (name === "primary-verifier") {
    return [step(list[0], "primary"), step(list[1], "verifier")];
  }
  if (name === "pipeline") {
    const roles = ["planner", "specialist", "synthesizer"];
    return list.slice(0, 3).map((model, index) => step(model, roles[index] || "specialist"));
  }
  if (name === "candidate-judge") {
    let judgeAt = list.findIndex(
      (model, index) => index > 0 && backendOf(model) !== backendOf(list[0]),
    );
    if (judgeAt < 0) judgeAt = list.length - 1;
    const judge = list[judgeAt];
    const rest = list.filter((_, index) => index !== judgeAt);
    return [...rest.map((model) => step(model, "candidate")), step(judge, "judge")];
  }
  return list.map((model) => step(model, "peer"));
}

/**
 * Prompt for a later role. The owner's text stays in the prompt.
 * Critic, verifier, and judge see earlier drafts and do not replace them.
 */
function compileRoleTurn({ strategy, role, prompt, drafts = [] }) {
  const base = String(prompt || "");
  const prior = drafts
    .map(
      (draft, index) =>
        `#${index + 1} (${draft.modelId || draft.role || "model"})\n${draft.text || ""}`,
    )
    .filter((line) => line.trim())
    .join("\n\n");
  if (
    !prior ||
    role === "answer" ||
    role === "primary" ||
    role === "peer" ||
    role === "candidate" ||
    role === "planner" ||
    role === "cheap" ||
    role === "racer"
  ) {
    return base;
  }
  if (role === "strong") {
    return `${base}\n\nEarlier answer:\n${prior}\n\nGive a stronger answer only if the earlier one is incomplete.`;
  }
  if (role === "critic") {
    return `${base}\n\nDraft answer:\n${prior}\n\nList concrete errors only. Do not rewrite the whole answer.`;
  }
  if (role === "verifier") {
    return `${base}\n\nAnswer to check:\n${prior}\n\nSay whether it is correct and why. Do not invent a new answer.`;
  }
  if (role === "judge") {
    return `${base}\n\nCandidate answers:\n${prior}\n\nPick the best candidate and give one final answer. Name which candidate you used.`;
  }
  if (role === "specialist" || role === "synthesizer" || role === "fallback") {
    return strategy === "fallback" ? base : `${base}\n\nPrevious step:\n${prior}`;
  }
  return base;
}

/**
 * Explainable plan whose candidate ids are selectEligible's ids, in order.
 * planType is parallel, primary-fallback, single, or none.
 */
function planRoute(models, options = {}) {
  const route = prepareRoute(models, options);
  let chosen = route.chosen;
  let held = "";
  if (options.failed && options.failed.id) {
    const known =
      chosen.find((model) => model.id === options.failed.id) ||
      (models || []).find((model) => model && model.id === options.failed.id) ||
      options.failed;
    const category = options.failed.category || classifyError(options.failed.error).category;
    if (!fallbackAdvances(category, options)) {
      chosen = [];
      held = "a deterministic request error does not move to another model";
    } else {
      chosen = orderFallbacks(chosen, known, category, options);
    }
  }
  const candidates = chosen.map((model) => model.id);
  const strategy = chosen.length ? route.strategy : "single";
  const planType = planTypeFor(strategy, candidates.length);
  const why = publicDecision(held || explainPlan({ ...route, chosen }));
  const winner = chosen[0] || null;
  const whyThisModel = winner
    ? [
        winner.type === "local" ? "local" : winner.access === "free" ? "free" : winner.access,
        winner.meta?.resident || winner.meta?.loaded ? "loaded" : "",
        route.task && winner.capabilities?.[TASK_CAPABILITY[route.task] || ""]
          ? TASK_CAPABILITY[route.task]
          : "",
      ]
        .filter(Boolean)
        .join(", ") || "passed the filters"
    : "";
  const steps = assignSteps(chosen, strategy);
  const explanation = [
    why,
    ...route.rejected.slice(0, 8).map((row) => publicDecision(`${row.id}: ${row.reason}`)),
  ];
  const trace = [
    { stage: "filter", kept: candidates.length, dropped: route.rejected.length },
    { stage: "score", qualityTarget: route.qualityTarget },
    { stage: "plan", strategy, planType },
  ];
  if (options.failed && options.failed.id) {
    trace.push({ stage: "fallback", kept: candidates.length });
  }
  return {
    planId: planKey([route.mode, route.task, route.policy, strategy, candidates.join(",")]),
    planType,
    strategy,
    steps,
    task: route.task,
    mode: route.mode,
    policy: route.policy,
    qualityTarget: route.qualityTarget,
    candidates,
    selected: candidates[0] || null,
    rejected: route.rejected,
    constraints: {
      mode: route.mode,
      policy: route.policy,
      qualityTarget: route.qualityTarget,
      strategy,
      privacy: route.privateRoute ? "private" : route.requirements.privacy || "standard",
      offline: route.offline,
      task: route.task,
    },
    budgets: {
      maxCalls: Math.max(steps.length, candidates.length, 1),
      concurrency:
        strategy === "parallel" || strategy === "race" ? Math.max(candidates.length, 1) : 1,
      retries: 1,
    },
    aggregation: aggregationFor(strategy, route.mode),
    information: {
      fanOut: strategy === "parallel" || strategy === "race",
      reason:
        strategy === "parallel" || strategy === "race"
          ? "the owner asked for more than one model"
          : "one answer is enough until a declared multi strategy",
    },
    trace,
    explanation,
    why,
    whyThisModel,
  };
}

/**
 * Cloud free-class candidates that may be live-probed for this request.
 *
 * This mirrors the hard route/capability/owner-pool boundaries above but
 * intentionally accepts UNVERIFIED free-class evidence: probing is what can
 * promote those candidates to verified. It never probes a model that the
 * active mode or task could not actually use.
 */
function selectVerificationCandidates(models, options = {}) {
  const {
    task = "chat",
    preferred = [],
    policy = DEFAULT_POLICY,
    health = null,
    now = Date.now(),
    mode = DEFAULT_ROUTE_MODE,
    offline = false,
  } = options;
  const usage = normalisePolicy(policy);
  if (usage === "paid-only" || offline) return [];
  const requirements = normalizeRoutingRequirements(options.requirements || {});
  // A private turn must not send a probe prompt off this PC.
  if (requirements.privacy === "private" || options.qualityTarget === "private") return [];
  const allowedTypes = typesForMode(mode, offline);
  if (!allowedTypes.includes("cloud")) return [];
  const neededCap = TASK_CAPABILITY[task] || null;
  const described = (models || []).map((model) => describe(model, health, now));
  const exclusive = options.exclusive ?? usesOwnerPool(mode, preferred);
  const pool =
    exclusive && (preferred || []).length
      ? described.filter((model) => (preferred || []).some((id) => matchPreferred([model], id)))
      : described;
  const eligible = pool.filter((model) => {
    if (model.type === "local" || model.coolingDown) return false;
    if (!modelAccess.isFreeCandidate(model.accessRecord)) return false;
    if (neededCap && !model.capabilities[neededCap]) return false;
    return true;
  });
  const pinned = [];
  for (const id of preferred || []) {
    const match = matchPreferred(eligible, id);
    if (match && !pinned.includes(match)) pinned.push(match);
  }
  const rest = eligible
    .filter((model) => !pinned.includes(model))
    .sort((a, b) => {
      const rank =
        modelAccess.candidateRank(b.accessRecord) - modelAccess.candidateRank(a.accessRecord);
      if (rank) return rank;
      return (
        scoreModel(b, { task, policy: usage, now }) - scoreModel(a, { task, policy: usage, now }) ||
        a.id.localeCompare(b.id)
      );
    });
  return [...pinned, ...rest];
}

/** Which backend a candidate really talks to — one quota, one failure mode. */
function backendOf(model) {
  if ((model?.type || model?.meta?.kind) === "local")
    return `local:${String(model?.provider || model?.meta?.providerId || "local").toLowerCase()}`;
  return `cloud:${String(model?.meta?.providerId || model?.provider || "unknown").toLowerCase()}`;
}

/**
 * Spread the shortlist across backends.
 *
 * A single provider whose quota is exhausted used to fill every candidate
 * slot (four OpenAI ids, all 429), so healthy local engines and other
 * connected providers were never tried and chat reported total failure.
 * Score order is preserved inside each backend; only the interleaving across
 * backends changes, so nothing is added, removed or reprioritised unfairly.
 */
function diversify(ordered, limit) {
  const groups = new Map();
  for (const model of ordered) {
    const key = backendOf(model);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  if (groups.size <= 1) return ordered.slice(0, limit);
  const queues = [...groups.values()];
  const out = [];
  while (out.length < limit && queues.some((q) => q.length)) {
    for (const queue of queues) {
      if (out.length >= limit) break;
      const next = queue.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * Explicit parallel multi-model execution.
 *
 * Never automatic: the caller has to ask for it, because every extra model is
 * a real extra request and real extra tokens. The returned list is the set to
 * run CONCURRENTLY; the Brain then synthesises one answer from the results.
 */
function selectParallel(models, options = {}) {
  const preferred = options.preferred || options.selectedModelIds || [];
  const defaultCount = preferred.length >= 2 ? preferred.length : 3;
  const count = Math.max(2, Math.min(Number(options.count) || defaultCount, 5));
  const chosen = selectEligible(models, {
    ...options,
    mode: options.mode || "multi",
    limit: Math.max(count, Number(options.limit) || count),
  });
  const unique = [];
  for (const model of chosen) {
    if (!unique.some((m) => m.id === model.id)) unique.push(model);
    if (unique.length >= count) break;
  }
  return unique;
}

/**
 * The message the owner sees when nothing could answer. Honest, actionable
 * and free of stack traces — the raw errors stay in the logs.
 */
function explainFailure({
  checked = [],
  failures = [],
  policy = DEFAULT_POLICY,
  offline = false,
} = {}) {
  if (
    failures.length > 0 &&
    failures.every(
      (failure) =>
        (failure.category || classifyError(failure.error).category) === "invalid_request",
    )
  ) {
    return [
      "This request was rejected as written, so FRIDAY did not send it to another model.",
      "Doosra model par nahi bheja.",
    ].join("\n");
  }
  const lines = [
    offline
      ? "FRIDAY is offline, so only local models can answer — and none is running."
      : "FRIDAY couldn't connect to an available AI model.",
  ];

  if (checked.length) {
    lines.push("", "Checked:");
    for (const label of [...new Set(checked)].slice(0, 8)) lines.push(`✓ ${label}`);
  }
  if (failures.length) {
    lines.push("", "Unavailable:");
    for (const failure of failures.slice(0, 8)) {
      const category = failure.category || classifyError(failure.error).category;
      const reason = HEALTH_REASON[category] || "failed";
      const step = failure.nextStep || NEXT_STEP[category] || "";
      const http = failure.facts?.status ? ` HTTP ${failure.facts.status}` : "";
      const code = failure.facts?.code ? ` ${failure.facts.code}` : "";
      lines.push(
        `• ${failure.label || failure.modelId} — ${reason}${http}${code}${step ? `. ${step}` : ""}`,
      );
    }
  }
  lines.push(
    "",
    offline
      ? "Reconnect to the internet, or start a local model (Ollama / LM Studio) so FRIDAY can keep working offline."
      : normalisePolicy(policy) === "free-only"
        ? "Start a local model (Ollama / LM Studio) or connect a free cloud provider in Models. Paid models stay blocked while usage is set to Free only."
        : normalisePolicy(policy) === "paid-only"
          ? "Connect a paid cloud provider in Models, or turn off Paid-only. Free and local models stay excluded while usage is set to Paid only."
          : "Start a local model or connect another provider in Models.",
  );

  return lines.join("\n");
}

/**
 * Honest empty-pool copy when route mode and cost mode together leave
 * nothing eligible. Never silently switches mode; never returns a stack trace.
 */
function explainUnavailable({
  mode = DEFAULT_ROUTE_MODE,
  policy = DEFAULT_POLICY,
  offline = false,
  preferred = [],
  unlocked = true,
  checked = [],
  failures = [],
} = {}) {
  const route = normaliseRouteMode(mode);
  const usage = normalisePolicy(policy);
  const picked = (preferred || []).filter(Boolean);

  if (route === "local-only" && usage === "paid-only") {
    return [
      "No paid local models exist — local models are always free.",
      "Turn off Paid-only, or switch off Local-only so a paid cloud model can be used.",
    ].join("\n");
  }
  if (usage === "paid-only" && !unlocked) {
    return "Paid-only is on, but paid AI access is off (or the kill switch is on) — no model can answer. Turn paid access on, or switch off Paid-only.";
  }
  if (usage === "paid-only" && route === "cloud-only" && picked.length) {
    return "None of the cloud models you picked are paid-classified and eligible. Pick a paid cloud model, or turn off Paid-only.";
  }
  if (usage === "paid-only") {
    return "No paid model is eligible right now. Connect a paid cloud provider in Models, pick one, and keep paid access on — or switch off Paid-only.";
  }
  if (usage === "free-only") {
    const rateLimited =
      Array.isArray(failures) &&
      failures.length > 0 &&
      failures.every(
        (f) =>
          f.category === "rate_limited" ||
          f.category === "daily_limit" ||
          f.category === "quota_exceeded",
      );
    if (rateLimited) {
      return "FREE_MODEL_TEMPORARILY_UNAVAILABLE: verified free models are rate-limited or quota-exhausted. Wait for the reset, or connect another free provider. Paid and unknown-cost models stay blocked while usage is Free only.";
    }
    if (route === "cloud-only") {
      return picked.length
        ? "NO_FREE_MODEL_AVAILABLE: none of the cloud models you picked are verified free. Pick a verified free cloud model, or turn off Free-only. Paid and unknown-cost models are not used as fallback."
        : "NO_FREE_MODEL_AVAILABLE: Cloud-only + Free-only has no verified free cloud model. Connect a provider whose API models are proven free, or change route or cost mode. Paid and unknown-cost models are not used as fallback.";
    }
    return "NO_FREE_MODEL_AVAILABLE: no verified free local or cloud model could answer. Paid and unknown-cost models stay blocked while usage is Free only.";
  }
  if ((route === "local-only" || route === "cloud-only") && picked.length) {
    return `None of the models you picked are eligible under ${route} with the current cost mode. Change the selection, or change Local-only / Cloud-only / cost mode.`;
  }
  return explainFailure({ checked, failures, policy: usage, offline });
}

/**
 * Canonical lifecycle kinds stamped onto the existing models:* IPC payloads.
 * Not a second event bus — Brain and Electron already share registry-changed,
 * health-changed, and route-mode; `kind` tells them *why* the snapshot moved.
 */
const MODEL_EVENT_KINDS = [
  "MODEL_DISCOVERED",
  "MODEL_UPDATED",
  "MODEL_VERIFIED",
  "MODEL_FAILED",
  "MODEL_RATE_LIMITED",
  "MODEL_EXHAUSTED",
  "MODEL_RETIRED",
  "MODEL_REMOVED",
  "PROVIDER_CONNECTED",
  "PROVIDER_DISCONNECTED",
  "API_KEY_CHANGED",
  "ROUTE_CHANGED",
];

function lifecycleKindFromHealth(category) {
  const cat = String(category || "").toLowerCase();
  if (cat === "rate_limited" || cat === "daily_limit") return "MODEL_RATE_LIMITED";
  if (cat === "quota_exceeded") return "MODEL_EXHAUSTED";
  if (cat === "model_unavailable") return "MODEL_RETIRED";
  if (cat === "available") return "MODEL_VERIFIED";
  return "MODEL_FAILED";
}

const LANES = ["local", "cloud-free", "cloud-paid", "multi-local", "hybrid", "manual"];

/**
 * Saved cloud selection. `null` means the owner has not saved one yet, so
 * automatic routing keeps today's free-first pool. A saved list is a hard
 * filter for cloud models. Local models are not cloud-allowlisted.
 */
function normaliseAllowlist(raw) {
  if (raw == null) return null;
  const source = Array.isArray(raw) ? { ids: raw } : raw;
  if (!source || typeof source !== "object") return null;
  const ids = Array.isArray(source.ids) ? source.ids : [];
  return {
    saved: true,
    ids: [
      ...new Set(
        ids
          .map((id) => String(id || "").trim())
          .filter((id) => id && !/\b(?:sk-[a-z0-9]{8,}|api[_-]?key|bearer)\b/i.test(id)),
      ),
    ],
    paidEnabled: source.paidEnabled === true,
  };
}

function budgetNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Caps only. Missing caps do not invent a spend. A spent cap refuses the paid lane. */
function budgetDecision(raw, estimateUsd = 0) {
  if (raw == null || typeof raw !== "object") {
    return { allows: true, reason: "no budget cap is set", configured: false };
  }
  const perRequest = budgetNumber(raw.perRequestUsd);
  const perDay = budgetNumber(raw.perDayUsd);
  const perMonth = budgetNumber(raw.perMonthUsd);
  const spentDay = Number(raw.spentDayUsd) || 0;
  const spentMonth = Number(raw.spentMonthUsd) || 0;
  const estimate = Number(estimateUsd) || 0;
  if (perRequest != null && estimate > perRequest) {
    return { allows: false, reason: "this request is over the per-request cap", configured: true };
  }
  if (perDay != null && (spentDay >= perDay || spentDay + estimate > perDay)) {
    return { allows: false, reason: "the daily budget is spent", configured: true };
  }
  if (perMonth != null && (spentMonth >= perMonth || spentMonth + estimate > perMonth)) {
    return { allows: false, reason: "the monthly budget is spent", configured: true };
  }
  return { allows: true, reason: "budget remains", configured: true };
}

function paidLaneOpen(options = {}) {
  const policy = normalisePolicy(
    options.policy || (options.costPolicy ? policyForCostMode(options.costPolicy) : DEFAULT_POLICY),
  );
  if (policy !== "allow-paid" && policy !== "paid-only") return false;
  if (options.paidEnabled !== true) return false;
  if (options.firewallAllowsPaid !== true) return false;
  if (options.budgetAllows === false) return false;
  return true;
}

function localCapableLoaded(models) {
  return (models || []).some((model) => {
    if (!modelAccess.isLocalModel(model)) return false;
    if (model.status === "unavailable" || model.meta?.loaded === false) return false;
    const provider = String(
      model.providerId || model.meta?.providerId || model.provider || "",
    ).toLowerCase();
    if (provider === "lmstudio" || String(model.id || "").startsWith("lmstudio:")) {
      return model.meta?.loaded === true || model.meta?.resident === true;
    }
    return true;
  });
}

/**
 * Which lane answers first. This does not score models and does not call a
 * provider. Voice and chat share the lane; surface only changes later scoring.
 */
function decideLane(models, options = {}) {
  const mode = normaliseRouteMode(options.mode || options.routeMode);
  const requirements = normalizeRoutingRequirements(options.requirements || {});
  const privateRoute = requirements.privacy === "private" || options.qualityTarget === "private";
  const offline = Boolean(options.offline);
  const paidOpen = paidLaneOpen(options);
  if (mode === "manual") {
    return { lane: "manual", handoff: [], reason: "manual uses the owner's exact model", paidOpen };
  }
  if (mode === "multi") {
    return { lane: "multi-local", handoff: [], reason: "multi uses the owner's pool", paidOpen };
  }
  if ((privateRoute || offline) && mode === "cloud-only") {
    return {
      lane: "local",
      handoff: [],
      reason: "private or offline routing cannot use a cloud-only mode",
      paidOpen: false,
    };
  }
  if (privateRoute || offline || mode === "local-only") {
    return {
      lane: "local",
      handoff: ["local"],
      reason:
        privateRoute || offline
          ? "privacy or offline keeps this turn on this PC"
          : "local-only allows only local models",
      paidOpen: false,
    };
  }
  if (mode === "cloud-only") {
    const paidOnly = normalisePolicy(options.policy) === "paid-only";
    return {
      lane: paidOpen && paidOnly ? "cloud-paid" : "cloud-free",
      handoff: paidOpen ? ["cloud-free", "cloud-paid"] : ["cloud-free"],
      reason: "cloud-only stays on cloud lanes",
      paidOpen,
    };
  }
  const handoff = localCapableLoaded(models)
    ? ["local", "cloud-free", ...(paidOpen ? ["cloud-paid"] : [])]
    : ["cloud-free", "local", ...(paidOpen ? ["cloud-paid"] : [])];
  return {
    lane: handoff[0],
    handoff,
    reason: localCapableLoaded(models)
      ? "a capable local model is available, so the local lane is first"
      : "no capable local model is loaded, so verified free cloud is first",
    paidOpen,
  };
}

function allowlistHit(model, ids) {
  const keys = [
    model.id,
    model.providerModelId,
    model.meta?.modelName,
    model.meta?.providerModelId,
  ].filter(Boolean);
  return keys.some((key) => ids.includes(key));
}

function filterCloudAllowlist(models, allowlist) {
  if (!allowlist) return models || [];
  return (models || []).filter((model) => allowlistHit(model, allowlist.ids));
}

function packRoute(modelsOut, decision, options, surface) {
  const mode = normaliseRouteMode(options.mode || options.routeMode);
  const task = normaliseRoutingTask(options.task || "chat");
  const policy = normalisePolicy(
    options.policy || (options.costPolicy ? policyForCostMode(options.costPolicy) : DEFAULT_POLICY),
  );
  const strategy = resolveStrategy(mode, modelsOut.length, options.strategy);
  const winner = modelsOut[0] || null;
  const handler = winner
    ? require("./provider-handler.cjs").getHandler(winner.providerId || winner.meta?.providerId)
    : null;
  const whyThisModel = winner
    ? [
        winner.type === "local" || winner.kind === "local"
          ? "local"
          : winner.access === "free"
            ? "free"
            : winner.access,
        winner.meta?.resident || winner.meta?.loaded ? "loaded" : "",
        handler ? `handler ${handler.id}` : "",
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  const hint = surface === "voice" ? "latency-first" : "quality-first";
  const exclusions = Array.isArray(options.traceExclusions) ? options.traceExclusions : [];
  const providerId = winner ? winner.providerId || winner.meta?.providerId || null : null;
  const nativeId = winner ? winner.meta?.modelName || winner.providerModelId || winner.id : null;
  return {
    lane: decision.lane,
    handoff: decision.handoff,
    reason: publicDecision(decision.reason),
    paidOpen: decision.paidOpen === true,
    surface: surface || "chat",
    surfaceHint: hint,
    models: modelsOut,
    candidates: modelsOut.map((model) => model.id),
    selected: winner ? winner.id : null,
    planType: planTypeFor(strategy, modelsOut.length),
    strategy,
    task,
    mode,
    policy,
    why: publicDecision(`${decision.lane}: ${decision.reason}`),
    whyThisModel,
    handler: handler ? handler.id : null,
    decisionTrace: {
      catalogue: "canonical",
      evidence:
        winner?.accessRecord?.verification || winner?.meta?.verification || winner?.access || null,
      candidates: modelsOut.map((model) => ({
        id: model.id,
        providerId: model.providerId || model.meta?.providerId || null,
        access: model.access || null,
      })),
      exclusions,
      choice: winner ? winner.id : null,
      catalogueId: winner && providerId ? `${providerId}/${nativeId}` : null,
      lane: decision.lane,
    },
  };
}

/**
 * The one funnel. Chat, voice, and any other caller share this function.
 * `selectEligible` still applies the hard gates. Lane order is applied after
 * that, so a loaded local model is tried before verified free cloud, and a
 * paid model is absent unless paid access, the billing firewall, and the
 * budget all allow it.
 */
function routeRequest(models, options = {}) {
  require("./provider-registry.cjs").ensureHandlers();
  const surface =
    options.surface === "voice" || options.surface === "chat" ? options.surface : undefined;
  const decision = decideLane(models, options);
  const mode = normaliseRouteMode(options.mode || options.routeMode);
  const laneOptions = { ...options, surface };
  if (mode === "manual" || mode === "multi" || decision.handoff.length === 0) {
    const picked = selectEligible(models, laneOptions);
    const modelsOut = decision.paidOpen
      ? picked
      : picked.filter((model) => model.access !== "paid");
    const next = { ...decision };
    if (mode === "multi") {
      const allLocal =
        modelsOut.length > 0 && modelsOut.every((model) => modelAccess.isLocalModel(model));
      next.lane = allLocal || modelsOut.length === 0 ? "multi-local" : "hybrid";
    }
    return packRoute(modelsOut, next, options, surface);
  }
  const allowlist = normaliseAllowlist(options.allowlist);
  const localPool = [];
  const cloudPool = [];
  for (const model of models || []) {
    if (modelAccess.isLocalModel(model)) localPool.push(model);
    else cloudPool.push(model);
  }
  require("./provider-hub-cloud.cjs").ensureReady();
  require("./provider-hub-local.cjs").ensureReady();
  const localView = require("./model-routing-local.cjs").prepare(localPool);
  const localPick = decision.handoff.includes("local")
    ? selectEligible(localPool, laneOptions)
    : [];
  const cloudFiltered = filterCloudAllowlist(cloudPool, allowlist);
  const cloudPick = decision.handoff.some((lane) => lane.startsWith("cloud"))
    ? selectEligible(cloudFiltered, laneOptions)
    : [];
  const split = require("./model-routing-cloud.cjs").splitLanes(cloudPick, {
    paidOpen: decision.paidOpen,
  });
  const groups = {
    local: localPick,
    "cloud-free": preferNewestFree(split.free, { failedIds: options.failedIds, allowlist }).order,
    "cloud-paid": split.paid,
  };
  const droppedPaid = split.droppedPaid;
  laneOptions.traceExclusions = [
    ...localView.unavailable,
    ...(droppedPaid ? [{ reason: "paid lane is closed", access: "paid" }] : []),
  ];
  const limit = Math.max(1, Number(options.limit) || 4);
  const active = decision.handoff.filter((lane) => (groups[lane] || []).length);
  const reserve = Math.min(Math.max(0, active.length - 1), Math.max(0, limit - 1));
  const primarySlots = limit - reserve;
  const ordered = [];
  const preferred = options.preferred || [];
  for (const id of preferred) {
    const found = matchPreferred([...localPick, ...cloudPick], id);
    if (!found || ordered.includes(found)) continue;
    if (found.access === "paid" && !decision.paidOpen) continue;
    ordered.push(found);
  }
  const primary = active[0];
  let primaryTaken = 0;
  if (primary) {
    for (const model of groups[primary]) {
      if (ordered.length >= limit || primaryTaken >= primarySlots) break;
      if (ordered.includes(model)) continue;
      ordered.push(model);
      primaryTaken += 1;
    }
  }
  for (const lane of active.slice(1)) {
    for (const model of groups[lane]) {
      if (ordered.length >= limit) break;
      if (!ordered.includes(model)) {
        ordered.push(model);
        break;
      }
    }
  }
  const reason = droppedPaid
    ? `${decision.reason}. Paid models stay off this turn.`
    : decision.reason;
  const spans =
    mode === "hybrid" &&
    ordered.some((model) => modelAccess.isLocalModel(model)) &&
    ordered.some((model) => !modelAccess.isLocalModel(model));
  return packRoute(
    ordered,
    { ...decision, lane: spans ? "hybrid" : active[0] || decision.lane, reason },
    { ...options, traceExclusions: laneOptions.traceExclusions },
    surface,
  );
}

function modelVersion(model) {
  const name = String(model?.providerModelId || model?.meta?.modelName || model?.id || "");
  const match = name.match(/(\d+(?:\.\d+){0,3})/);
  return match ? match[1].split(".").map((part) => Number(part) || 0) : [0];
}

function compareVersion(left, right) {
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function freeFamilyKey(model) {
  const provider = String(model?.providerId || model?.meta?.providerId || "cloud");
  const name = String(model?.providerModelId || model?.meta?.modelName || model?.id || "")
    .toLowerCase()
    .replace(/(\d+(?:\.\d+){0,3})/g, "#");
  return `${provider}:${name}`;
}

/**
 * Newest verified-free model in each family. A failed newest id falls back
 * to the previous verified version. Unverified rows keep their order.
 */
function preferNewestFree(models, options = {}) {
  const failed = new Set((options.failedIds || []).map((id) => String(id)));
  const allow = normaliseAllowlist(options.allowlist);
  const verified = [];
  const rest = [];
  for (const model of models || []) {
    if (!model || modelAccess.isLocalModel(model)) {
      rest.push(model);
      continue;
    }
    if (allow && !allowlistHit(model, allow.ids)) {
      rest.push(model);
      continue;
    }
    const record = modelAccess.accessOf(model);
    if (!modelAccess.isVerifiedFree(record)) {
      rest.push(model);
      continue;
    }
    verified.push(model);
  }
  const groups = new Map();
  for (const model of verified) {
    const key = freeFamilyKey(model);
    const list = groups.get(key) || [];
    list.push(model);
    groups.set(key, list);
  }
  const front = [];
  const deferred = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => compareVersion(modelVersion(b), modelVersion(a)));
    const live = sorted.filter(
      (model) => !failed.has(String(model.id)) && !failed.has(String(model.providerModelId || "")),
    );
    const dead = sorted.filter(
      (model) => failed.has(String(model.id)) || failed.has(String(model.providerModelId || "")),
    );
    if (live[0]) front.push(live[0]);
    deferred.push(...live.slice(1), ...dead);
  }
  return { chosen: front[0] || null, order: [...front, ...deferred, ...rest] };
}

function spendStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Add one paid charge. The caller passes `at`. A secret in the model id is refused. */
function recordSpend(raw, event = {}) {
  const amount = Number(event.usd);
  const at = spendStamp(event.at);
  const modelId = String(event.modelId || "").slice(0, 120);
  const current = raw && typeof raw === "object" ? raw : {};
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, reason: "spend must be a non-negative number", budget: current, log: [] };
  }
  if (!at) {
    return { ok: false, reason: "spend needs an explicit time", budget: current, log: [] };
  }
  if (/\b(?:sk-[a-z0-9]{8,}|api[_-]?key|bearer)\b/i.test(modelId)) {
    return { ok: false, reason: "spend row refused a secret", budget: current, log: [] };
  }
  const day = at.slice(0, 10);
  const month = at.slice(0, 7);
  const sameDay = current.spentDay === day;
  const sameMonth = current.spentMonth === month;
  const spentDayUsd = Number(
    ((sameDay || !current.spentDay ? Number(current.spentDayUsd) || 0 : 0) + amount).toFixed(6),
  );
  const spentMonthUsd = Number(
    ((sameMonth || !current.spentMonth ? Number(current.spentMonthUsd) || 0 : 0) + amount).toFixed(
      6,
    ),
  );
  const budget = {
    perRequestUsd: current.perRequestUsd ?? null,
    perDayUsd: current.perDayUsd ?? null,
    perMonthUsd: current.perMonthUsd ?? null,
    spentDayUsd,
    spentMonthUsd,
    spentDay: day,
    spentMonth: month,
  };
  const prior = Array.isArray(event.log) ? event.log : [];
  const log = prior
    .filter((row) => row && typeof row === "object")
    .slice(-49)
    .map((row) => ({
      at: String(row.at || ""),
      usd: Number(row.usd) || 0,
      modelId: String(row.modelId || "").slice(0, 120),
      lane: "cloud-paid",
    }))
    .filter((row) => row.at && !/\b(?:sk-[a-z0-9]{8,}|api[_-]?key|bearer)\b/i.test(row.modelId));
  log.push({ at, usd: amount, modelId, lane: "cloud-paid" });
  const decision = budgetDecision(budget, 0);
  return { ok: true, budget, log, allows: decision.allows, reason: decision.reason };
}

const LOCAL_ANSWER_STRATEGIES = ["show-all", "first-good", "majority", "judged"];

function localDrafts(answers) {
  return (answers || []).map((row) => ({
    modelId: String(row?.modelId || ""),
    text: String(row?.text || ""),
    error: row?.error ? String(row.error).slice(0, 180) : "",
  }));
}

/** Combine finished local drafts. A judge is never asked to pick a provider. */
function combineLocalAnswers(answers, options = {}) {
  const strategy = LOCAL_ANSWER_STRATEGIES.includes(options.strategy)
    ? options.strategy
    : "show-all";
  const drafts = localDrafts(answers);
  if (strategy === "first-good") {
    const hit = drafts.find((row) => row.text && !row.error);
    return { strategy, answers: drafts, text: hit?.text || "", chosen: hit?.modelId || null };
  }
  if (strategy === "majority") {
    const counts = new Map();
    for (const row of drafts) {
      const key = row.text.trim().toLowerCase();
      if (!key || row.error) continue;
      const bucket = counts.get(key) || { text: row.text, n: 0, modelId: row.modelId };
      bucket.n += 1;
      counts.set(key, bucket);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    return {
      strategy,
      answers: drafts,
      text: best?.text || "",
      chosen: best?.modelId || null,
      votes: best?.n || 0,
    };
  }
  if (strategy === "judged") {
    if (options.judgeEnabled !== true || !options.judgeModelId) {
      return {
        strategy,
        answers: drafts,
        refused: true,
        reason: "the judge stays off until the owner enables a model",
      };
    }
    return {
      strategy,
      answers: drafts,
      needsJudge: true,
      judgeModelId: String(options.judgeModelId),
      reason: "the owner-picked model judges these drafts and does not choose a provider",
    };
  }
  return { strategy: "show-all", answers: drafts, text: null };
}

function localFanout(models, hardware = {}) {
  const ram = Number(hardware.freeRamGb);
  const need = (models || []).reduce((sum, model) => sum + (Number(model?.ramGb) || 0), 0);
  if (!Number.isFinite(ram) || ram <= 0) {
    return { mode: "sequential", reason: "free memory was not measured" };
  }
  if (need > ram)
    return { mode: "sequential", reason: "the models do not fit in free memory together" };
  return { mode: "parallel", reason: "the models fit in free memory" };
}

module.exports = {
  POLICIES,
  COST_MODES,
  DEFAULT_COST_MODE,
  normaliseCostMode,
  policyForCostMode,

  DEFAULT_POLICY,
  normalisePolicy,
  ROUTE_MODES,
  DEFAULT_ROUTE_MODE,
  normaliseRouteMode,
  typesForMode,

  ROUTING_TASKS,
  normaliseRoutingTask,
  QUALITY_TARGETS,
  DEFAULT_QUALITY_TARGET,
  normaliseQualityTarget,
  ROUTE_STRATEGIES,
  DEFAULT_ROUTE_STRATEGY,
  normaliseStrategy,
  normalizeRoutingRequirements,
  createRoutingContract,
  validateRoutingContract,

  classifyAccess,
  accessRecordOf,
  capabilitiesOf,
  classifyError,
  midStreamFallback,
  spendCapAllows,
  planRefresh,
  planHealthProbe,
  planModelProbes,
  zeroSpendTarget,
  runZeroSpendProbes,
  repairModelIssue,
  fallbackAdvances,
  orderFallbacks,
  commitCatalogue,
  publicDecision,
  modelExecutionTrace,
  ProviderHealthManager,
  describe,
  scoreModel,
  hardReject,
  selectEligible,
  planRoute,
  assignSteps,
  cascadeAccepts,
  classifyTask,
  previewRoute,
  TASK_PRESETS,
  compileRoleTurn,
  selectVerificationCandidates,
  usableModels,
  freeNowBoard,
  routeFreeTurn,
  hedgeFree,
  LOCAL_ANSWER_STRATEGIES,
  combineLocalAnswers,
  localFanout,
  nudgePrior,
  cooldownJitter,
  localSafetyNet,
  modelAvailability,
  formatAnsweredBy,
  choiceLabelOf,
  providerDisplayName,
  PROVIDER_NAMES,
  selectParallel,
  isExclusiveMode,
  usesOwnerPool,
  EXCLUSIVE_MODES,
  explainFailure,
  explainUnavailable,
  HEALTH_REASON,
  TASK_CAPABILITY,
  MODEL_EVENT_KINDS,
  lifecycleKindFromHealth,
  LANES,
  normaliseAllowlist,
  budgetDecision,
  preferNewestFree,
  recordSpend,
  paidLaneOpen,
  decideLane,
  routeRequest,
};
