/**
 * FRIDAY · model access classification (main process).
 *
 * One place that decides whether a discovered model is free to call. This is
 * not a second registry: `electron/models.cjs` still owns discovery, and
 * `electron/model-router.cjs` still owns selection. Callers keep the coarse
 * `access: "free" | "paid" | "unknown"` field they already read.
 *
 * Proof, not signals. A name containing "free", a `:free` suffix, a provider
 * that offers a free tier, a free signup, or a successful /models listing is
 * never enough on its own. UNKNOWN never becomes FREE by fallback.
 */

const BILLING_MODES = Object.freeze(["ZERO_COST", "FREE_QUOTA", "FREE_CREDIT", "PAID", "UNKNOWN"]);

const ELIGIBILITY = Object.freeze([
  "ELIGIBLE",
  "RATE_LIMITED",
  "EXHAUSTED",
  "NOT_ELIGIBLE",
  "UNKNOWN",
]);

const VERIFICATION = Object.freeze(["VERIFIED", "UNVERIFIED", "FAILED"]);

const EVIDENCE_SOURCES = Object.freeze([
  "provider_pricing",
  "provider_free_plan",
  "provider_model_catalog",
  "provider_account",
  "provider_trial",
  "provider_router",
  "live_probe",
  "local_runtime",
  "owner_declared",
]);

const CREDIT_SOURCES = Object.freeze(["TRIAL", "PROMOTIONAL", "GRANT", "USER_FUNDED", "UNKNOWN"]);

const FREE_CREDIT_SOURCES = new Set(["TRIAL", "PROMOTIONAL", "GRANT"]);

const FREE_BILLING = new Set(["ZERO_COST", "FREE_QUOTA", "FREE_CREDIT"]);

const LOCAL_KINDS = new Set([
  "local",
  "ollama",
  "llama.cpp",
  "llamacpp",
  "lmstudio",
  "vllm",
  "localai",
  "jan",
  "mlx",
]);

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

/** Dynamic TTLs for caching and background refresh. */
const CATALOGUE_TTL_MS = 10 * 60 * 1000;
const PRICING_TTL_MS = 30 * 60 * 1000;
const ENTITLEMENT_TTL_MS = 10 * 60 * 1000;
const PROBE_TTL_MS = 30 * 60 * 1000;

/** Isolated official knowledge. Fail closed when the record is past `ttlMs`. */
const DOC_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const KNOWLEDGE_CHECKED_AT = Date.parse("2026-09-30T00:00:00Z");
/** Ask for a refresh this long before a source expires. */
const REFRESH_LEAD_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Pages re-read in this checkout. A date moves only after that page was read.
 * Sources absent here keep `KNOWLEDGE_CHECKED_AT`.
 */
const RECHECKED_AT = Object.freeze({
  groq: Date.parse("2026-10-07T00:00:00Z"),
  gemini: Date.parse("2026-10-07T00:00:00Z"),
  openai: Date.parse("2026-10-07T00:00:00Z"),
  anthropic: Date.parse("2026-10-07T00:00:00Z"),
  deepseek: Date.parse("2026-10-07T00:00:00Z"),
  perplexity: Date.parse("2026-10-07T00:00:00Z"),
  mistral: Date.parse("2026-10-07T00:00:00Z"),
  nvidia: Date.parse("2026-10-07T00:00:00Z"),
  zhipu: Date.parse("2026-10-07T00:00:00Z"),
});

function checkedAtFor(id) {
  return RECHECKED_AT[id] || KNOWLEDGE_CHECKED_AT;
}

/**
 * Groq supported-models page. Published non-zero prices are the Developer
 * plan. Contact Sales ids are omitted and stay UNKNOWN.
 * Source: https://console.groq.com/docs/models (re-read 2026-10-07).
 */
const GROQ_MODEL_PRICING = Object.freeze({
  source: "https://console.groq.com/docs/models",
  sourceName: "Groq supported models",
  checkedAt: checkedAtFor("groq"),
  ttlMs: DOC_TTL_MS,
  priced: Object.freeze({
    "openai/gpt-oss-120b": Object.freeze({ input: 0.15, output: 0.6, unit: "per_1m_tokens" }),
    "openai/gpt-oss-20b": Object.freeze({ input: 0.075, output: 0.3, unit: "per_1m_tokens" }),
    "openai/gpt-oss-safeguard-20b": Object.freeze({
      input: 0.075,
      output: 0.3,
      unit: "per_1m_tokens",
    }),
    "qwen/qwen3.8-27b": Object.freeze({ input: 0.8, output: 4, unit: "per_1m_tokens" }),
    "meta-llama/llama-prompt-guard-2-22m": Object.freeze({
      input: 0.03,
      output: 0.03,
      unit: "per_1m_tokens",
    }),
    "meta-llama/llama-prompt-guard-2-86m": Object.freeze({
      input: 0.04,
      output: 0.04,
      unit: "per_1m_tokens",
    }),
    "whisper-large-v3": Object.freeze({ input: 0.111, output: null, unit: "per_hour" }),
    "whisper-large-v3-turbo": Object.freeze({ input: 0.04, output: null, unit: "per_hour" }),
    "canopylabs/orpheus-arabic-saudi": Object.freeze({
      input: 40,
      output: null,
      unit: "per_1m_characters",
    }),
    "canopylabs/orpheus-v1-english": Object.freeze({
      input: 22,
      output: null,
      unit: "per_1m_characters",
    }),
  }),
});

/**
 * Groq Free Plan limits. The rate-limits page embeds `freeRows` separately
 * from `devRows`. These exact ids are on the free plan (rate-limited, no
 * paid access required). The same ids also have Developer-plan prices.
 * A declared developer or paid account stays PAID. Ids absent from freeRows,
 * including llama-3.3-70b-versatile, are not free.
 * Source: https://console.groq.com/docs/rate-limits (re-read 2026-10-07).
 */
const GROQ_FREE_PLAN = Object.freeze({
  source: "https://console.groq.com/docs/rate-limits",
  sourceName: "Groq free plan limits",
  checkedAt: checkedAtFor("groq"),
  ttlMs: DOC_TTL_MS,
  ids: Object.freeze([
    "canopylabs/orpheus-arabic-saudi",
    "canopylabs/orpheus-v1-english",
    "meta-llama/llama-prompt-guard-2-22m",
    "meta-llama/llama-prompt-guard-2-86m",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-safeguard-20b",
    "qwen/qwen3.8-27b",
    "whisper-large-v3",
    "whisper-large-v3-turbo",
  ]),
});

/**
 * Z.ai pricing page marks three chat models Free on every token column.
 * Source: https://docs.z.ai/guides/overview/pricing (re-read 2026-10-07).
 */
const ZHIPU_FREE_IDS = Object.freeze({
  source: "https://docs.z.ai/guides/overview/pricing",
  sourceName: "Z.ai pricing",
  checkedAt: checkedAtFor("zhipu"),
  ttlMs: DOC_TTL_MS,
  ids: Object.freeze(["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash"]),
});

/**
 * NVIDIA API catalog: every hosted NIM model offers a free trial tier and
 * no credit card is required. That applies to a row returned by the catalogue,
 * not to an id that was never listed. A positive price on a model row still
 * means PAID. Localhost NIM stays local.
 * Source: https://build.nvidia.com/llms.txt (re-read 2026-10-07).
 */
const NVIDIA_FREE_TRIAL = Object.freeze({
  source: "https://build.nvidia.com/llms.txt",
  sourceName: "NVIDIA API catalog",
  checkedAt: checkedAtFor("nvidia"),
  ttlMs: DOC_TTL_MS,
});

/**
 * Gemini API Free Tier availability by model family. Studio/web free usage is
 * not proof. A paid project overrides the page. A missing project tier does
 * not. Source: https://ai.google.dev/gemini-api/docs/pricing
 */
const GEMINI_FREE_TIER = Object.freeze({
  source: "https://ai.google.dev/gemini-api/docs/pricing",
  sourceName: "Gemini API pricing",
  checkedAt: checkedAtFor("gemini"),
  ttlMs: DOC_TTL_MS,
  // Prefix match covers dated preview ids. Only families whose Standard input
  // price was "Free of charge" on the 2026-10-07 page. Image, Omni, Veo, and
  // Lyria rows were "Not available" and are not listed. 2.0 and 1.5 were not
  // on that page.
  freeTierPrefixes: Object.freeze([
    "gemini-3.8-flash",
    "gemini-3.8-live",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-live-translate",
    "gemini-3.5-transcribe",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-live",
    "gemini-3.1-flash-tts",
    "gemini-3-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-embedding-2",
    "gemini-robotics-er-2-streaming-preview",
  ]),
});

/**
 * Official Mistral API pricing is consumption-based. /v1/models often omits
 * prices; missing catalogue pricing is not UNKNOWN when this knowledge is
 * fresh. Studio / Le Chat / web free is not API-free.
 * Re-read 2026-10-07: flagship, specialized, and code rows that name a price
 * are non-zero, so defaultBilling stays PAID. The page shows "Mistral
 * Moderation 2" as Free and does not give an API model id, so zeroCostIds
 * stays empty. Voxtral TTS input is $0 per million characters and output is
 * $16, so that row is not a free model.
 * Source: https://mistral.ai/pricing/api
 */
const MISTRAL_API_PRICING = Object.freeze({
  source: "https://mistral.ai/pricing/api",
  sourceName: "Mistral API pricing",
  checkedAt: checkedAtFor("mistral"),
  ttlMs: DOC_TTL_MS,
  defaultBilling: "PAID",
  zeroCostIds: Object.freeze([]),
});

/** Commercial APIs whose current published API price is metered, not $0. */
const METERED_API_DEFAULT = Object.freeze({
  openai: {
    source: "https://platform.openai.com/docs/pricing",
    sourceName: "OpenAI API pricing",
    checkedAt: checkedAtFor("openai"),
    ttlMs: DOC_TTL_MS,
  },
  anthropic: {
    source: "https://www.anthropic.com/pricing",
    sourceName: "Anthropic API pricing",
    checkedAt: checkedAtFor("anthropic"),
    ttlMs: DOC_TTL_MS,
  },
  deepseek: {
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    sourceName: "DeepSeek API pricing",
    checkedAt: checkedAtFor("deepseek"),
    ttlMs: DOC_TTL_MS,
  },
  perplexity: {
    source: "https://docs.perplexity.ai/guides/pricing",
    sourceName: "Perplexity API pricing",
    checkedAt: checkedAtFor("perplexity"),
    ttlMs: DOC_TTL_MS,
  },
});

const DEFAULT_RECORD = () => ({
  billingMode: "UNKNOWN",
  eligibility: "UNKNOWN",
  verification: "UNVERIFIED",
  creditSource: null,
  evidence: {
    source: "provider_model_catalog",
    checkedAt: 0,
    expiresAt: null,
    confidence: 0,
  },
  pricing: { input: null, output: null, currency: "USD", source: null, native: null },
  quota: null,
  rateLimits: null,
  liveProbe: null,
  failureReason: null,
});

function knowledgeFresh(entry, now) {
  if (!entry || !entry.checkedAt) return false;
  const ttl = Number(entry.ttlMs || DOC_TTL_MS);
  return now - Number(entry.checkedAt) < ttl;
}

function looksFreeName(value = "") {
  const name = String(value || "").toLowerCase();
  return /(^|[:\-/])free($|[:\-/])/.test(name) || name.endsWith(":free");
}

function isLocalModel(model = {}) {
  const kind = String(model.kind || model.type || model.meta?.kind || "").toLowerCase();
  const provider = String(
    model.providerId || model.meta?.providerId || model.provider || "",
  ).toLowerCase();
  if (LOCAL_KINDS.has(kind) || LOCAL_PROVIDERS.has(provider)) return true;
  const endpoint = String(model.endpoint || model.meta?.endpoint || "");
  if (provider === "nvidia" && /127\.0\.0\.1|localhost/i.test(endpoint)) return true;
  return false;
}

function parseMoney(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const INPUT_PRICE_KEYS = Object.freeze([
  "prompt",
  "input",
  "input_cost",
  "input_price",
  "prompt_price",
  "prompt_text_token_price",
  "input_token_price",
  "prompt_token_price",
]);

const OUTPUT_PRICE_KEYS = Object.freeze([
  "completion",
  "output",
  "output_cost",
  "output_price",
  "completion_price",
  "completion_text_token_price",
  "output_token_price",
  "completion_token_price",
]);

const EXTRA_PAID_PRICE_KEYS = Object.freeze([
  "prompt_image_token_price",
  "completion_image_token_price",
  "input_image_token_price",
  "output_image_token_price",
  "prompt_audio_token_price",
  "completion_audio_token_price",
  "input_audio_token_price",
  "output_audio_token_price",
  "image_price",
  "audio_price",
  "request_price",
  "cached_prompt_token_price",
  "cached_input_token_price",
  "cache_read_input_token_price",
  "cache_write_input_token_price",
]);

function firstMoney(sources, keys) {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of keys) {
      const n = parseMoney(src[key]);
      if (n != null) return n;
    }
  }
  return null;
}

function cataloguePricing(catalogue) {
  if (!catalogue || typeof catalogue !== "object") {
    return {
      input: null,
      output: null,
      currency: "USD",
      source: null,
      native: null,
      extraPaid: false,
    };
  }
  const pricing = catalogue.pricing || catalogue.price || {};
  const sources = [pricing, catalogue];
  const input = firstMoney(sources, INPUT_PRICE_KEYS);
  const output = firstMoney(sources, OUTPUT_PRICE_KEYS);
  const native = {};
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of [...INPUT_PRICE_KEYS, ...OUTPUT_PRICE_KEYS, ...EXTRA_PAID_PRICE_KEYS]) {
      if (src[key] != null && native[key] == null) native[key] = src[key];
    }
  }
  const extraPaid = EXTRA_PAID_PRICE_KEYS.some((key) => parseMoney(native[key]) > 0);
  return {
    input,
    output,
    currency: pricing.currency || catalogue.currency || "USD",
    source: null,
    native: Object.keys(native).length ? native : null,
    extraPaid,
  };
}

function zeroPrice(pricing) {
  return pricing && pricing.input === 0 && pricing.output === 0 && !pricing.extraPaid;
}

function paidPrice(pricing) {
  if (!pricing) return false;
  const inPaid = pricing.input != null && pricing.input > 0;
  const outPaid = pricing.output != null && pricing.output > 0;
  return inPaid || outPaid || Boolean(pricing.extraPaid);
}

function makeRecord(patch = {}, now = Date.now()) {
  const base = DEFAULT_RECORD();
  const evidence = { ...base.evidence, ...(patch.evidence || {}) };
  if (!evidence.checkedAt) evidence.checkedAt = now;
  if (!evidence.expiresAt) {
    const src = evidence.source;
    const ttl =
      src === "provider_pricing"
        ? PRICING_TTL_MS
        : src === "provider_account" || src === "provider_trial"
          ? ENTITLEMENT_TTL_MS
          : src === "live_probe"
            ? PROBE_TTL_MS
            : src === "provider_free_plan" || src === "owner_declared"
              ? DOC_TTL_MS
              : CATALOGUE_TTL_MS;
    evidence.expiresAt = now + ttl;
  }
  return {
    ...base,
    ...patch,
    evidence,
    pricing: { ...base.pricing, ...(patch.pricing || {}) },
  };
}

function effectiveStatus(record) {
  if (!record) return "UNKNOWN";
  const mode = record.billingMode;
  const elig = record.eligibility;
  const ver = record.verification;
  if (ver === "FAILED" && !FREE_BILLING.has(mode)) return "UNAVAILABLE";
  if (elig === "NOT_ELIGIBLE") return "UNAVAILABLE";
  if (elig === "EXHAUSTED") return "UNAVAILABLE";
  if (ver === "VERIFIED" && FREE_BILLING.has(mode) && elig === "RATE_LIMITED")
    return "FREE_RATE_LIMITED";
  if (ver === "VERIFIED" && elig === "ELIGIBLE") {
    if (mode === "ZERO_COST") return "VERIFIED_ZERO_COST";
    if (mode === "FREE_QUOTA") return "VERIFIED_FREE_QUOTA";
    if (mode === "FREE_CREDIT") return "VERIFIED_FREE_CREDIT";
  }
  if (mode === "PAID") return "PAID";
  if (mode === "UNKNOWN") return "UNKNOWN";
  // Unverified free-class evidence stays UNKNOWN at the coarse/effective layer.
  return "UNKNOWN";
}

/** Official free evidence the owner can use before a live probe. */
function officialFreeUsable(record) {
  if (!record || !FREE_BILLING.has(record.billingMode)) return false;
  if (record.eligibility !== "ELIGIBLE" && record.eligibility !== "RATE_LIMITED") return false;
  const source = String(record.evidence?.source || "");
  return (
    source === "provider_pricing" ||
    source === "provider_free_plan" ||
    source === "provider_model_catalog" ||
    source === "provider_trial" ||
    source === "provider_router" ||
    source === "owner_declared" ||
    source === "live_probe" ||
    source === "local_runtime"
  );
}

function coarseAccess(record) {
  const status = effectiveStatus(record);
  if (status === "PAID") return "paid";
  if (
    status === "VERIFIED_ZERO_COST" ||
    status === "VERIFIED_FREE_QUOTA" ||
    status === "VERIFIED_FREE_CREDIT" ||
    status === "FREE_RATE_LIMITED"
  )
    return "free";
  // A catalogue list alone is not VERIFIED. Official free evidence is still
  // usable, and the record keeps verification UNVERIFIED until a probe.
  if (officialFreeUsable(record)) return "free";
  return "unknown";
}

/** Candidate for free-only *filtering* of a catalogue (not yet verified). */
function isFreeCandidate(record) {
  if (!record) return false;
  if (!FREE_BILLING.has(record.billingMode)) return false;
  return record.eligibility === "ELIGIBLE" || record.eligibility === "RATE_LIMITED";
}

/** May leave the machine under free-only. Unverified never qualifies. */
function isVerifiedFree(record) {
  const status = effectiveStatus(record);
  return (
    status === "VERIFIED_ZERO_COST" ||
    status === "VERIFIED_FREE_QUOTA" ||
    status === "VERIFIED_FREE_CREDIT"
  );
}

function isFreeOnlyEligible(record, { retryableLimit = false } = {}) {
  if (isVerifiedFree(record)) return true;
  if (retryableLimit && effectiveStatus(record) === "FREE_RATE_LIMITED") return true;
  if (!officialFreeUsable(record)) return false;
  if (record.eligibility === "RATE_LIMITED") return Boolean(retryableLimit);
  return record.eligibility === "ELIGIBLE";
}

function freeRank(record) {
  switch (effectiveStatus(record)) {
    case "VERIFIED_ZERO_COST":
      return 4;
    case "VERIFIED_FREE_QUOTA":
      return 3;
    case "VERIFIED_FREE_CREDIT":
      return 2;
    case "FREE_RATE_LIMITED":
      return 1;
    default:
      return 0;
  }
}

function readExistingRecord(model) {
  if (model?.accessRecord && typeof model.accessRecord === "object") return model.accessRecord;
  if (model?.meta?.accessRecord && typeof model.meta.accessRecord === "object")
    return model.meta.accessRecord;
  if (model?.access && typeof model.access === "object" && model.access.billingMode)
    return model.access;
  return null;
}

function groqIdMatch(modelId, listed) {
  const a = String(modelId || "").toLowerCase();
  const b = String(listed || "").toLowerCase();
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

const knowledgeOverlay = {};

function applyKnowledgeOverlay(patch) {
  if (!patch || typeof patch !== "object") return knowledgeOverlay;
  for (const [id, row] of Object.entries(patch)) {
    if (!row || typeof row !== "object") continue;
    knowledgeOverlay[id] = row;
  }
  return knowledgeOverlay;
}

function clearKnowledgeOverlay() {
  for (const key of Object.keys(knowledgeOverlay)) delete knowledgeOverlay[key];
}

function groqTable(now) {
  const over = knowledgeOverlay.groq;
  if (
    over &&
    over.priced &&
    Number(over.checkedAt) > GROQ_MODEL_PRICING.checkedAt &&
    knowledgeFresh({ ...over, ttlMs: over.ttlMs || DOC_TTL_MS }, now)
  ) {
    return { ...GROQ_MODEL_PRICING, ...over, ttlMs: over.ttlMs || DOC_TTL_MS };
  }
  return GROQ_MODEL_PRICING;
}

function groqPricedEntry(modelId, now) {
  const table = groqTable(now);
  if (!knowledgeFresh(table, now)) return null;
  const id = String(modelId || "").toLowerCase();
  const priced = table.priced || {};
  const hit = Object.keys(priced).find((item) => groqIdMatch(id, item));
  return hit ? { table, price: priced[hit] } : null;
}

function geminiFreeTierMatch(modelId, now) {
  const table = geminiTable(now);
  if (!knowledgeFresh(table, now)) return false;
  const id = String(modelId || "")
    .toLowerCase()
    .replace(/^models\//, "");
  // Image-generation models (Nano Banana family) list Free Tier "Not
  // available" on the official pricing page, even though their id starts
  // with a Flash family prefix. Never let a prefix or the 3.x regex below
  // classify them as free.
  if (/-image(-|@|$)/.test(id) || id.startsWith("gemini-omni") || id.startsWith("veo-"))
    return false;
  if (id.startsWith("lyria-") || id.includes("nano-banana")) return false;
  const prefixes = geminiTable(now).freeTierPrefixes || [];
  return prefixes.some(
    (prefix) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}@`),
  );
}

function geminiTable(now) {
  const over = knowledgeOverlay.gemini;
  if (
    over &&
    Array.isArray(over.freeTierPrefixes) &&
    Number(over.checkedAt) > GEMINI_FREE_TIER.checkedAt &&
    knowledgeFresh({ ...over, ttlMs: over.ttlMs || DOC_TTL_MS }, now)
  ) {
    return { ...GEMINI_FREE_TIER, ...over, ttlMs: over.ttlMs || DOC_TTL_MS };
  }
  return GEMINI_FREE_TIER;
}

function pickHfZeroRoute(catalogue) {
  const list = Array.isArray(catalogue?.providers) ? catalogue.providers : [];
  for (const row of list) {
    if ((row?.status || "live") !== "live") continue;
    const pricing = cataloguePricing(row);
    if (zeroPrice(pricing)) return { row, pricing };
  }
  return null;
}

function candidateRank(record) {
  if (!record || !isFreeCandidate(record)) return 0;
  switch (record.billingMode) {
    case "ZERO_COST":
      return 4;
    case "FREE_QUOTA":
      return 3;
    case "FREE_CREDIT":
      return 2;
    default:
      return 0;
  }
}

function creditSourceOf(account) {
  if (!account || typeof account !== "object") return "UNKNOWN";
  const raw = String(account.creditSource || account.credit_source || account.balanceType || "")
    .trim()
    .toUpperCase();
  if (CREDIT_SOURCES.includes(raw)) return raw;
  if (account.trial === true || account.keyType === "trial" || account.key_type === "trial")
    return "TRIAL";
  if (account.promotional === true || account.grant === true || account.credit_type === "grant")
    return "GRANT";
  if (account.hfMonthlyCredits === true || account.monthlyCredits === true) return "GRANT";
  if (account.userFunded === true || account.prepaid === true || account.user_funded === true)
    return "USER_FUNDED";
  return "UNKNOWN";
}

function applyAccountCredits(record, account, now) {
  const remaining = parseMoney(
    account?.creditsRemaining ?? account?.credits ?? account?.limit_remaining ?? account?.balance,
  );
  if (remaining == null) return record;
  const source = creditSourceOf(account);
  const freeCredit = FREE_CREDIT_SOURCES.has(source);
  if (remaining > 0) {
    if (!freeCredit) {
      return makeRecord(
        {
          ...record,
          billingMode: record.billingMode === "ZERO_COST" ? "ZERO_COST" : "PAID",
          eligibility: "ELIGIBLE",
          creditSource: source,
          evidence: {
            source: "provider_account",
            checkedAt: now,
            expiresAt: null,
            confidence: Math.max(record.evidence?.confidence || 0, 0.55),
          },
        },
        now,
      );
    }
    return makeRecord(
      {
        ...record,
        billingMode:
          record.billingMode === "ZERO_COST"
            ? "ZERO_COST"
            : source === "TRIAL"
              ? "FREE_QUOTA"
              : "FREE_CREDIT",
        eligibility: "ELIGIBLE",
        creditSource: source,
        evidence: {
          source: "provider_account",
          checkedAt: now,
          expiresAt: null,
          confidence: Math.max(record.evidence?.confidence || 0, 0.6),
        },
      },
      now,
    );
  }
  if (!freeCredit) {
    return makeRecord(
      {
        ...record,
        billingMode: record.billingMode === "ZERO_COST" ? "ZERO_COST" : "PAID",
        eligibility: remaining === 0 ? "ELIGIBLE" : "UNKNOWN",
        creditSource: source,
        evidence: {
          source: "provider_account",
          checkedAt: now,
          expiresAt: null,
          confidence: 0.55,
        },
      },
      now,
    );
  }
  return makeRecord(
    {
      ...record,
      billingMode:
        record.billingMode === "ZERO_COST"
          ? "ZERO_COST"
          : source === "TRIAL"
            ? "FREE_QUOTA"
            : "FREE_CREDIT",
      eligibility: "EXHAUSTED",
      creditSource: source,
      evidence: {
        source: "provider_account",
        checkedAt: now,
        expiresAt: null,
        confidence: 0.7,
      },
    },
    now,
  );
}

function classifyLocal(now) {
  return makeRecord(
    {
      billingMode: "ZERO_COST",
      eligibility: "ELIGIBLE",
      verification: "VERIFIED",
      evidence: { source: "local_runtime", checkedAt: now, confidence: 1 },
    },
    now,
  );
}

function classifyOpenRouter(input, now) {
  const id = String(input.modelId || "");
  const pricing = cataloguePricing(input.catalogue);
  const freeName = looksFreeName(id);
  if (id === "openrouter/free" || id.toLowerCase() === "openrouter/free") {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_router",
          checkedAt: now,
          confidence: 0.7,
        },
        pricing: { input: 0, output: 0, currency: "USD" },
      },
      now,
    );
  }
  if (zeroPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_pricing",
          checkedAt: now,
          confidence: freeName ? 0.8 : 0.75,
        },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  if (paidPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.85 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  // `:free` is a signal only. Without catalogue prices this stays UNKNOWN.
  return makeRecord(
    {
      billingMode: "UNKNOWN",
      eligibility: "UNKNOWN",
      verification: "UNVERIFIED",
      evidence: {
        source: freeName ? "provider_model_catalog" : "provider_model_catalog",
        checkedAt: now,
        confidence: freeName ? 0.2 : 0,
      },
    },
    now,
  );
}

function groqOnFreePlan(modelId, now) {
  if (!knowledgeFresh(GROQ_FREE_PLAN, now)) return false;
  return GROQ_FREE_PLAN.ids.some((item) => groqIdMatch(modelId, item));
}

function groqDeveloperAccount(input) {
  const plan = String(input.account?.plan || input.account?.tier || "").toLowerCase();
  return input.declaredAccess === "paid" || plan === "developer" || plan === "paid";
}

function classifyGroq(input, now) {
  const id = String(input.modelId || "");
  const table = groqTable(now);
  if (!knowledgeFresh(table, now)) {
    return makeRecord(
      {
        billingMode: "UNKNOWN",
        eligibility: "UNKNOWN",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_pricing",
          checkedAt: table.checkedAt,
          expiresAt: table.checkedAt + table.ttlMs,
          confidence: 0,
        },
      },
      now,
    );
  }
  const listed = groqPricedEntry(id, now);
  const developerPrice = listed
    ? {
        input: listed.price.input,
        output: listed.price.output,
        currency: "USD",
        source: table.source,
        native: { unit: listed.price.unit, developerPlan: true },
      }
    : null;
  if (groqOnFreePlan(id, now) && !groqDeveloperAccount(input)) {
    return makeRecord(
      {
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_free_plan",
          checkedAt: GROQ_FREE_PLAN.checkedAt,
          expiresAt: GROQ_FREE_PLAN.checkedAt + GROQ_FREE_PLAN.ttlMs,
          confidence: 0.85,
        },
        pricing: developerPrice || {
          input: 0,
          output: 0,
          currency: "USD",
          source: GROQ_FREE_PLAN.source,
        },
      },
      now,
    );
  }
  if (listed && paidPrice(listed.price)) {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_pricing",
          checkedAt: table.checkedAt,
          expiresAt: table.checkedAt + table.ttlMs,
          confidence: 0.8,
        },
        pricing: developerPrice,
      },
      now,
    );
  }
  return makeRecord(
    {
      billingMode: "UNKNOWN",
      eligibility: "UNKNOWN",
      verification: "UNVERIFIED",
      evidence: { source: "provider_pricing", checkedAt: table.checkedAt, confidence: 0.4 },
    },
    now,
  );
}

function classifyGemini(input, now) {
  const projectPaid =
    input.account?.projectTier === "paid" ||
    input.account?.billingEnabled === true ||
    input.declaredAccess === "paid";
  // The owner-facing provider tier is a routing preference, not project
  // entitlement evidence. Only provider/account evidence may prove Free Tier.
  const projectFree = input.account?.projectTier === "free";
  const table = geminiTable(now);
  const inTable = geminiFreeTierMatch(input.modelId, now);
  if (!knowledgeFresh(table, now)) {
    return makeRecord(
      {
        billingMode: "UNKNOWN",
        eligibility: "UNKNOWN",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_pricing",
          checkedAt: table.checkedAt,
          expiresAt: table.checkedAt + table.ttlMs,
          confidence: 0,
        },
      },
      now,
    );
  }
  if (projectPaid) {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_account", checkedAt: now, confidence: 0.7 },
      },
      now,
    );
  }
  // The pricing page is the free-tier evidence. A paid project or an owner
  // declaration of paid access overrides it. A missing project tier does not.
  if (inTable) {
    return makeRecord(
      {
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_pricing",
          checkedAt: table.checkedAt,
          expiresAt: table.checkedAt + table.ttlMs,
          confidence: projectFree ? 0.85 : 0.75,
        },
      },
      now,
    );
  }
  return makeRecord(
    {
      billingMode: "UNKNOWN",
      eligibility: "UNKNOWN",
      verification: "UNVERIFIED",
      evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.2 },
    },
    now,
  );
}

function classifyHuggingFace(input, now) {
  const customKey = Boolean(input.customEndpoint || input.account?.customProviderKey);
  const zero = pickHfZeroRoute(input.catalogue);
  if (zero && !customKey) {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.75 },
        pricing: { ...zero.pricing, currency: "USD" },
      },
      now,
    );
  }
  const pricing = cataloguePricing(input.catalogue);
  if (paidPrice(pricing) || customKey) {
    const basePaid = makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.7 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
    if (customKey) return basePaid;
    return applyAccountCredits(basePaid, input.account, now);
  }
  if (input.account && parseMoney(input.account.creditsRemaining ?? input.account.credits) > 0) {
    return applyAccountCredits(makeRecord({ billingMode: "UNKNOWN" }, now), input.account, now);
  }
  return makeRecord(
    {
      billingMode: "UNKNOWN",
      eligibility: "UNKNOWN",
      verification: "UNVERIFIED",
      evidence: { source: "provider_model_catalog", checkedAt: now, confidence: 0.1 },
    },
    now,
  );
}

function classifyCohere(input, now) {
  const trial = input.account?.keyType === "trial" || input.account?.trial === true;
  const production =
    input.account?.keyType === "production" ||
    input.account?.trial === false ||
    input.declaredAccess === "paid";
  const pricing = cataloguePricing(input.catalogue);
  if (zeroPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.8 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  if (trial && !production) {
    return makeRecord(
      {
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_trial", checkedAt: now, confidence: 0.65 },
      },
      now,
    );
  }
  if (production) {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_account", checkedAt: now, confidence: 0.7 },
      },
      now,
    );
  }
  return makeRecord(
    {
      billingMode: "UNKNOWN",
      eligibility: "UNKNOWN",
      verification: "UNVERIFIED",
      evidence: { source: "provider_account", checkedAt: now, confidence: 0.15 },
    },
    now,
  );
}

function classifyMeteredDefault(providerId, input, now) {
  const meta = METERED_API_DEFAULT[providerId];
  const pricing = cataloguePricing(input.catalogue);
  if (zeroPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.8 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  if (paidPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.85 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  if (!knowledgeFresh(meta, now)) {
    return makeRecord(
      {
        billingMode: "UNKNOWN",
        eligibility: "UNKNOWN",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_pricing",
          checkedAt: meta?.checkedAt || 0,
          expiresAt: meta?.checkedAt ? meta.checkedAt + meta.ttlMs : null,
          confidence: 0,
        },
      },
      now,
    );
  }
  return makeRecord(
    {
      billingMode: "PAID",
      eligibility: "ELIGIBLE",
      verification: "UNVERIFIED",
      evidence: {
        source: "provider_pricing",
        checkedAt: meta.checkedAt,
        expiresAt: meta.checkedAt + meta.ttlMs,
        confidence: 0.7,
      },
      pricing: { ...pricing, source: meta.source },
    },
    now,
  );
}

function classifyCreditProvider(input, now, { zeroMeansZero = true } = {}) {
  const pricing = cataloguePricing(input.catalogue);
  if (zeroMeansZero && zeroPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.8 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  if (
    paidPrice(pricing) &&
    !(parseMoney(input.account?.creditsRemaining ?? input.account?.credits) > 0)
  ) {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.75 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  if (input.account)
    return applyAccountCredits(makeRecord({ billingMode: "UNKNOWN" }, now), input.account, now);
  return makeRecord(
    {
      billingMode: "UNKNOWN",
      eligibility: "UNKNOWN",
      verification: "UNVERIFIED",
      evidence: { source: "provider_account", checkedAt: now, confidence: 0.1 },
    },
    now,
  );
}

function nvidiaCatalogueRow(catalogue) {
  if (!catalogue || typeof catalogue !== "object") return false;
  // classifyAccess falls back to the model record. That record is not a
  // GET /v1/models row, so a random probe id stays unknown.
  if (catalogue.meta && typeof catalogue.meta === "object") return false;
  const id = String(catalogue.id || "");
  return Boolean(id) && !id.includes(":");
}

function classifyNvidia(input, now) {
  if (input.customEndpoint || /127\.0\.0\.1|localhost/i.test(String(input.endpoint || ""))) {
    return classifyLocal(now);
  }
  const pricing = cataloguePricing(input.catalogue);
  if (zeroPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.7 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  if (input.catalogue?.free === true || input.catalogue?.is_free === true) {
    return makeRecord(
      {
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_model_catalog", checkedAt: now, confidence: 0.65 },
      },
      now,
    );
  }
  if (paidPrice(pricing) || input.declaredAccess === "paid") {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.7 },
        pricing: { ...pricing, currency: "USD" },
      },
      now,
    );
  }
  if (!knowledgeFresh(NVIDIA_FREE_TRIAL, now) || !nvidiaCatalogueRow(input.catalogue)) {
    return makeRecord(
      {
        billingMode: "UNKNOWN",
        eligibility: "UNKNOWN",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_free_plan",
          checkedAt: NVIDIA_FREE_TRIAL.checkedAt,
          confidence: 0,
        },
      },
      now,
    );
  }
  return makeRecord(
    {
      billingMode: "FREE_QUOTA",
      eligibility: "ELIGIBLE",
      verification: "UNVERIFIED",
      evidence: {
        source: "provider_free_plan",
        checkedAt: NVIDIA_FREE_TRIAL.checkedAt,
        expiresAt: NVIDIA_FREE_TRIAL.checkedAt + NVIDIA_FREE_TRIAL.ttlMs,
        confidence: 0.7,
      },
    },
    now,
  );
}

function zhipuFreeMatch(modelId, now) {
  if (!knowledgeFresh(ZHIPU_FREE_IDS, now)) return false;
  const id = String(modelId || "")
    .toLowerCase()
    .replace(/^models\//, "");
  return ZHIPU_FREE_IDS.ids.includes(id);
}

function classifyZhipu(input, now) {
  if (zhipuFreeMatch(input.modelId, now) && input.declaredAccess !== "paid") {
    return makeRecord(
      {
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_free_plan",
          checkedAt: ZHIPU_FREE_IDS.checkedAt,
          expiresAt: ZHIPU_FREE_IDS.checkedAt + ZHIPU_FREE_IDS.ttlMs,
          confidence: 0.8,
        },
        pricing: { input: 0, output: 0, currency: "USD", source: ZHIPU_FREE_IDS.source },
      },
      now,
    );
  }
  return classifyCreditProvider(input, now);
}

function classifyMistral(input, now) {
  const pricing = cataloguePricing(input.catalogue);
  if (zeroPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.8 },
        pricing: { ...pricing, currency: "USD", source: "provider_pricing" },
      },
      now,
    );
  }
  if (input.catalogue?.labs === true || input.catalogue?.free_labs === true) {
    const expiresAt = parseMoney(input.catalogue?.expiresAt) || now + 24 * 60 * 60 * 1000;
    if (expiresAt <= now) {
      return makeRecord(
        {
          billingMode: "PAID",
          eligibility: "ELIGIBLE",
          verification: "UNVERIFIED",
          evidence: { source: "provider_trial", checkedAt: now, expiresAt, confidence: 0.5 },
        },
        now,
      );
    }
    return makeRecord(
      {
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_trial", checkedAt: now, expiresAt, confidence: 0.5 },
      },
      now,
    );
  }
  if (paidPrice(pricing)) {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { source: "provider_pricing", checkedAt: now, confidence: 0.75 },
        pricing: { ...pricing, currency: "USD", source: "provider_pricing" },
      },
      now,
    );
  }
  if (!knowledgeFresh(MISTRAL_API_PRICING, now)) {
    return makeRecord(
      {
        billingMode: "UNKNOWN",
        eligibility: "UNKNOWN",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_pricing",
          checkedAt: MISTRAL_API_PRICING.checkedAt,
          expiresAt: MISTRAL_API_PRICING.checkedAt + MISTRAL_API_PRICING.ttlMs,
          confidence: 0,
        },
      },
      now,
    );
  }
  const id = String(input.modelId || "").toLowerCase();
  if ((MISTRAL_API_PRICING.zeroCostIds || []).some((item) => item === id)) {
    return makeRecord(
      {
        billingMode: "ZERO_COST",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: {
          source: "provider_pricing",
          checkedAt: MISTRAL_API_PRICING.checkedAt,
          expiresAt: MISTRAL_API_PRICING.checkedAt + MISTRAL_API_PRICING.ttlMs,
          confidence: 0.7,
        },
        pricing: { input: 0, output: 0, currency: "USD", source: MISTRAL_API_PRICING.source },
      },
      now,
    );
  }
  return makeRecord(
    {
      billingMode: "PAID",
      eligibility: "ELIGIBLE",
      verification: "UNVERIFIED",
      evidence: {
        source: "provider_pricing",
        checkedAt: MISTRAL_API_PRICING.checkedAt,
        expiresAt: MISTRAL_API_PRICING.checkedAt + MISTRAL_API_PRICING.ttlMs,
        confidence: 0.7,
      },
      pricing: { ...pricing, currency: "USD", source: MISTRAL_API_PRICING.source },
    },
    now,
  );
}

const EVIDENCE_AT = Date.parse("2026-10-08T00:00:00.000Z");

const PROVIDER_EVIDENCE = {
  cerebras: {
    sourceUrl: "https://inference-docs.cerebras.ai/support/rate-limits",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse: "Promotional credit only. No always-free model list.",
  },
  sambanova: {
    sourceUrl: "https://cloud.sambanova.ai/",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse: "No free model list was verified on 2026-10-08.",
  },
  together: {
    sourceUrl: "https://www.together.ai/pricing",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse: "A zero catalogue price is the evidence.",
  },
  fireworks: {
    sourceUrl: "https://docs.fireworks.ai/guides/pricing",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse: "Trial credit is not a permanent free model.",
  },
  xai: {
    sourceUrl: "https://docs.x.ai/docs/models",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse: "Published token prices are paid.",
  },
  moonshot: {
    sourceUrl: "https://platform.moonshot.ai/",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse: "No always-free model list was verified.",
  },
  nebius: {
    sourceUrl: "https://docs.tokenfactory.nebius.com/other-capabilities/billing-new",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse:
      "A new account gets a short trial credit and must add a card. That credit is not a free model list.",
  },
  deepinfra: {
    sourceUrl: "https://deepinfra.com/pricing",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse: "A zero catalogue price is the evidence.",
  },
  siliconflow: {
    sourceUrl: "https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation",
    checkedAt: EVIDENCE_AT,
    prefixPaid: "Pro/",
    freeIds: [],
    dataUse: "Free models are billed at zero after identity verification. Prompts may be logged.",
  },
  hyperbolic: {
    sourceUrl: "https://docs.hyperbolic.xyz/",
    checkedAt: EVIDENCE_AT,
    freeIds: [],
    dataUse: "No free inference tier was verified.",
  },
  github: {
    sourceUrl: "https://github.blog/changelog/2026-07-30-github-models-is-now-retired/",
    checkedAt: EVIDENCE_AT,
    retired: true,
    freeIds: [],
    dataUse: "Retired on 2026-07-30. Do not send prompts.",
  },
  cloudflare: {
    sourceUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    checkedAt: EVIDENCE_AT,
    freeIds: [
      "@cf/zai-org/glm-4.7-flash",
      "@cf/google/gemma-4-26b-a4b-it",
      "@cf/nvidia/nemotron-3-120b-a12b",
    ],
    paidIds: ["@cf/moonshotai/kimi-k2.6", "@cf/moonshotai/kimi-k2.7-code", "@cf/zai-org/glm-5.2"],
    dataUse: "Free allocation is 10,000 Neurons a day. Some models require a paid Workers plan.",
  },
};

function classifyDocumented(providerId, input, now) {
  const spec = PROVIDER_EVIDENCE[providerId];
  if (!spec) return classifyCreditProvider(input, now);
  const id = String(input.modelId || input.model?.id || input.catalogue?.id || "");
  const evidence = {
    source: "provider_docs",
    sourceUrl: spec.sourceUrl,
    checkedAt: spec.checkedAt,
    confidence: 0.8,
    dataUse: spec.dataUse,
  };
  if (spec.retired) {
    return makeRecord(
      {
        billingMode: "UNKNOWN",
        eligibility: "NOT_ELIGIBLE",
        verification: "UNVERIFIED",
        evidence,
      },
      now,
    );
  }
  if ((spec.prefixPaid && id.startsWith(spec.prefixPaid)) || (spec.paidIds || []).includes(id)) {
    return makeRecord(
      {
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence,
      },
      now,
    );
  }
  let record = classifyCreditProvider(input, now);
  if (
    record.billingMode === "UNKNOWN" &&
    (spec.freeIds || []).includes(id) &&
    knowledgeFresh({ checkedAt: spec.checkedAt, ttlMs: DOC_TTL_MS }, now)
  ) {
    record = makeRecord(
      {
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        verification: "UNVERIFIED",
        evidence: { ...evidence, source: "provider_free_plan" },
      },
      now,
    );
    if (input.account) record = applyAccountCredits(record, input.account, now);
  }
  record.evidence = {
    ...record.evidence,
    sourceUrl: record.evidence.sourceUrl || spec.sourceUrl,
    dataUse: record.evidence.dataUse || spec.dataUse,
  };
  return record;
}

const ADAPTERS = {
  openrouter: classifyOpenRouter,
  groq: classifyGroq,
  gemini: classifyGemini,
  huggingface: classifyHuggingFace,
  cohere: classifyCohere,
  nvidia: classifyNvidia,
  mistral: classifyMistral,
  cerebras: (input, now) => classifyDocumented("cerebras", input, now),
  fireworks: (input, now) => classifyDocumented("fireworks", input, now),
  sambanova: (input, now) => classifyDocumented("sambanova", input, now),
  moonshot: (input, now) => classifyDocumented("moonshot", input, now),
  zhipu: classifyZhipu,
  together: (input, now) => classifyDocumented("together", input, now),
  xai: (input, now) => classifyDocumented("xai", input, now),
  nebius: (input, now) => classifyDocumented("nebius", input, now),
  deepinfra: (input, now) => classifyDocumented("deepinfra", input, now),
  siliconflow: (input, now) => classifyDocumented("siliconflow", input, now),
  hyperbolic: (input, now) => classifyDocumented("hyperbolic", input, now),
  github: (input, now) => classifyDocumented("github", input, now),
  cloudflare: (input, now) => classifyDocumented("cloudflare", input, now),
  openai: (input, now) => classifyMeteredDefault("openai", input, now),
  anthropic: (input, now) => classifyMeteredDefault("anthropic", input, now),
  deepseek: (input, now) => classifyMeteredDefault("deepseek", input, now),
  perplexity: (input, now) => classifyMeteredDefault("perplexity", input, now),
};

function fitsQuota({ limit, used, need, headroom } = {}) {
  const cap = Number(limit);
  if (!Number.isFinite(cap)) return false;
  const spent = Number(used) || 0;
  const want = Number(need) || 0;
  const reserve = Number(headroom) || 0;
  return spent + want + reserve <= cap;
}

function refreshFreeKnowledge(previous, fetchResult) {
  const prior = previous && typeof previous === "object" ? previous : { models: [] };
  const models = Array.isArray(prior.models) ? prior.models : [];
  const parsed = fetchResult && fetchResult.ok === true ? fetchResult.parsed : null;
  if (!Array.isArray(parsed)) {
    return { kept: true, models, diff: { added: [], removed: [] }, reason: "kept-last-good" };
  }
  const before = new Set(models.map((row) => (typeof row === "string" ? row : row.id)));
  const after = new Set(parsed.map((row) => (typeof row === "string" ? row : row.id)));
  return {
    kept: false,
    models: parsed,
    diff: {
      added: [...after].filter((id) => id && !before.has(id)),
      removed: [...before].filter((id) => id && !after.has(id)),
    },
    reason: "parsed",
  };
}

function cloudAllowed(privacy) {
  const tier = String(privacy || "standard").toLowerCase();
  return tier !== "sensitive" && tier !== "private";
}

function scheduleFreeRefresh(enabled) {
  return { download: Boolean(enabled), blockStartup: false, optIn: true };
}

function parseRateLimitHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const get = (name) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
  };
  const num = (name) => {
    const v = parseMoney(get(name));
    return v;
  };
  const remainingReq =
    num("x-ratelimit-remaining-requests") ?? num("anthropic-ratelimit-requests-remaining");
  const remainingTok =
    num("x-ratelimit-remaining-tokens") ?? num("anthropic-ratelimit-tokens-remaining");
  const limitReq = num("x-ratelimit-limit-requests") ?? num("anthropic-ratelimit-requests-limit");
  const limitTok = num("x-ratelimit-limit-tokens") ?? num("anthropic-ratelimit-tokens-limit");
  const retryAfter =
    get("retry-after") ||
    get("x-ratelimit-reset-requests") ||
    get("anthropic-ratelimit-requests-reset");
  if (
    remainingReq == null &&
    remainingTok == null &&
    limitReq == null &&
    limitTok == null &&
    !retryAfter
  )
    return null;
  return {
    remainingRequests: remainingReq,
    remainingTokens: remainingTok,
    limitRequests: limitReq,
    limitTokens: limitTok,
    retryAfter: retryAfter || null,
  };
}

/** Quota copied off headers the provider already sent. This does not call out. */
function quotaMeter(headers) {
  const parsed = parseRateLimitHeaders(headers);
  if (!parsed) return null;
  return { ...parsed, source: "response-headers" };
}

function classifyProbeFailure(probe = {}) {
  const status = Number(probe.status || 0);
  const text = String(probe.error || probe.message || probe.body || "").toLowerCase();
  if (status === 429 || /rate limit|too many requests/.test(text)) {
    if (/quota|insufficient_quota|credit|balance/.test(text)) return "exhausted";
    return "rate_limited";
  }
  if (status === 402 || /payment required|billing/.test(text)) return "billing";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "unavailable";
  if (status === 408 || /timeout|timed out|deadline/.test(text)) return "timeout";
  if (/context.{0,20}(length|window|overflow|maximum)|too many tokens/.test(text))
    return "context_overflow";
  if (/stream.{0,20}(failed|failure|closed|reset|invalid)/.test(text)) return "stream_failure";
  if (status >= 500) return "provider_outage";
  if (/dns|enotfound|econnrefused|network|socket|name resolution/.test(text))
    return "network_failure";
  return "failed";
}

function applyProbe(record, probe, now = Date.now()) {
  const current = record && typeof record === "object" ? record : DEFAULT_RECORD();
  if (!probe) return current;
  const rateLimits = parseRateLimitHeaders(probe.headers) || current.rateLimits;
  if (probe.ok && String(probe.response || "").trim()) {
    const remaining =
      rateLimits &&
      ((rateLimits.remainingRequests != null && rateLimits.remainingRequests <= 0) ||
        (rateLimits.remainingTokens != null && rateLimits.remainingTokens <= 0));
    return makeRecord(
      {
        ...current,
        eligibility: remaining ? "RATE_LIMITED" : "ELIGIBLE",
        verification: "VERIFIED",
        rateLimits,
        liveProbe: {
          chatVerified: true,
          streamVerified: probe.streamed === true,
          status: Number(probe.status || 200),
          checkedAt: now,
          latencyMs: probe.latencyMs ?? null,
          streamFailure: probe.streamError || null,
        },
        failureReason: null,
        evidence: {
          source: "live_probe",
          checkedAt: now,
          expiresAt: now + 30 * 60 * 1000,
          confidence: 0.95,
        },
      },
      now,
    );
  }
  const kind = classifyProbeFailure(probe);
  if (kind === "rate_limited") {
    return makeRecord(
      {
        ...current,
        eligibility: "RATE_LIMITED",
        verification: current.verification === "VERIFIED" ? "VERIFIED" : "UNVERIFIED",
        rateLimits,
        failureReason: kind,
        evidence: { source: "live_probe", checkedAt: now, confidence: 0.8 },
      },
      now,
    );
  }
  if (kind === "exhausted") {
    return makeRecord(
      {
        ...current,
        eligibility: "EXHAUSTED",
        verification: "FAILED",
        rateLimits,
        failureReason: kind,
        evidence: { source: "live_probe", checkedAt: now, confidence: 0.85 },
      },
      now,
    );
  }
  if (kind === "billing") {
    return makeRecord(
      {
        ...current,
        eligibility: "NOT_ELIGIBLE",
        verification: "FAILED",
        failureReason: kind,
        evidence: { source: "live_probe", checkedAt: now, confidence: 0.85 },
      },
      now,
    );
  }
  return makeRecord(
    {
      ...current,
      verification: "FAILED",
      failureReason: kind,
      liveProbe: {
        chatVerified: false,
        streamVerified: false,
        status: Number(probe.status || 0),
        checkedAt: now,
        latencyMs: probe.latencyMs ?? null,
        streamFailure: probe.streamError || null,
      },
      evidence: { source: "live_probe", checkedAt: now, confidence: 0.5 },
    },
    now,
  );
}

function classifyModel(input = {}, now = Date.now()) {
  const existing = readExistingRecord(input);
  if (existing && input.probe) return applyProbe(existing, input.probe, now);
  if (existing && !input.reclassify) return existing;

  if (isLocalModel(input) || isLocalModel({ kind: input.kind, provider: input.providerId })) {
    const local = classifyLocal(now);
    return input.probe ? applyProbe(local, input.probe, now) : local;
  }

  const providerId = String(input.providerId || input.provider || "").toLowerCase();
  const adapter = ADAPTERS[providerId];
  let record = adapter
    ? adapter(input, now)
    : makeRecord(
        {
          billingMode: "UNKNOWN",
          eligibility: "UNKNOWN",
          verification: "UNVERIFIED",
          evidence: { source: "provider_model_catalog", checkedAt: now, confidence: 0 },
        },
        now,
      );
  record = applyOwnerDeclaration(record, input.ownerDeclaration, now);
  if (input.probe) record = applyProbe(record, input.probe, now);
  return record;
}

/**
 * Owner-declared evidence. A provider "this key is on the free tier" promotes
 * UNKNOWN only — a published PAID price stays PAID. A per-model mark free or
 * mark paid is stored as owner_declared and is shown as the owner's word.
 */
function applyOwnerDeclaration(record, declaration, now) {
  if (!declaration || typeof declaration !== "object") return record;
  const mark =
    declaration.model === "free" || declaration.model === "paid" ? declaration.model : null;
  if (mark === "paid") {
    return makeRecord(
      {
        ...record,
        billingMode: "PAID",
        eligibility: "ELIGIBLE",
        evidence: { source: "owner_declared", checkedAt: now, confidence: 0.9 },
      },
      now,
    );
  }
  if (mark === "free") {
    return makeRecord(
      {
        ...record,
        billingMode: record.billingMode === "ZERO_COST" ? "ZERO_COST" : "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        evidence: { source: "owner_declared", checkedAt: now, confidence: 0.9 },
      },
      now,
    );
  }
  if (declaration.providerFreeTier === true && record.billingMode === "UNKNOWN") {
    return makeRecord(
      {
        ...record,
        billingMode: "FREE_QUOTA",
        eligibility: "ELIGIBLE",
        evidence: { source: "owner_declared", checkedAt: now, confidence: 0.6 },
      },
      now,
    );
  }
  return record;
}

/**
 * Coarse free/paid/unknown for existing callers.
 * A pre-stamped coarse `access` string is honoured only when it came from
 * this classifier (accessRecord present) — never as a name heuristic.
 */
function classifyAccess(model = {}, now = Date.now()) {
  if (isLocalModel(model)) return "free";
  const existing = readExistingRecord(model);
  if (existing) return coarseAccess(existing);
  const record = classifyModel(
    {
      providerId: model.meta?.providerId || model.provider,
      provider: model.provider,
      modelId: model.meta?.modelName || model.id,
      kind: model.meta?.kind || model.type || model.kind,
      catalogue: model.catalogue || model.meta?.catalogue || model,
      account: model.account || model.meta?.account,
      declaredAccess: model.meta?.declaredAccess,
      ownerDeclaration: model.ownerDeclaration || model.meta?.ownerDeclaration,
      customEndpoint: model.meta?.customEndpoint,
      endpoint: model.endpoint || model.meta?.endpoint,
      probe: model.probe || model.meta?.probe,
      accessRecord: existing,
    },
    now,
  );
  return coarseAccess(record);
}

function accessOf(model = {}, now = Date.now()) {
  const existing = readExistingRecord(model);
  if (existing) return existing;
  if (isLocalModel(model)) return classifyLocal(now);
  return classifyModel(
    {
      providerId: model.meta?.providerId || model.provider,
      provider: model.provider,
      modelId: model.meta?.modelName || model.id,
      kind: model.meta?.kind || model.type || model.kind,
      catalogue: model.catalogue || model.meta?.catalogue || model,
      account: model.account || model.meta?.account,
      declaredAccess: model.meta?.declaredAccess,
      ownerDeclaration: model.ownerDeclaration || model.meta?.ownerDeclaration,
      customEndpoint: model.meta?.customEndpoint,
      endpoint: model.endpoint || model.meta?.endpoint,
      probe: model.probe || model.meta?.probe,
    },
    now,
  );
}

/**
 * Owner's per-provider tier filter. Fail closed: free never returns the
 * leftover catalogue when nothing qualifies.
 */
function filterByTier(models, tier, providerId = null) {
  const list = Array.isArray(models) ? models : [];
  if (tier !== "free" && tier !== "paid") return list;
  const kept = [];
  for (const model of list) {
    const record =
      readExistingRecord(model) ||
      classifyModel({
        providerId: providerId || model.provider,
        modelId: model.id,
        kind: model.kind,
        catalogue: model,
        account: model.account,
        declaredAccess: tier,
      });
    if (tier === "free") {
      if (isFreeCandidate(record)) kept.push({ ...model, accessRecord: record });
    } else if (coarseAccess(record) === "paid") {
      kept.push({ ...model, accessRecord: record });
    }
  }
  return kept;
}

function stampVerified(model, billingMode = "FREE_QUOTA") {
  const record = makeRecord({
    billingMode,
    eligibility: "ELIGIBLE",
    verification: "VERIFIED",
    evidence: { source: "live_probe", checkedAt: Date.now(), confidence: 1 },
  });
  return {
    ...model,
    accessRecord: record,
    access: "free",
    meta: { ...(model.meta || {}), accessRecord: record },
  };
}

function decorateModel(model, now = Date.now()) {
  const record = accessOf(model, now);
  return {
    ...model,
    accessRecord: record,
    access: coarseAccess(record),
    accessStatus: effectiveStatus(record),
    accessObject: toAccessObject(model, record),
    pricingVerified: record.verification === "VERIFIED" && record.billingMode !== "UNKNOWN",
    lastVerified: record.evidence?.checkedAt || null,
  };
}

function toAccessObject(model = {}, record = null) {
  const rec = record || accessOf(model);
  const provider = String(model.providerId || model.meta?.providerId || model.provider || "");
  const modelId = String(model.modelId || model.meta?.modelName || model.id || "");
  return {
    provider,
    modelId,
    displayName: String(model.displayName || model.label || model.name || modelId),
    kind: isLocalModel(model) ? "local" : "cloud",
    endpoint: model.endpoint || model.meta?.endpoint || null,
    protocol: model.wire || model.provider || model.meta?.wire || null,
    capabilities: model.capabilities || model.meta?.capabilities || null,
    pricing: {
      input: rec.pricing?.input ?? null,
      output: rec.pricing?.output ?? null,
      currency: rec.pricing?.currency || "USD",
      source: rec.pricing?.source || rec.evidence?.source || null,
      native: rec.pricing?.native || null,
    },
    pricingEvidence: {
      source: rec.pricing?.source || rec.evidence?.source || null,
      checkedAt: rec.evidence?.checkedAt || 0,
      expiresAt: rec.evidence?.expiresAt || null,
    },
    entitlementEvidence: {
      source: rec.evidence?.source || null,
      confidence: rec.evidence?.confidence ?? 0,
      creditSource: rec.creditSource || "UNKNOWN",
    },
    access: {
      billingMode: rec.billingMode,
      eligibility: rec.eligibility,
      verification: rec.verification,
      confidence: rec.evidence?.confidence ?? 0,
      source: rec.evidence?.source || null,
      checkedAt: rec.evidence?.checkedAt || 0,
      expiresAt: rec.evidence?.expiresAt || null,
      creditSource: rec.creditSource || null,
    },
    quota: rec.quota || {
      remaining: rec.rateLimits?.remainingRequests ?? null,
      limit: rec.rateLimits?.limitRequests ?? null,
      resetAt: rec.rateLimits?.retryAfter || null,
      source: rec.evidence?.source || null,
    },
    rateLimits: rec.rateLimits || null,
    liveProbe: rec.liveProbe || null,
    failureReason: rec.failureReason || null,
    health: {
      status: effectiveStatus(rec),
      lastSuccess: rec.verification === "VERIFIED" ? rec.evidence?.checkedAt || null : null,
      lastFailure: rec.verification === "FAILED" ? rec.evidence?.checkedAt || null : null,
      cooldownUntil: null,
    },
  };
}

function validationState({
  keyConfigured = false,
  authenticated = false,
  catalogueAvailable = false,
  pricingKnown = false,
  freeEligibilityKnown = false,
  freeModelAvailable = false,
  liveChatVerified = false,
  streamVerified = false,
} = {}) {
  return {
    keyConfigured: Boolean(keyConfigured || authenticated),
    authenticated: Boolean(authenticated),
    catalogueFetched: Boolean(catalogueAvailable),
    catalogueAvailable: Boolean(catalogueAvailable),
    pricingKnown: Boolean(pricingKnown),
    freeEligibilityKnown: Boolean(freeEligibilityKnown),
    modelAvailable: Boolean(freeModelAvailable || catalogueAvailable),
    freeModelAvailable: Boolean(freeModelAvailable),
    chatVerified: Boolean(liveChatVerified),
    liveChatVerified: Boolean(liveChatVerified),
    streamVerified: Boolean(streamVerified),
  };
}

const PAGE_MARKERS = Object.freeze({
  groq: /supported models|price per 1m tokens/i,
  gemini: /free tier/i,
  openai: /per 1m tokens/i,
  anthropic: /pricing/i,
  deepseek: /pricing/i,
  perplexity: /pricing/i,
  mistral: /pricing/i,
});

function knowledgeCatalogue(now = Date.now()) {
  const groq = groqTable(now);
  const gemini = geminiTable(now);
  const rows = [
    {
      id: "groq",
      source: groq.source,
      sourceName: groq.sourceName,
      checkedAt: groq.checkedAt,
      ttlMs: groq.ttlMs,
    },
    {
      id: "gemini",
      source: gemini.source,
      sourceName: gemini.sourceName,
      checkedAt: gemini.checkedAt,
      ttlMs: gemini.ttlMs,
    },
    {
      id: "mistral",
      source: MISTRAL_API_PRICING.source,
      sourceName: MISTRAL_API_PRICING.sourceName,
      checkedAt: MISTRAL_API_PRICING.checkedAt,
      ttlMs: MISTRAL_API_PRICING.ttlMs,
    },
  ];
  for (const [id, meta] of Object.entries(METERED_API_DEFAULT)) {
    rows.push({
      id,
      source: meta.source,
      sourceName: meta.sourceName,
      checkedAt: meta.checkedAt,
      ttlMs: meta.ttlMs,
    });
  }
  return rows;
}

function planKnowledgeRefresh(now = Date.now()) {
  return knowledgeCatalogue(now)
    .map((entry) => {
      const expiresAt = Number(entry.checkedAt) + Number(entry.ttlMs);
      const remainingMs = expiresAt - now;
      return {
        id: entry.id,
        source: entry.source,
        sourceName: entry.sourceName,
        checkedAt: entry.checkedAt,
        expiresAt,
        remainingMs,
        due: remainingMs <= REFRESH_LEAD_MS,
        expired: remainingMs <= 0,
      };
    })
    .filter((row) => row.due);
}

function parsedPriceUsable(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.priced && typeof parsed.priced === "object" && Object.keys(parsed.priced).length)
    return true;
  if (Array.isArray(parsed.freeTierPrefixes) && parsed.freeTierPrefixes.length) return true;
  return false;
}

/**
 * Apply a pricing page only after it parses. A miss leaves the last table,
 * which still fails closed when that table is older than its TTL.
 */
function commitParsedKnowledge({ id, pageText, parsed, now, sourceUrl } = {}) {
  const decision = acceptPageEvidence({ id, pageText, parsed, now, sourceUrl });
  if (!decision.ok) return { applied: false, reason: decision.reason };
  if (!parsedPriceUsable(parsed)) return { applied: false, reason: "no-price" };
  const current = id === "groq" ? groqTable(now) : id === "gemini" ? geminiTable(now) : null;
  if (!current) return { applied: false, reason: "no-price-table" };
  const row = {
    checkedAt: decision.staged.checkedAt,
    source: decision.staged.source,
    ttlMs: decision.staged.ttlMs,
  };
  if (parsed.priced && typeof parsed.priced === "object") {
    row.priced = { ...(current.priced || {}), ...parsed.priced };
  }
  if (Array.isArray(parsed.freeTierPrefixes)) {
    row.freeTierPrefixes = Array.from(
      new Set([...(current.freeTierPrefixes || []), ...parsed.freeTierPrefixes]),
    );
  }
  applyKnowledgeOverlay({ [id]: row });
  return { applied: true, reason: "parsed", checkedAt: row.checkedAt };
}

function acceptPageEvidence({ id, pageText, parsed, now, sourceUrl } = {}) {
  const text = String(pageText || "").trim();
  if (text.length < 40) return { ok: false, reason: "empty" };
  const marker = PAGE_MARKERS[id];
  if (!marker) return { ok: false, reason: "unknown-source" };
  if (!marker.test(text)) return { ok: false, reason: "unrecognized" };
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "no-parse" };
  if (!sourceUrl) return { ok: false, reason: "no-source" };
  return {
    ok: true,
    staged: {
      id,
      source: String(sourceUrl),
      checkedAt: now,
      ttlMs: DOC_TTL_MS,
      parsed,
    },
  };
}

module.exports = {
  CATALOGUE_TTL_MS,
  PRICING_TTL_MS,
  ENTITLEMENT_TTL_MS,
  PROBE_TTL_MS,
  BILLING_MODES,
  ELIGIBILITY,
  VERIFICATION,
  EVIDENCE_SOURCES,
  CREDIT_SOURCES,
  FREE_CREDIT_SOURCES,
  FREE_BILLING,
  LOCAL_KINDS,
  LOCAL_PROVIDERS,
  GROQ_MODEL_PRICING,
  GROQ_FREE_PLAN,
  ZHIPU_FREE_IDS,
  NVIDIA_FREE_TRIAL,
  GEMINI_FREE_TIER,
  MISTRAL_API_PRICING,
  METERED_API_DEFAULT,
  knowledgeCatalogue,
  planKnowledgeRefresh,
  acceptPageEvidence,
  commitParsedKnowledge,
  applyKnowledgeOverlay,
  clearKnowledgeOverlay,
  looksFreeName,
  isLocalModel,
  cataloguePricing,
  makeRecord,
  effectiveStatus,
  coarseAccess,
  officialFreeUsable,
  isFreeCandidate,
  isVerifiedFree,
  isFreeOnlyEligible,
  freeRank,
  candidateRank,
  creditSourceOf,
  parseRateLimitHeaders,
  quotaMeter,
  applyProbe,
  applyOwnerDeclaration,
  classifyModel,
  classifyAccess,
  accessOf,
  filterByTier,
  decorateModel,
  toAccessObject,
  stampVerified,
  validationState,
  knowledgeFresh,
  KNOWLEDGE_CHECKED_AT,
  DOC_TTL_MS,
  PROVIDER_EVIDENCE,
  classifyDocumented,
  fitsQuota,
  refreshFreeKnowledge,
  cloudAllowed,
  scheduleFreeRefresh,
};
