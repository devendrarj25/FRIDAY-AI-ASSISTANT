/**
 * FRIDAY · real model operations (main process).
 *
 * Everything here talks to a real service or the real filesystem:
 *   · Ollama          — /api/tags, /api/pull (streamed), /api/delete, /api/show
 *   · OpenAI-compatible local servers (LM Studio, llama.cpp, vLLM, LocalAI, Jan) — /v1/models
 *   · Cloud providers — their real model-list endpoint, using the stored key
 *   · Local GGUF folders — a real directory walk
 *
 * Nothing is simulated and nothing is downloaded unless the renderer explicitly
 * asks for it. Keys are stored with Electron safeStorage when available.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
// The one canonical folder contract — model folders are never named locally.
const contract = require("./friday-contract.cjs");
// Outbound HTTP goes through Chromium when Electron is up so the system proxy,
// PAC config and corporate certificates apply (see net-fetch.cjs).
const { fetchCompat } = require("./net-fetch.cjs");
const modelAccess = require("./model-access.cjs");
const modelRouter = require("./model-router.cjs");
const modelCapabilities = require("./model-capabilities.cjs");

const OLLAMA = process.env.OLLAMA_HOST?.replace(/\/+$/, "") || "http://127.0.0.1:11434";

/** Local OpenAI-compatible engines, by their documented default port. */
const LOCAL_ENGINES = {
  lmstudio: { name: "LM Studio", endpoint: "http://127.0.0.1:1234" },
  llamacpp: { name: "llama.cpp", endpoint: "http://127.0.0.1:8080" },
  vllm: { name: "vLLM", endpoint: "http://127.0.0.1:8000" },
  // Vendor default is :8080, which is already llama.cpp. Bind LocalAI to 8081.
  localai: { name: "LocalAI", endpoint: "http://127.0.0.1:8081" },
  // Desktop Local API Server default (Settings → Start Server). CLI `jan serve` is 6767.
  jan: {
    name: "Jan",
    endpoint: "http://127.0.0.1:1337",
    alternates: ["http://127.0.0.1:6767"],
    env: "FRIDAY_JAN_ENDPOINT",
  },
};
if (process.platform === "darwin") {
  // mlx_lm.server is Apple silicon only. Never listed as a live engine on Windows.
  LOCAL_ENGINES.mlx = { name: "MLX-LM", endpoint: "http://127.0.0.1:8082" };
}

/**
 * Cloud providers and the real endpoint used to validate a key.
 *
 * `chat` is the OpenAI-compatible base the kernel router streams from, and
 * `wire` is the protocol the router must speak. A provider without a `chat`
 * base is listed and testable but never offered for routing.
 */
const CLOUD = {
  openai: {
    name: "OpenAI",
    env: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/models",
    chat: "https://api.openai.com/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  anthropic: {
    name: "Anthropic",
    env: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/models",
    chat: "https://api.anthropic.com/v1",
    wire: "anthropic",
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  gemini: {
    name: "Google Gemini",
    env: "GEMINI_API_KEY",
    // ONE surface for Gemini: Google's OpenAI-compatible endpoint. The health
    // check lists models from the very base the chat router streams from, so a
    // "connected" badge can never mean a different API than the one used for
    // real turns. The native /v1beta/models surface (x-goog-api-key, a
    // different response shape) is deliberately not used here.
    url: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    chat: "https://generativelanguage.googleapis.com/v1beta/openai",
    wire: "online",
    // OpenAI-compatible auth only — never x-goog-api-key, and never both.
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => String(m.id).replace(/^models\//, "")),
  },

  groq: {
    name: "Groq",
    env: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/models",
    chat: "https://api.groq.com/openai/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  mistral: {
    name: "Mistral",
    env: "MISTRAL_API_KEY",
    url: "https://api.mistral.ai/v1/models",
    chat: "https://api.mistral.ai/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  cohere: {
    name: "Cohere",
    env: "COHERE_API_KEY",
    // Cohere's own REST surface lists the catalogue (GET /v1/models →
    // { models: [{ name, endpoints: [...] }] }, docs.cohere.com/reference/list-models);
    // `endpoint=chat` asks the API itself which models can answer a chat turn,
    // so embed/rerank models never reach the router.
    url: "https://api.cohere.com/v1/models?endpoint=chat&page_size=100",
    // Cohere's documented OpenAI-compatible surface (Compatibility API), which
    // is the wire the kernel router already speaks for every other provider.
    chat: "https://api.cohere.ai/compatibility/v1",
    wire: "online",
    // Same compatibility surface on Cohere's primary api.cohere.com host.
    alternates: ["https://api.cohere.com/compatibility/v1"],
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) =>
      (j.models || [])
        .filter((m) => {
          if (m?.is_deprecated === true) return false;
          const eps = Array.isArray(m?.endpoints) ? m.endpoints : [];
          return eps.length ? eps.includes("chat") : true;
        })
        .map((m) => String(m.name || "")),
  },
  deepseek: {
    name: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    url: "https://api.deepseek.com/models",
    chat: "https://api.deepseek.com/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  nvidia: {
    name: "NVIDIA NIM",
    env: "NVIDIA_API_KEY",
    url: "https://integrate.api.nvidia.com/v1/models",
    chat: "https://integrate.api.nvidia.com/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
    // NVIDIA's catalogue is public: GET /v1/models answers 200 even with a
    // bogus key. Authentication is proved with a 1-token chat turn against a
    // listed model (retired models answer 410 before auth, so a few are tried).
    verify: { mode: "chat", fromListing: 6 },
  },

  fireworks: {
    name: "Fireworks AI",
    env: "FIREWORKS_API_KEY",
    url: "https://api.fireworks.ai/inference/v1/models",
    chat: "https://api.fireworks.ai/inference/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  deepinfra: {
    name: "DeepInfra",
    env: "DEEPINFRA_API_KEY",
    // Listing lives at the top level, not under /v1/openai (chat does).
    url: "https://api.deepinfra.com/v1/models",
    chat: "https://api.deepinfra.com/v1/openai",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  cerebras: {
    name: "Cerebras",
    env: "CEREBRAS_API_KEY",
    url: "https://api.cerebras.ai/v1/models",
    chat: "https://api.cerebras.ai/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  sambanova: {
    name: "SambaNova Cloud",
    env: "SAMBANOVA_API_KEY",
    url: "https://api.sambanova.ai/v1/models",
    chat: "https://api.sambanova.ai/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
    // SambaNova's listing is public too, so the key is proved with a
    // 1-token chat turn against a listed model (an unknown id answers 404
    // before auth is checked, so it cannot stand in for the probe).
    verify: { mode: "chat", fromListing: 3 },
  },

  moonshot: {
    name: "Moonshot (Kimi)",
    env: "MOONSHOT_API_KEY",
    url: "https://api.moonshot.ai/v1/models",
    chat: "https://api.moonshot.ai/v1",
    wire: "online",
    // Moonshot serves the same OpenAI wire from a second official host for
    // mainland accounts; self-healing tries it when the default stops answering.
    alternates: ["https://api.moonshot.cn/v1"],
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  zhipu: {
    name: "Z.ai (GLM)",
    env: "ZHIPU_API_KEY",
    url: "https://api.z.ai/api/paas/v4/models",
    chat: "https://api.z.ai/api/paas/v4",
    wire: "online",
    // Z.ai's China platform (open.bigmodel.cn) serves the same v4 wire.
    alternates: ["https://open.bigmodel.cn/api/paas/v4"],
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  huggingface: {
    name: "Hugging Face Inference",
    env: "HF_TOKEN",
    url: "https://router.huggingface.co/v1/models",
    chat: "https://router.huggingface.co/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    // HF's router auto-selects a backing provider for a BARE model id, so the
    // id is sent unsuffixed (`owner/model`). What the id cannot express is
    // whether ANY provider is currently serving it — the listing does, in a
    // per-model `providers[]` array with a live/error `status`. Models whose
    // providers are all down are dropped here instead of failing mid-chat.
    // An explicit `owner/model:provider` pin is still honoured if it appears.
    list: (j) =>
      (j.data || [])
        .filter((m) => {
          const list = Array.isArray(m?.providers) ? m.providers : [];
          return list.length ? list.some((p) => (p?.status || "live") === "live") : true;
        })
        .map((m) => m.id),
    // The router's catalogue is public, so the token is proved against Hugging
    // Face's own identity endpoint (huggingface.co/api/whoami-v2).
    verify: { mode: "get", url: "https://huggingface.co/api/whoami-v2" },
  },
  together: {
    name: "Together AI",
    env: "TOGETHER_API_KEY",
    url: "https://api.together.ai/v1/models",
    chat: "https://api.together.ai/v1",
    wire: "online",
    // Retain the former official host as a compatibility fallback.
    alternates: ["https://api.together.xyz/v1"],
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (Array.isArray(j) ? j : j.data || []).map((m) => m.id),
  },

  xai: {
    name: "xAI (Grok)",
    env: "XAI_API_KEY",
    url: "https://api.x.ai/v1/models",
    chat: "https://api.x.ai/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  perplexity: {
    name: "Perplexity",
    env: "PERPLEXITY_API_KEY",
    url: "https://api.perplexity.ai/v1/models",
    chat: "https://api.perplexity.ai",
    // Perplexity serves the OpenAI wire straight off the host root.
    chatPath: "/chat/completions",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  nebius: {
    name: "Nebius Token Factory",
    env: "NEBIUS_API_KEY",
    // Nebius renamed "AI Studio" to "Token Factory"; the studio host still
    // answers but is no longer in their docs, so FRIDAY tracks the current one.
    url: "https://api.tokenfactory.nebius.com/v1/models",
    chat: "https://api.tokenfactory.nebius.com/v1",
    wire: "online",
    // The former "AI Studio" host still answers for older accounts.
    alternates: ["https://api.studio.nebius.com/v1"],
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
  },
  openrouter: {
    name: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/models",
    chat: "https://openrouter.ai/api/v1",
    wire: "online",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    list: (j) => (j.data || []).map((m) => m.id),
    // OpenRouter's free line-up rotates constantly: a specific `:free` id can
    // be rate-limited, gated or retired without notice. `openrouter/free` is
    // OpenRouter's own free router, which picks a working free model for each
    // request, so it is pinned in front as the dependable free candidate.
    pinned: ["openrouter/free"],
    // OpenRouter's catalogue is public; the key is proved against its own
    // key-info endpoint (openrouter.ai/docs/api-reference/limits).
    verify: { mode: "get", url: "https://openrouter.ai/api/v1/key" },
  },
};

// ------------------------------------------------------------------ helpers
/**
 * The headers used for a provider's OpenAI-compatible chat surface. Most
 * providers authenticate the same way everywhere; the ones that do not (Gemini)
 * declare `chatHeaders` and that wins for chat/completions calls.
 */
function chatHeaders(spec, key) {
  return spec?.chatHeaders ? spec.chatHeaders(key) : spec.headers(key);
}

/**
 * The real chat-completions URL for an OpenAI-compatible base.
 * Mirrors kernel/router.py `openai_chat_url` so a health probe never hits a
 * different path than a live turn (the Gemini `/v1beta/openai/v1/...` class).
 */
const VERSIONED_TAIL = /\/(v\d+[a-z0-9]*|openai|compatibility\/v\d+|paas\/v\d+)$/i;
function openaiChatUrl(base, chatPath) {
  const trimmed = String(base || "").replace(/\/+$/, "");
  if (chatPath) return trimmed + chatPath;
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (VERSIONED_TAIL.test(trimmed)) return trimmed + "/chat/completions";
  return trimmed + "/v1/chat/completions";
}

/**
 * The provider's own words for a failure. Never invent a reason: whatever the
 * API actually answered (JSON `error.message`, or the raw body) is what the
 * owner is shown, together with the real HTTP status.
 */
function providerMessage(res) {
  const body = res?.body;
  const fromJson =
    body?.error?.message ||
    (typeof body?.error === "string" ? body.error : null) ||
    body?.message ||
    body?.detail;
  const text = fromJson || (res?.text ? String(res.text).slice(0, 400) : "");
  return String(text || "").trim();
}

/** `HTTP 401 — <what the provider really said>`, or the transport error. */
function describeFailure(res) {
  if (res?.error) return res.error;
  const said = providerMessage(res);
  return said ? `HTTP ${res.status} — ${said}` : `HTTP ${res.status}`;
}

async function request(url, { timeout = 6000, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetchCompat(url, { ...init, signal: controller.signal });
    const latencyMs = Date.now() - started;
    // Read the body once as text, then parse: a failing provider often answers
    // with a JSON error, and sometimes with plain text or HTML. Both are kept
    // so the real reason can be surfaced instead of a canned message.
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, text, latencyMs, headers: headerMap(res) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      text: "",
      headers: {},
      latencyMs: Date.now() - started,
      error: String(err.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function headerMap(res) {
  const out = {};
  try {
    const headers = res?.headers;
    if (!headers) return out;
    if (typeof headers.forEach === "function") {
      headers.forEach((value, key) => {
        out[String(key).toLowerCase()] = String(value);
      });
      return out;
    }
    for (const [key, value] of Object.entries(headers || {})) {
      out[String(key).toLowerCase()] = String(value);
    }
  } catch {
    /* ignore */
  }
  return out;
}

const gb = (bytes) => Number(((bytes || 0) / 1024 ** 3).toFixed(2));

// ------------------------------------------------------------- key storage
let safeStorage = null;
let electronApp = null;
try {
  ({ safeStorage, app: electronApp } = require("electron"));
} catch {
  safeStorage = null;
  electronApp = null;
}

const productionMode = () => {
  try {
    return Boolean(electronApp?.isPackaged);
  } catch {
    return false;
  }
};

const encryptionAvailable = () => {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable());
  } catch {
    return false;
  }
};

/**
 * Provider credentials live in exactly ONE place: <FRIDAY_ROOT>/config.
 *
 * Without a selected root there is no credential store at all — FRIDAY never
 * writes keys into a temp folder or AppData, because that would become a
 * second, invisible store that survives an uninstall. Historical locations
 * (a `provider-keys.json` sitting directly in the root, or a pre-setup
 * bootstrap folder) are read ONCE by `migrateCredentials()` and moved into the
 * canonical file; after that the canonical file is the only authority.
 */
const keyFile = (root) => (root ? path.join(root, "config", "provider-keys.json") : null);
/** Historical, migration-only location. Never written to. */
const legacyKeyFile = (root) => (root ? path.join(root, "provider-keys.json") : null);

function readRawKeys(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * One-shot migration of legacy credential files into the canonical store.
 * Entries already present canonically always win; nothing is ever logged.
 * `sources` are extra legacy roots (e.g. the old Electron userData folder).
 */
function migrateCredentials(root, sources = []) {
  const target = keyFile(root);
  if (!target) return { ok: false, migrated: 0, error: "no FRIDAY root selected" };
  const candidates = [
    legacyKeyFile(root),
    ...sources
      .filter(Boolean)
      .flatMap((dir) => [
        path.join(dir, "config", "provider-keys.json"),
        path.join(dir, "provider-keys.json"),
      ]),
  ].filter((file) => file && path.resolve(file) !== path.resolve(target));

  const current = readRawKeys(target);
  let migrated = 0;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const [id, value] of Object.entries(readRawKeys(file))) {
      if (current[id] !== undefined || value === undefined || value === null) continue;
      current[id] = value;
      migrated += 1;
    }
    try {
      fs.renameSync(file, `${file}.migrated`);
    } catch {
      /* left in place; the canonical copy is authoritative from now on */
    }
  }
  if (migrated) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(current, null, 2));
    } catch {
      return { ok: false, migrated: 0, error: "canonical credential store is not writable" };
    }
  }
  return { ok: true, migrated };
}

function readKeys(userData) {
  const file = keyFile(userData);
  if (!file) return {};
  const raw = readRawKeys(file);
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (value && typeof value === "object" && value.enc && encryptionAvailable()) {
      try {
        out[id] = safeStorage.decryptString(Buffer.from(value.enc, "base64"));
      } catch {
        /* key was written on another machine — ignore it */
      }
    } else if (typeof value === "string") {
      out[id] = value;
    }
  }
  return out;
}

function writeKey(userData, id, apiKey) {
  const file = keyFile(userData);
  if (!file)
    return { ok: false, stored: false, encrypted: false, error: "no FRIDAY folder selected yet" };
  // Packaged FRIDAY refuses plaintext keys, same as credentials.cjs. Dev and
  // the test suite (no Electron safeStorage) still write so they keep running.
  const ownerRefusesUnencrypted = (() => {
    try {
      const prefs = path.join(userData, "config", "friday-preferences.json");
      const raw = JSON.parse(fs.readFileSync(prefs, "utf8"));
      return Boolean(raw && raw.toggles && raw.toggles.encryption === true);
    } catch {
      return false;
    }
  })();
  if (apiKey && !encryptionAvailable() && (productionMode() || ownerRefusesUnencrypted)) {
    return {
      ok: false,
      stored: false,
      encrypted: false,
      error:
        "Windows secure storage is unavailable, so FRIDAY refuses to save this credential. " +
        "Sign in to your normal Windows account (not a temporary or sandboxed profile) and try again.",
    };
  }
  const raw = readRawKeys(file);

  if (!apiKey) delete raw[id];
  else if (encryptionAvailable())
    raw[id] = { enc: safeStorage.encryptString(apiKey).toString("base64") };
  else raw[id] = apiKey;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return {
    ok: true,
    stored: Boolean(apiKey),
    encrypted: encryptionAvailable(),
  };
}

const resolveKey = (userData, id) =>
  readKeys(userData)[id] || process.env[CLOUD[id]?.env || ""] || null;

// -------------------------------------------------------- endpoint overrides
/**
 * A provider may be reached through a custom base URL (self-hosted gateway,
 * Azure-style deployment, an OpenAI-compatible proxy). The owner's endpoint is
 * stored next to the keys and MUST win over the built-in default everywhere:
 * key validation, model discovery and the chat base handed to the router.
 *
 * An override is assumed to be OpenAI-compatible (`<base>/models`,
 * `<base>/chat/completions`) because that is the only base URL shape every
 * provider in FRIDAY documents for custom gateways.
 */
const endpointFile = (root) => (root ? path.join(root, "config", "provider-endpoints.json") : null);

const cleanBase = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/\/+$/, "");

function readEndpoints(userData) {
  const source = endpointFile(userData);
  if (!source) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(source, "utf8"));
    const out = {};
    for (const [id, value] of Object.entries(raw || {})) {
      const base = cleanBase(value);
      if (base && /^https?:\/\//i.test(base)) out[id] = base;
    }
    return out;
  } catch {
    return {};
  }
}

function writeEndpoint(userData, id, endpoint) {
  const file = endpointFile(userData);
  if (!file) return { ok: false, error: "no FRIDAY folder selected yet" };
  const base = cleanBase(endpoint);
  if (base && !/^https?:\/\//i.test(base))
    return { ok: false, error: "endpoint must start with http:// or https://" };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    raw = {};
  }
  if (!base) delete raw[id];
  else raw[id] = base;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return { ok: true, id, endpoint: base || null };
}

/**
 * The real URLs used for one cloud provider right now.
 * `custom` says whether the owner's endpoint replaced the documented default.
 */
function resolveEndpoints(userData, id) {
  const spec = CLOUD[id];
  const override = readEndpoints(userData)[id] || null;
  if (!spec) return override ? { base: override, list: `${override}/models`, custom: true } : null;
  if (!override) return { base: spec.chat || null, list: spec.url, custom: false };
  return { base: override, list: `${override}/models`, custom: true };
}

// ------------------------------------------------------- access tier (cost)
/**
 * Per-provider cost tier chosen by the owner when connecting the provider:
 *
 *   auto — classify each model from provider pricing/access evidence
 *   free — use ONLY this provider's free-class candidates (fail closed)
 *   paid — use ONLY this provider's paid models (still gated by billing)

 *
 * Stored next to the keys so it travels with the workspace.
 */
const ACCESS_TIERS = ["auto", "free", "paid"];
const accessFile = (root) => (root ? path.join(root, "config", "provider-access.json") : null);

/** Name heuristic kept as a signal helper. It is never proof of free access. */
const looksFree = (name = "") => modelAccess.looksFreeName(name);

function readAccessTiers(userData) {
  const source = accessFile(userData);
  if (!source) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(source, "utf8")) || {};
    const out = {};
    for (const [id, value] of Object.entries(raw))
      if (ACCESS_TIERS.includes(value) && value !== "auto") out[id] = value;
    return out;
  } catch {
    return {};
  }
}

function writeAccessTier(userData, id, tier) {
  const value = ACCESS_TIERS.includes(tier) ? tier : "auto";
  const file = accessFile(userData);
  if (!file) return { ok: false, error: "no FRIDAY folder selected yet" };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    raw = {};
  }
  if (value === "auto") delete raw[id];
  else raw[id] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return { ok: true, id, tier: value };
}

function readOwnerDeclarations(userData) {
  const source = accessFile(userData);
  if (!source) return { providers: {}, models: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(source, "utf8")) || {};
    const block = raw._owner && typeof raw._owner === "object" ? raw._owner : {};
    return {
      providers: block.providers && typeof block.providers === "object" ? block.providers : {},
      models: block.models && typeof block.models === "object" ? block.models : {},
    };
  } catch {
    return { providers: {}, models: {} };
  }
}

function writeOwnerDeclaration(userData, patch = {}) {
  const file = accessFile(userData);
  if (!file) return { ok: false, error: "no FRIDAY folder selected yet" };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    raw = {};
  }
  const block = raw._owner && typeof raw._owner === "object" ? raw._owner : {};
  const providers = { ...(block.providers || {}) };
  const models = { ...(block.models || {}) };
  const id = String(patch.providerId || "");
  if (id && patch.ownerFreeTier != null) {
    providers[id] = { ...(providers[id] || {}), ownerFreeTier: Boolean(patch.ownerFreeTier) };
  }
  if (
    id &&
    patch.modelId &&
    (patch.mark === "free" || patch.mark === "paid" || patch.mark === "auto")
  ) {
    const key = `${id}/${patch.modelId}`;
    if (patch.mark === "auto") delete models[key];
    else models[key] = patch.mark;
  }
  raw._owner = { providers, models };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return { ok: true, declarations: { providers, models } };
}

/**
 * Applies the owner's tier to one provider's real model list.
 * Free is fail-closed: no free-class evidence means an empty list, never the
 * leftover paid/unknown catalogue.
 */
function filterByTier(models, tier, providerId = null) {
  return modelAccess.filterByTier(models, tier, providerId);
}

async function ollamaModels() {
  const res = await request(`${OLLAMA}/api/tags`, { timeout: 4000 });
  if (!res.ok)
    return { online: false, latencyMs: null, models: [], error: res.error || `HTTP ${res.status}` };
  return {
    online: true,
    latencyMs: res.latencyMs,
    error: null,
    models: (res.body?.models || []).map((m) => ({
      id: m.name,
      name: m.name,
      provider: "ollama",
      kind: "local",
      sizeGb: gb(m.size),
      family: m.details?.family || null,
      parameters: m.details?.parameter_size || null,
      quantization: m.details?.quantization_level || null,
      format: m.details?.format || "gguf",
      installedAt: m.modified_at || null,
    })),
  };
}

async function ollamaShow(model) {
  const res = await request(`${OLLAMA}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model }),
    timeout: 8000,
  });
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}` };
  return {
    ok: true,
    parameters: res.body?.details?.parameter_size || null,
    quantization: res.body?.details?.quantization_level || null,
    family: res.body?.details?.family || null,
    contextLength: res.body?.model_info?.["general.context_length"] ?? null,
    license: res.body?.license ? String(res.body.license).slice(0, 400) : null,
    template: res.body?.template || null,
  };
}

/**
 * Real streamed pull from the official Ollama registry.
 * `onEvent` receives genuine byte counters from the server, never estimates.
 */
async function ollamaPull(model, onEvent, signal) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
      signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Ollama is not reachable on ${OLLAMA} — ${String(err.message || err)}`,
    };
  }
  if (!res.ok || !res.body) return { ok: false, error: `Ollama returned HTTP ${res.status}` };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastError = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        continue;
      }
      if (payload.error) {
        lastError = payload.error;
        continue;
      }
      const total = Number(payload.total || 0);
      const completed = Number(payload.completed || 0);
      const elapsed = Math.max(0.001, (Date.now() - started) / 1000);
      onEvent?.({
        status: payload.status || "working",
        digest: payload.digest || null,
        gbTotal: gb(total),
        gbDone: gb(completed),
        progress: total > 0 ? Math.min(100, (completed / total) * 100) : null,
        speedMbps: completed > 0 ? Number((completed / 1024 ** 2 / elapsed).toFixed(1)) : 0,
        etaSeconds:
          total > completed && completed > 0
            ? Math.round((total - completed) / (completed / elapsed))
            : 0,
      });
    }
  }
  if (lastError) return { ok: false, error: lastError };
  return { ok: true, model, elapsedMs: Date.now() - started };
}

async function ollamaDelete(model) {
  const res = await request(`${OLLAMA}/api/delete`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model }),
    timeout: 15000,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error || `HTTP ${res.status}` };
}

/** A real one-token generation, used for load/health and honest tok/s. */
async function ollamaProbeRun(model, prompt = "Reply with the single word: ready.") {
  const started = Date.now();
  const res = await request(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: 12 } }),
    timeout: 120000,
  });
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}` };
  const b = res.body || {};
  const evalCount = Number(b.eval_count || 0);
  const evalNs = Number(b.eval_duration || 0);
  return {
    ok: true,
    latencyMs: res.latencyMs,
    firstTokenMs: b.prompt_eval_duration ? Math.round(b.prompt_eval_duration / 1e6) : null,
    tokensPerSec:
      evalNs > 0 && evalCount > 0 ? Number((evalCount / (evalNs / 1e9)).toFixed(1)) : null,
    promptTokensPerSec:
      b.prompt_eval_count && b.prompt_eval_duration
        ? Math.round(b.prompt_eval_count / (b.prompt_eval_duration / 1e9))
        : null,
    totalMs: Date.now() - started,
    response: String(b.response || "")
      .trim()
      .slice(0, 200),
  };
}

/** Ollama keeps a model resident; keep_alive: 0 unloads it for real. */
async function ollamaUnload(model) {
  const res = await request(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0, prompt: "" }),
    timeout: 15000,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error || `HTTP ${res.status}` };
}

/** Models currently resident in memory, straight from /api/ps. */
async function ollamaRunning() {
  const res = await request(`${OLLAMA}/api/ps`, { timeout: 3000 });
  if (!res.ok) return { ok: false, models: [] };
  return {
    ok: true,
    models: (res.body?.models || []).map((m) => ({
      id: m.name,
      sizeGb: gb(m.size),
      vramGb: gb(m.size_vram),
      expiresAt: m.expires_at || null,
    })),
  };
}

// ------------------------------------------------- local OpenAI-compatible
function localEndpointCandidates(id, userData = null) {
  const spec = LOCAL_ENGINES[id];
  if (!spec) return [];
  const configured = userData ? readEndpoints(userData)[id] : null;
  const fromEnv = spec.env ? cleanBase(process.env[spec.env]) : null;
  return [
    ...new Set(
      [configured, fromEnv, spec.endpoint, ...(spec.alternates || [])]
        .map(cleanBase)
        .filter((value) => value && /^https?:\/\//i.test(value)),
    ),
  ];
}

async function localEngine(id, userData = null) {
  const spec = LOCAL_ENGINES[id];
  const endpoints = localEndpointCandidates(id, userData);
  let endpoint = endpoints[0] || spec.endpoint;
  let res = null;
  for (const candidate of endpoints) {
    const attempt = await request(`${candidate}/v1/models`, { timeout: 2500 });
    if (!res) res = attempt;
    if (!attempt.ok) continue;
    endpoint = candidate;
    res = attempt;
    break;
  }
  res ||= { ok: false, status: 0, error: "no endpoint configured", body: null };
  return {
    id,
    name: spec.name,
    kind: "local",
    endpoint,
    online: res.ok,
    latencyMs: res.ok ? res.latencyMs : null,
    error: res.ok ? null : res.error || `no response on ${endpoints.join(" or ")}`,
    models: res.ok
      ? (res.body?.data || []).map((m) => ({
          id: m.id,
          name: m.id,
          provider: id,
          kind: "local",
          sizeGb: 0,
          format: "server",
          catalogue: m,
        }))
      : [],
  };
}

// ------------------------------------------------------------------- cloud
/** OpenAI-compatible list shape, with the provider parser as a fallback. */
function listModelIds(spec, body, custom) {
  const openAiShape = Array.isArray(body?.data)
    ? body.data.map((m) => String(m?.id || m?.name || "")).filter(Boolean)
    : [];
  if (custom) return openAiShape.length ? openAiShape : safeList(spec, body);
  const native = safeList(spec, body);
  return native.length ? native : openAiShape;
}

function listModelEntries(spec, body, custom) {
  const ids = listModelIds(spec, body, custom);
  const rows = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : [];
  const byId = new Map();
  for (const row of rows) {
    const rawId = String(row?.id || row?.name || "");
    const id = rawId.replace(/^models\//, "");
    if (id) byId.set(id, row);
    if (rawId && rawId !== id) byId.set(rawId, row);
  }
  return ids.map((id) => ({ id, name: id, raw: byId.get(id) || null }));
}

function safeList(spec, body) {
  try {
    return (spec?.list?.(body || {}) || []).map(String).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Did the provider reject the key? 401/403 is the usual answer; Google and
 * xAI answer an invalid key with 400 plus an explicit "API key" message, so
 * that shape counts too — otherwise those read as a generic HTTP error.
 */
function authRejected(res) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status !== 400) return false;
  let text = "";
  try {
    text = JSON.stringify(res.body || "");
  } catch {
    text = "";
  }
  return /api[\s_-]?key/i.test(text);
}

/**
 * Some catalogues are public: NVIDIA, SambaNova, Hugging Face and OpenRouter
 * answer their model listing with 200 even for a bogus key. For those a
 * second, authenticated call decides — so "connected" always means the
 * provider really accepted this key, never just that the host answered.
 * A transport failure on the side-check never invalidates a working listing.
 */
const VERIFY_TTL_MS = 10 * 60 * 1000;
const verifyCache = new Map();

const CATALOGUE_TTL_MS = modelAccess.CATALOGUE_TTL_MS || 10 * 60 * 1000;
const STALE_CATALOGUE_GRACE_MS = 30 * 60 * 1000;
const cloudCatalogueCache = new Map();

function invalidateProviderCache(providerId = null) {
  if (providerId) {
    for (const k of cloudCatalogueCache.keys()) {
      if (k.startsWith(`${providerId}:`)) cloudCatalogueCache.delete(k);
    }
  } else {
    cloudCatalogueCache.clear();
    verifyCache.clear();
  }
}

async function verifyKey(spec, key, headers, base, ids) {
  const rule = spec.verify;
  if (!rule) return { ok: true };
  // Verification can cost a token, and the registry refreshes often, so the
  // answer for this exact key is remembered for a few minutes.
  const cacheKey = `${spec.name}:${key}`;
  const cached = verifyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < VERIFY_TTL_MS)
    return { ok: cached.ok, detail: cached.detail || "", account: cached.account || null };
  const remember = (ok, detail = "", account = null) => {
    verifyCache.set(cacheKey, { ok, detail, account, at: Date.now() });
    return { ok, detail, account };
  };
  if (rule.mode === "get") {
    const res = await request(rule.url, { headers, timeout: 8000 });
    if (res.ok) return remember(true, "", res.body);
    return authRejected(res) ? remember(false, describeFailure(res)) : { ok: true };
  }
  if (rule.mode === "chat" && base) {
    const candidates = rule.model
      ? [rule.model]
      : (ids || []).slice(0, Math.max(1, rule.fromListing || 3));
    for (const model of candidates) {
      const res = await request(`${base.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        // The chat surface may authenticate differently from the listing one.
        headers: { ...headers, ...chatHeaders(spec, key), "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        timeout: 12000,
      });
      if (authRejected(res)) return remember(false, describeFailure(res));
      // 404/400 = the key passed and only the probe model was refused.
      if (res.ok || res.status === 404 || res.status === 400) return remember(true);
      // 410 (retired model) and friends: try the next candidate.
    }
  }
  return { ok: true };
}

async function cloudProvider(id, userData, { apiKey = null, force = false } = {}) {
  const spec = CLOUD[id];
  if (!spec) return { id, online: false, error: "unknown provider", models: [] };
  const key = apiKey || resolveKey(userData, id);
  const urls = resolveEndpoints(userData, id);
  if (!key)
    return {
      id,
      name: spec.name,
      kind: "cloud",
      endpoint: urls.list,
      customEndpoint: urls.custom,
      online: false,
      configured: false,
      latencyMs: null,
      error: "no API key connected",
      models: [],
      validation: modelAccess.validationState({ keyConfigured: false }),
    };

  const cacheKey = `${id}:${key}:${urls.list}`;
  const now = Date.now();
  const cached = cloudCatalogueCache.get(cacheKey);

  let res;
  let entries = [];
  let rejected = false;
  let rejectedDetail = "";
  let account = null;
  let isStale = false;
  let base = urls.base;
  let listUrl = urls.list;

  if (cached && !force && !apiKey && now - cached.at < CATALOGUE_TTL_MS) {
    res = cached.res;
    entries = cached.entries;
    rejected = cached.rejected;
    rejectedDetail = cached.rejectedDetail;
    account = cached.account;
  } else {
    // A custom gateway is reached the OpenAI-compatible way; the provider's own
    // auth header is kept alongside it so a same-provider proxy also works.
    const headers = urls.custom
      ? { Authorization: `Bearer ${key}`, ...spec.headers(key) }
      : spec.headers(key);

    res = await request(listUrl, { headers, timeout: 8000 });
    // Self-healing: when the configured host cannot answer for a reason that is
    // not the key, the provider's own alternate official host is tried in place
    // so the list still loads. Nothing is written to disk here — the Doctor's
    // repair owns making a switch permanent.
    if (!res.ok && !urls.custom && !authRejected(res) && Array.isArray(spec.alternates)) {
      for (const alt of spec.alternates) {
        const altBase = alt.replace(/\/+$/, "");
        const retry = await request(`${altBase}/models`, { headers, timeout: 8000 });
        if (!retry.ok && !authRejected(retry)) continue;
        res = retry;
        listUrl = `${altBase}/models`;
        base = altBase;
        break;
      }
    }

    if (!res.ok && !authRejected(res) && cached && now - cached.at < STALE_CATALOGUE_GRACE_MS) {
      // Retain last-known metadata temporarily if provider is temporarily unreachable
      res = cached.res;
      entries = cached.entries;
      rejected = cached.rejected;
      rejectedDetail = cached.rejectedDetail;
      account = cached.account;
      isStale = true;
    } else {
      entries = res.ok ? listModelEntries(spec, res.body || {}, urls.custom) : [];
      // Provider-declared routers (e.g. openrouter/free) are always callable even
      // when they do not appear as ordinary entries in the catalogue.
      if (res.ok && !urls.custom && Array.isArray(spec.pinned)) {
        const have = new Set(entries.map((e) => e.id));
        entries = [
          ...spec.pinned
            .filter((pid) => !have.has(pid))
            .map((pid) => ({ id: pid, name: pid, raw: { id: pid } })),
          ...entries,
        ];
      }
      const ids = entries.map((e) => e.id);

      // Public catalogue: prove the key before calling the provider connected.
      if (res.ok && !urls.custom) {
        const verified = await verifyKey(spec, key, headers, base, ids);
        rejected = !verified.ok;
        rejectedDetail = verified.detail || "";
        account = verified.account || null;
      }

      if (res.ok) {
        cloudCatalogueCache.set(cacheKey, {
          at: now,
          res,
          entries,
          rejected,
          rejectedDetail,
          account,
        });
      }
    }
  }

  const online = res.ok && !rejected;
  // What the owner is told is what the provider actually said — the real HTTP
  // status and its own error body — never a guessed cause. A provider-specific
  // hint is appended after that, never in place of it.
  const said = rejectedDetail || describeFailure(res);
  const hint =
    id === "gemini"
      ? " Checked with GET /v1beta/openai/models using Authorization: Bearer. A Google AI Studio key can list models without Cloud Billing; that listing is not proof that a given model is free to call."
      : "";

  const declared = (userData ? readAccessTiers(userData)[id] : null) || null;
  const accountInfo = accountFromVerify(id, account, declared);
  const classified = online
    ? entries.map((entry) => {
        const catalogue = { id: entry.id, name: entry.name, ...(entry.raw || {}) };
        const classifiedRecord = modelAccess.classifyModel({
          providerId: id,
          modelId: entry.id,
          kind: "cloud",
          catalogue,
          account: accountInfo,
          declaredAccess: declared && declared !== "auto" ? declared : null,
          customEndpoint: urls.custom,
          endpoint: base,
        });
        const accessRecord =
          cachedProbeRecord(id, entry.id, key, declared || "auto") || classifiedRecord;
        if (isStale) {
          accessRecord.stale = true;
          if (accessRecord.evidence) accessRecord.evidence.stale = true;
        }
        return {
          id: entry.id,
          name: entry.name,
          provider: id,
          kind: "cloud",
          sizeGb: 0,
          catalogue,
          accessRecord,
          access: modelAccess.coarseAccess(accessRecord),
          stale: isStale,
        };
      })
    : [];
  const freeCandidates = classified.filter((m) => modelAccess.isFreeCandidate(m.accessRecord));
  const pricingKnown =
    classified.length > 0 &&
    classified.every(
      (m) => m.accessRecord?.billingMode && m.accessRecord.billingMode !== "UNKNOWN",
    );
  const eligibilityKnown =
    classified.length > 0 &&
    classified.every(
      (m) => m.accessRecord?.eligibility && m.accessRecord.eligibility !== "UNKNOWN",
    );
  const chatVerified = classified.some((m) => m.accessRecord?.liveProbe?.chatVerified === true);
  const streamVerified = classified.some((m) => m.accessRecord?.liveProbe?.streamVerified === true);

  return {
    id,
    name: spec.name,
    kind: "cloud",
    endpoint: listUrl,
    customEndpoint: urls.custom,
    online,
    configured: true,
    latencyMs: online ? res.latencyMs : null,
    error: online
      ? null
      : rejected || authRejected(res)
        ? `${spec.name} rejected this key — ${said}.${hint}`
        : describeFailure(res),
    models: classified,
    validation: modelAccess.validationState({
      keyConfigured: true,
      authenticated: online,
      catalogueAvailable: online && classified.length > 0,
      pricingKnown: online && pricingKnown,
      freeEligibilityKnown: online && eligibilityKnown,
      freeModelAvailable: freeCandidates.length > 0,
      liveChatVerified: chatVerified,
      streamVerified,
    }),
  };
}

function accountFromVerify(providerId, body, declared) {
  const data = body && typeof body === "object" ? body.data || body : {};
  const credits = data.credits ?? data.credit_balance ?? data.balance;
  const usage = parseFloat(data.usage);
  const limit = parseFloat(data.limit);
  const remaining = Number.isFinite(limit) && Number.isFinite(usage) ? limit - usage : credits;
  return {
    providerId,
    declaredAccess: declared && declared !== "auto" ? declared : null,
    // "free" is a desired routing tier, not evidence that this key/project is
    // actually entitled to a provider Free Tier. "paid" is safe to fail closed.
    projectTier: declared === "paid" ? "paid" : data.project_tier || data.projectTier,
    billingEnabled: data.billing_enabled === true,
    keyType: data.key_type || data.type || null,
    trial: data.trial === true,
    promotional: data.promotional === true || data.grant === true,
    hfMonthlyCredits: data.monthly_credits === true || data.monthlyCredits === true,
    userFunded: data.user_funded === true || data.prepaid === true,
    creditSource: modelAccess.creditSourceOf({
      creditSource: data.credit_source || data.creditSource || data.balance_type,
      trial: data.trial === true,
      keyType: data.key_type || data.type,
      promotional: data.promotional === true,
      grant: data.grant === true,
      hfMonthlyCredits: data.monthly_credits === true || data.monthlyCredits === true,
      userFunded: data.user_funded === true || data.prepaid === true,
    }),
    credits,
    creditsRemaining: remaining,
    usage: Number.isFinite(usage) ? usage : null,
    limit: Number.isFinite(limit) ? limit : null,
  };
}

// ------------------------------------------------------- local GGUF folders
const MODEL_EXT = new Set([".gguf", ".bin", ".safetensors", ".onnx", ".pt"]);

function scanModelFolder(dir, depth = 2) {
  const found = [];
  const walk = (current, level) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (level > 0) walk(full, level - 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!MODEL_EXT.has(ext)) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      found.push({
        id: `file:${full}`,
        name: entry.name,
        path: full,
        provider: "local",
        kind: "local",
        format: ext.replace(".", ""),
        sizeGb: gb(size),
      });
    }
  };
  walk(dir, depth);
  return found;
}

function localFolders({ workspace = null, userData = null } = {}) {
  // FRIDAY-managed models always live in <FRIDAY_ROOT>\models. Before a root is
  // selected the bootstrap folder stands in for it. The LM Studio and Hugging
  // Face caches belong to those external engines: they are read so already
  // downloaded models are usable, never written to by FRIDAY.
  // The canonical folder contract owns the name (and its legacy alias), so a
  // root created by an older build still resolves without a second store.
  const ownedBase = workspace || userData;
  const owned = ownedBase
    ? (contract.candidates("models") || ["models"]).map((name) =>
        path.join(ownedBase, ...name.split("/")),
      )
    : [];
  const external = [
    path.join(os.homedir(), ".cache", "lm-studio", "models"),
    path.join(os.homedir(), ".cache", "huggingface", "hub"),
  ];
  const roots = [...new Set([...owned, ...external].filter((p) => p && fs.existsSync(p)))];
  const models = roots.flatMap((r) => scanModelFolder(r));
  return { roots, models, externalRoots: external.filter((p) => fs.existsSync(p)) };
}

// ------------------------------------------------------------------ facade
/** One real inventory of everything FRIDAY can run right now. */
async function inventory({ userData = null, workspace = null } = {}) {
  const localIds = Object.keys(LOCAL_ENGINES);
  const [ollama, running, ...rest] = await Promise.all([
    ollamaModels(),
    ollamaRunning(),
    ...localIds.map((id) => localEngine(id, userData)),
    ...Object.keys(CLOUD).map((id) => cloudProvider(id, userData)),
  ]);
  const locals = rest.slice(0, localIds.length);
  const cloud = rest.slice(localIds.length);
  const folders = localFolders({ workspace, userData });

  const providers = [
    {
      id: "ollama",
      name: "Ollama",
      kind: "local",
      endpoint: OLLAMA,
      online: ollama.online,
      latencyMs: ollama.latencyMs,
      error: ollama.error,
      models: ollama.models,
    },
    ...locals,
    {
      id: "local",
      name: "Local files",
      kind: "local",
      endpoint: folders.roots[0] || null,
      online: folders.models.length > 0,
      latencyMs: null,
      error: folders.models.length ? null : "no model files found",
      models: folders.models,
    },
    ...cloud,
  ];

  return {
    at: Date.now(),
    providers,
    running: running.models,
    roots: folders.roots,
    totals: {
      providersOnline: providers.filter((p) => p.online).length,
      models: providers.reduce((n, p) => n + p.models.length, 0),
      localModels: providers
        .filter((p) => p.kind === "local")
        .reduce((n, p) => n + p.models.length, 0),
    },
  };
}

/** Real single-provider health check (used by the Test button). */
async function testProvider(id, { userData = null, apiKey = null } = {}) {
  if (id === "ollama") {
    const r = await ollamaModels();
    return {
      id,
      online: r.online,
      latencyMs: r.latencyMs,
      error: r.error,
      models: r.models.length,
    };
  }
  if (LOCAL_ENGINES[id]) {
    const r = await localEngine(id, userData);
    return {
      id,
      online: r.online,
      latencyMs: r.latencyMs,
      error: r.error,
      models: r.models.length,
    };
  }
  if (CLOUD[id]) {
    // One code path for both cases: a key being tried before it is saved is
    // just an override on the same real check (endpoint overrides, pinned
    // routers, alternate hosts and key verification all still apply).
    const r = await cloudProvider(id, userData, { apiKey });

    return {
      id,
      online: r.online,
      latencyMs: r.latencyMs,
      error: r.error,
      models: r.models.length,
    };
  }
  if (id === "local") {
    const f = localFolders({ userData });
    return {
      id,
      online: f.models.length > 0,
      latencyMs: null,
      error: f.models.length ? null : "no model files found",
      models: f.models.length,
    };
  }
  return { id, online: false, latencyMs: null, error: "unknown provider", models: 0 };
}

function openAiChatUrl(base, chatPath) {
  const trimmed = String(base || "").replace(/\/+$/, "");
  if (chatPath) return trimmed + chatPath;
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (/\/(v\d+[a-z0-9]*|openai|compatibility\/v\d+|paas\/v\d+)$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

/**
 * One streamed token through the same router the chat window uses.
 * A model the router would hide is not called.
 */
async function testProviderChat(
  id,
  {
    userData = null,
    apiKey = null,
    fetchImpl = null,
    policy = "free-preferred",
    modelId = null,
  } = {},
) {
  const cloud = CLOUD[id];
  if (!cloud)
    return { ok: false, id, category: "unknown-provider", detail: "not a cloud provider" };
  const key = apiKey || resolveKey(userData, id);
  if (!key) return { ok: false, id, category: "not-connected", detail: "no API key", usable: 0 };
  const urls = resolveEndpoints(userData, id);
  const started = Date.now();
  const fetcher = fetchImpl || globalThis.fetch;
  let listed = [];
  try {
    const listRes = await fetcher(urls.list || cloud.url, { headers: cloud.headers(key) });
    const body = await listRes.json().catch(() => ({}));
    listed = typeof cloud.list === "function" ? cloud.list(body || {}) : [];
  } catch {
    return {
      ok: false,
      id,
      category: "list",
      detail: "list failed",
      latencyMs: Date.now() - started,
      usable: 0,
    };
  }
  const ids = (modelId ? [modelId] : listed).filter(Boolean).slice(0, 12);
  if (!ids.length) {
    return {
      ok: false,
      id,
      category: "empty",
      detail: "no models listed",
      latencyMs: Date.now() - started,
      usable: 0,
    };
  }
  const pool = ids.map((target) => ({
    id: `${id}:${target}`,
    type: "cloud",
    providerId: id,
    providerModelId: target,
    contextK: 8,
    meta: {
      providerId: id,
      providerName: cloud.name,
      kind: "cloud",
      modelName: target,
      connected: true,
    },
  }));
  const plan = modelRouter.planRoute(pool, { mode: "auto", policy, task: "chat" });
  const winnerId = Array.isArray(plan.candidates) ? plan.candidates[0] : null;
  const winner = pool.find((model) => model.id === winnerId) || null;
  if (!winner) {
    return {
      ok: false,
      id,
      category: plan.rejected[0]?.reason || "not-usable",
      detail: "router would not use a listed model",
      latencyMs: Date.now() - started,
      list: listed.length,
      usable: 0,
    };
  }
  const target = winner.providerModelId || winner.meta?.modelName;
  const url =
    cloud.wire === "anthropic"
      ? `${String(urls.base || "").replace(/\/+$/, "")}/messages`
      : openAiChatUrl(urls.base, cloud.chatPath);
  const headers = { ...cloud.headers(key), "content-type": "application/json" };
  const payload =
    cloud.wire === "anthropic"
      ? { model: target, max_tokens: 1, stream: true, messages: [{ role: "user", content: "Hi" }] }
      : { model: target, max_tokens: 1, stream: true, messages: [{ role: "user", content: "Hi" }] };
  try {
    const res = await fetcher(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    const streamed = text.includes("data:");
    if (!res.ok) {
      const category =
        res.status === 429
          ? "rate_limited"
          : res.status === 401 || res.status === 403
            ? "auth"
            : "http";
      return {
        ok: false,
        id,
        modelId: target,
        display: winner.displayName || `${cloud.name} · ${target}`,
        category,
        detail: `status ${res.status}`,
        latencyMs,
        stream: streamed,
        list: listed.length,
        usable: Array.isArray(plan.candidates) ? plan.candidates.length : 0,
      };
    }
    return {
      ok: true,
      id,
      modelId: target,
      display: winner.displayName || `${cloud.name} · ${target}`,
      category: "ok",
      detail: streamed ? "stream OK" : "chat OK",
      latencyMs,
      stream: streamed,
      list: listed.length,
      usable: Array.isArray(plan.candidates) ? plan.candidates.length : 0,
    };
  } catch {
    return {
      ok: false,
      id,
      modelId: target,
      category: "network",
      detail: "chat failed",
      latencyMs: Date.now() - started,
      list: listed.length,
      usable: Array.isArray(plan.candidates) ? plan.candidates.length : 0,
    };
  }
}

// ------------------------------------------------------- engine processes
// Start/stop the real local engine process. Nothing is faked: when an engine
// has no documented CLI to start it, the caller gets an honest error with the
// official instruction instead of a green light.
const { spawn, execFile } = require("node:child_process");

const ENGINE_CONTROL = {
  ollama: {
    start: ["ollama", ["serve"]],
    stopHint: "Ollama runs as a Windows service — stop it from the tray icon or Services.",
    probe: () => ollamaModels().then((r) => r.online),
  },
  lmstudio: {
    start: ["lms", ["server", "start"]],
    stop: ["lms", ["server", "stop"]],
    probe: () => localEngine("lmstudio").then((r) => r.online),
  },
  llamacpp: {
    stopHint:
      "llama.cpp is started with your own llama-server command line, so FRIDAY does not own the process.",
    probe: () => localEngine("llamacpp").then((r) => r.online),
    // No zero-argument start. A start argv is built only when exactly one GGUF
    // exists in the FRIDAY models folder (see resolveEngineStart).
    modelStart: {
      kind: "gguf",
      bin: "llama-server",
      args: (file) => ["-m", file, "--host", "127.0.0.1", "--port", "8080"],
      timeoutMs: 45000,
      zeroHint:
        "llama.cpp needs a GGUF path (`llama-server -m <file>`). None is in the FRIDAY models folder, so it must be started manually.",
      manyHint: (n) =>
        `llama.cpp needs exactly one GGUF to auto-start; ${n} are present so FRIDAY will not guess. Start llama-server yourself with -m <file>.`,
    },
  },
  vllm: {
    stopHint: "vLLM is started with your own `vllm serve` command line.",
    probe: () => localEngine("vllm").then((r) => r.online),
    modelStart: {
      kind: "safetensors",
      bin: "vllm",
      args: (dir) => ["serve", dir, "--host", "127.0.0.1", "--port", "8000"],
      timeoutMs: 45000,
      zeroHint:
        "vLLM needs `vllm serve <model>` with a Hugging Face / safetensors folder. GGUF files are not a vLLM start path. Start it yourself once you have exactly one such model.",
      manyHint: (n) =>
        `vLLM needs exactly one safetensors model folder to auto-start; ${n} are present so FRIDAY will not guess. Run vllm serve <model> yourself.`,
    },
  },
  localai: {
    start: ["local-ai", ["run", "--address", "127.0.0.1:8081"]],
    stopHint:
      "LocalAI was started with `local-ai run`. Stop that process if FRIDAY did not start it.",
    probe: () => localEngine("localai").then((r) => r.online),
  },
  jan: {
    stopHint:
      "Jan has no zero-argument headless start. Open Jan → Settings → Local API Server → Start Server (127.0.0.1:1337), or run `jan serve <MODEL_ID>` (omitting the model id is interactive).",
    probe: () => localEngine("jan").then((r) => r.online),
  },
};
if (process.platform === "darwin") {
  ENGINE_CONTROL.mlx = {
    stopHint:
      "MLX-LM (`mlx_lm.server`) requires `--model` and only runs on macOS/Apple silicon. FRIDAY will not invent a model path.",
    probe: () => localEngine("mlx").then((r) => r.online),
    modelStart: {
      kind: "safetensors",
      bin: "mlx_lm.server",
      args: (dir) => ["--model", dir, "--host", "127.0.0.1", "--port", "8082"],
      timeoutMs: 45000,
      zeroHint:
        "MLX-LM needs `mlx_lm.server --model <path>`. None is in the FRIDAY models folder, so it must be started manually.",
      manyHint: (n) =>
        `MLX-LM needs exactly one safetensors model folder to auto-start; ${n} are present so FRIDAY will not guess.`,
    },
  };
}

const engineJobs = new Set(); // one start/stop per engine at a time

const runCommand = (cmd, args, timeout = 20000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        output: String(stdout || stderr || "")
          .trim()
          .slice(-2000),
        error: err ? String(err.message) : null,
      });
    });
  });

/** Optional local engines must never be allowed to crash FRIDAY's main process.
 * `spawn()` reports a missing executable asynchronously through `error`, so a
 * try/catch around spawn is not enough on Windows. Probe PATH first and return
 * an ordinary unavailable result instead. */
const commandAvailable = (cmd) =>
  new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    execFile(finder, [cmd], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(!err && Boolean(String(stdout || "").trim()));
    });
  });

async function waitUntil(probe, timeoutMs = 15000, stepMs = 700) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function ownedModelFiles() {
  try {
    const download = require("./model-download.cjs");
    const paths = require("./friday-paths.cjs");
    const root = paths.root() || paths.base();
    if (!root) return [];
    return download.listLocalWeights(path.join(root, "models"));
  } catch {
    return [];
  }
}

/**
 * The real start argv for an engine, or null with the honest reason.
 * llama.cpp / vLLM (and MLX on macOS) get a start command when an explicit
 * selected model resolves exactly, or when only one compatible weight exists.
 */
function resolveEngineStart(id, files, selection = null) {
  const spec = ENGINE_CONTROL[id];
  if (!spec) return { start: null, hint: `unknown engine "${id}"`, timeoutMs: 20000 };
  if (spec.start) {
    return {
      start: spec.start,
      hint: spec.stopHint || null,
      timeoutMs: spec.startTimeoutMs || 20000,
    };
  }
  if (spec.modelStart) {
    const download = require("./model-download.cjs");
    const inventory = Array.isArray(files) ? files : ownedModelFiles();
    const picked =
      spec.modelStart.kind === "gguf"
        ? download.uniqueGgufPaths(inventory)
        : download.uniqueSafetensorDirs(inventory);
    const selected = exactSelectedWeight(id, selection, picked, inventory);
    if (selected || picked.length === 1) {
      const target = selected || picked[0];
      return {
        start: [spec.modelStart.bin, spec.modelStart.args(target)],
        hint: null,
        timeoutMs: spec.modelStart.timeoutMs || 45000,
      };
    }
    if (selection) {
      return {
        start: null,
        hint: `The selected model does not resolve exactly to one ${spec.modelStart.kind} model in the FRIDAY models folder. FRIDAY will not guess.`,
        timeoutMs: 20000,
      };
    }
    if (picked.length === 0) {
      return {
        start: null,
        hint: spec.modelStart.zeroHint || spec.stopHint,
        timeoutMs: 20000,
      };
    }
    const many =
      typeof spec.modelStart.manyHint === "function"
        ? spec.modelStart.manyHint(picked.length)
        : spec.stopHint;
    return { start: null, hint: many, timeoutMs: 20000 };
  }
  return {
    start: null,
    hint: spec.stopHint || "this engine must be started manually",
    timeoutMs: 20000,
  };
}

function exactSelectedWeight(id, selection, candidates, inventory) {
  const raw =
    typeof selection === "string"
      ? selection
      : selection?.modelPath || selection?.path || selection?.modelId || selection?.id || "";
  if (!raw) return null;
  const value = String(raw).trim();
  const withoutProvider = value.startsWith(`${id}:`) ? value.slice(id.length + 1) : value;
  const withoutFile = withoutProvider.startsWith("file:")
    ? withoutProvider.slice(5)
    : withoutProvider;
  const wanted = new Set([value, withoutProvider, withoutFile].filter(Boolean));
  const matches = (candidates || []).filter((candidate) => {
    const names = new Set([
      candidate,
      `file:${candidate}`,
      path.basename(candidate),
      path.basename(candidate, path.extname(candidate)),
    ]);
    if (path.extname(candidate).toLowerCase() !== ".gguf") {
      names.add(path.basename(path.dirname(candidate)));
    }
    for (const file of inventory || []) {
      if (!file?.path) continue;
      const same =
        path.resolve(file.path) === path.resolve(candidate) ||
        path.resolve(path.dirname(file.path)) === path.resolve(candidate);
      if (!same) continue;
      names.add(String(file.id || ""));
      names.add(String(file.name || ""));
    }
    return [...wanted].some((item) => names.has(item));
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Start a local engine for real and only report success once it answers. */
async function startEngine(id, options = {}) {
  const spec = ENGINE_CONTROL[id];
  if (!spec) return { ok: false, id, error: `unknown engine "${id}"` };
  if (await spec.probe()) return { ok: true, id, running: true, detail: "already running" };
  if (engineJobs.has(id)) return { ok: false, id, error: "a start/stop job is already running" };
  const resolved = resolveEngineStart(id, options.files, options.selectedModel || null);
  if (!resolved.start)
    return {
      ok: false,
      id,
      running: false,
      error: resolved.hint || spec.stopHint || "this engine must be started manually",
    };

  engineJobs.add(id);
  try {
    const [cmd, args] = resolved.start;
    if (!(await commandAvailable(cmd))) {
      return {
        ok: false,
        id,
        running: false,
        error: `${cmd} is not installed or is not available on PATH`,
      };
    }
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch (err) {
      return {
        ok: false,
        id,
        running: false,
        error: `${cmd} could not be started — ${String(err.message || err)}`,
      };
    }
    const launched = await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.once("error", (err) => finish({ ok: false, error: String(err.message || err) }));
      child.once("spawn", () => finish({ ok: true }));
    });
    if (!launched.ok) {
      return {
        ok: false,
        id,
        running: false,
        error: `${cmd} could not be started — ${launched.error}`,
      };
    }
    child.unref();
    const up = await waitUntil(spec.probe, resolved.timeoutMs || 20000);
    return up
      ? { ok: true, id, running: true, detail: `${cmd} ${args.join(" ")} is answering` }
      : { ok: false, id, running: false, error: `${cmd} started but the endpoint never answered` };
  } finally {
    engineJobs.delete(id);
  }
}

/** Stop a local engine for real, when the engine exposes a documented stop. */
async function stopEngine(id) {
  const spec = ENGINE_CONTROL[id];
  if (!spec) return { ok: false, id, error: `unknown engine "${id}"` };
  if (!(await spec.probe())) return { ok: true, id, running: false, detail: "already stopped" };
  if (engineJobs.has(id)) return { ok: false, id, error: "a start/stop job is already running" };
  if (!spec.stop)
    return { ok: false, id, running: true, error: spec.stopHint || "no documented stop command" };

  engineJobs.add(id);
  try {
    const [cmd, args] = spec.stop;
    const result = await runCommand(cmd, args);
    const down = await waitUntil(async () => !(await spec.probe()), 12000);
    return down
      ? { ok: true, id, running: false, detail: result.output || `${cmd} ${args.join(" ")}` }
      : { ok: false, id, running: true, error: result.error || "the endpoint is still answering" };
  } finally {
    engineJobs.delete(id);
  }
}

async function engineStatus() {
  const ids = Object.keys(ENGINE_CONTROL);
  const resolved = ids.map((id) => resolveEngineStart(id));
  const [running, available] = await Promise.all([
    Promise.all(ids.map((id) => ENGINE_CONTROL[id].probe().catch(() => false))),
    Promise.all(
      resolved.map((entry) =>
        entry.start ? commandAvailable(entry.start[0]) : Promise.resolve(false),
      ),
    ),
  ]);
  return ids.map((id, i) => ({
    id,
    name: id === "ollama" ? "Ollama" : LOCAL_ENGINES[id]?.name || id,
    running: running[i],
    canStart: Boolean(resolved[i].start) && available[i],
    canStop: Boolean(ENGINE_CONTROL[id].stop),
    hint: running[i]
      ? ENGINE_CONTROL[id].stopHint || null
      : resolved[i].start && !available[i]
        ? `${resolved[i].start[0]} is not installed or is not available on PATH`
        : resolved[i].hint || ENGINE_CONTROL[id].stopHint || null,
  }));
}

// ------------------------------------------------------- routable catalogue
/** Role inference from the real model name — used by capability routing. */
function inferRole(name = "") {
  const n = String(name).toLowerCase();
  if (/embed|bge|e5|nomic/.test(n)) return "embed";
  if (/cod(er|e)|starcoder|devstral|codestral/.test(n)) return "coder";
  if (/(^|[^0-9])([0-3])b|mini|flash|haiku|small|tiny|phi/.test(n)) return "fast";
  if (/research|search|sonar|perplex/.test(n)) return "researcher";
  return "brain";
}

const contextKFor = (name = "") => {
  const n = String(name).toLowerCase();
  if (/1m|gemini-(1\.5|2|3)/.test(n)) return 1000;
  if (/128k|gpt-4|gpt-5|claude|llama-?3\.[12]/.test(n)) return 128;
  if (/32k|qwen|mistral-large/.test(n)) return 32;
  return 8;
};

/**
 * Every model FRIDAY can actually route to right now, ordered best-first:
 * resident local models, then reachable local models, then cloud providers
 * whose key just passed a real API call. A cloud model never appears here
 * without a working key.
 */
async function routable(ctx = {}) {
  const inv = await inventory(ctx);
  const resident = new Set(inv.running.map((m) => m.id));
  const tiers = readAccessTiers(ctx.userData);
  const declarations = readOwnerDeclarations(ctx.userData);
  const out = [];

  for (const provider of inv.providers) {
    if (!provider.online) continue;
    if (provider.id === "local") continue; // raw files need an engine to serve them
    const cloud = CLOUD[provider.id];
    // The owner's custom base URL is a documented streaming surface too, so a
    // provider without a built-in `chat` base is routable once one is set.
    const urls = cloud ? resolveEndpoints(ctx.userData, provider.id) : null;
    if (cloud && !urls?.base) continue;
    const key = cloud ? resolveKey(ctx.userData, provider.id) : null;
    if (cloud && !key) continue;
    // Cost tier the owner picked for this provider (free-only / paid-only).
    const tier = tiers[provider.id] || "auto";

    for (const model of filterByTier(provider.models, cloud ? tier : "auto", provider.id)) {
      const wire = cloud
        ? urls.custom
          ? "online" // custom gateways are OpenAI-compatible
          : cloud.wire
        : provider.id === "ollama"
          ? "ollama"
          : provider.id;
      const endpoint = cloud ? urls.base : provider.endpoint;
      const accessRecord =
        model.accessRecord ||
        modelAccess.classifyModel({
          providerId: provider.id,
          modelId: model.id,
          kind: provider.kind,
          catalogue: model.catalogue || model,
          declaredAccess: cloud && tier !== "auto" ? tier : null,
          ownerDeclaration: {
            providerFreeTier: Boolean(declarations.providers[provider.id]?.ownerFreeTier),
            model:
              declarations.models[`${provider.id}/${model.id}`] === "free" ||
              declarations.models[`${provider.id}/${model.id}`] === "paid"
                ? declarations.models[`${provider.id}/${model.id}`]
                : null,
          },
          customEndpoint: Boolean(urls?.custom),
          endpoint,
        });
      const capabilities = modelCapabilities.resolveCapabilities({
        id: model.id,
        contextK: contextKFor(model.id),
        catalogue: model.catalogue || model,
        meta: {
          modelName: model.id,
          catalogue: model.catalogue || model,
        },
      });
      const registryId = `${provider.id}:${model.id}`;
      const providerModelId = model.id;
      const modelTitle = model.name && model.name !== model.id ? model.name : model.id;
      const displayName = `${provider.name} · ${modelTitle}`;
      const canonicalModelId = `${provider.id}/${model.id}`;
      const now = Date.now();
      const pricing = accessRecord?.pricing || accessRecord?.pricingEvidence || null;
      const entitlement = accessRecord?.entitlement || null;
      const verification = accessRecord?.verification || "UNVERIFIED";
      const lastSeen = now;
      const lastVerified = accessRecord?.lastVerified || 0;

      out.push({
        id: registryId,
        registryId,
        providerId: provider.id,
        providerModelId,
        displayName,
        canonicalModelId,
        endpoint,
        wireProtocol: wire,
        kind: provider.kind,
        type: provider.kind,
        capabilities,
        pricing,
        entitlement,
        health: "unknown",
        verification,
        lastSeen,
        lastVerified,
        label: displayName,
        provider: wire,
        role: inferRole(model.id),
        api_key: key,
        params: model.parameters || "",
        contextK: contextKFor(model.id),
        accessRecord,
        supportsStreaming: capabilities.streaming,
        supportsTools: capabilities.tools,
        supportsVision: capabilities.vision,
        status: "ready",
        options: {
          model: model.id,
          registryId,
          providerId: provider.id,
          providerModelId,
          canonicalModelId,
          wireProtocol: wire,
          kind: provider.kind,
          pricing,
          entitlement,
          verification,
          lastSeen,
          lastVerified,
          access: modelAccess.coarseAccess(accessRecord),
          accessRecord,
          ...(cloud?.chatPath && !urls.custom ? { chat_path: cloud.chatPath } : {}),
        },
        // routing metadata (not sent to the kernel router constructor)
        meta: {
          registryId,
          providerId: provider.id,
          providerName: provider.name,
          providerModelId,
          displayName,
          canonicalModelId,
          wireProtocol: wire,
          kind: provider.kind,
          modelName: model.id,
          endpoint,
          customEndpoint: Boolean(urls?.custom),
          resident: provider.id === "ollama" && resident.has(model.id),
          sizeGb: model.sizeGb ?? 0,
          accessTier: cloud ? tier : "auto",
          declaredAccess: cloud && tier !== "auto" ? tier : null,
          accessRecord,
          capabilities,
          catalogue: model.catalogue || null,
          pricing,
          entitlement,
          verification,
          lastSeen,
          lastVerified,
        },
      });
    }
  }

  const rank = (m) => (m.meta.resident ? 0 : m.meta.kind === "local" ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  return publishCatalogue({ at: Date.now(), models: out });
}

let lastGoodCatalogue = { at: 0, models: [] };

/** Swap in a validated catalogue. A broken refresh keeps the previous generation. */
function publishCatalogue(next) {
  const committed = modelRouter.commitCatalogue(lastGoodCatalogue.models, next.models);
  if (!committed.ok) {
    return { at: lastGoodCatalogue.at, models: lastGoodCatalogue.models, keptPrevious: true };
  }
  lastGoodCatalogue = { at: next.at, models: committed.snapshot };
  return { at: lastGoodCatalogue.at, models: lastGoodCatalogue.models, keptPrevious: false };
}

const ROLE_BY_TASK = {
  chat: "brain",
  reasoning: "brain",
  code: "coder",
  fast: "fast",
  research: "researcher",
  embed: "embed",
};

/**
 * Auto mode: the best AVAILABLE model for a task, then honest fallbacks.
 * Returns [] when nothing qualifies so the caller can say so plainly.
 */
function selectForTask(models, task = "chat", preferred = []) {
  const wanted = ROLE_BY_TASK[task] || "brain";
  const byId = new Map(models.map((m) => [m.id, m]));
  // Catalogue ids ("qwen2.5-32b") rarely equal engine tags ("qwen2.5:32b"),
  // so match loosely on the normalised name before giving up on a preference.
  const norm = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const explicit = preferred
    .map((id) => {
      const direct = byId.get(id) || models.find((m) => m.meta.modelName === id);
      if (direct) return direct;
      const key = norm(id);
      if (!key) return null;
      return (
        models.find((m) => norm(m.meta.modelName) === key) ||
        models.find(
          (m) => norm(m.meta.modelName).startsWith(key) || key.startsWith(norm(m.meta.modelName)),
        ) ||
        null
      );
    })
    .filter((m, index, list) => m && list.indexOf(m) === index);

  const matching = models.filter((m) => m.role === wanted && !explicit.includes(m));
  const rest = models.filter(
    (m) => m.role !== wanted && !explicit.includes(m) && m.role !== "embed",
  );
  return [...explicit, ...matching, ...rest];
}

function coerceChatText(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return item.text || item.content || "";
        return "";
      })
      .join("");
  }
  return String(raw);
}

/** Real generation probe for any routable model — used by Health check. */
function parseOpenAiSse(text) {
  let content = "";
  let sawDone = false;
  let sawTool = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.replace(/^data:\s?/, "").trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      sawDone = true;
      continue;
    }
    try {
      const frame = JSON.parse(payload);
      const choice = (frame.choices || [])[0] || {};
      const delta = choice.delta || {};
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) sawTool = true;
      content += coerceChatText(
        delta.content ||
          delta.text ||
          choice.text ||
          (choice.message && choice.message.content) ||
          frame.text,
      );
    } catch {
      /* keep scanning */
    }
  }
  return { content: String(content || "").trim(), sawDone, sawTool };
}

function extractChatText(res, provider) {
  if (!res) return "";
  if (provider === "anthropic") {
    return String(res.body?.content?.[0]?.text || "").trim();
  }
  const sse = parseOpenAiSse(res.text);
  if (sse.content) return sse.content;
  return String(
    coerceChatText(res.body?.choices?.[0]?.message?.content) ||
      coerceChatText(res.body?.choices?.[0]?.text) ||
      coerceChatText(res.body?.content?.[0]?.text) ||
      "",
  ).trim();
}

function probeResult(res, provider, extra = {}) {
  const headers = res?.headers || {};
  const status = res?.status || 0;
  if (!res?.ok) {
    return {
      ok: false,
      error: describeFailure(res),
      status,
      headers,
      latencyMs: res?.latencyMs ?? null,
      ...extra,
    };
  }
  const response = extractChatText(res, provider);
  if (!response && !extra.allowEmpty) {
    return {
      ok: false,
      error: "empty model response",
      status,
      headers,
      latencyMs: res?.latencyMs ?? null,
      response: "",
      ...extra,
    };
  }
  return {
    ok: true,
    latencyMs: res.latencyMs,
    response,
    status,
    headers,
    ...extra,
  };
}

async function probeModel(spec, prompt = "Reply with the single word: ok.") {
  if (!spec) return { ok: false, error: "unknown model", status: 0, headers: {} };
  if (spec.provider === "ollama") {
    const result = await ollamaProbeRun(spec.options.model, prompt);
    return { headers: {}, status: result.ok ? 200 : 0, ...result };
  }
  const base = String(spec.endpoint || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "no endpoint", status: 0, headers: {} };
  if (spec.provider === "anthropic") {
    const res = await request(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": spec.api_key || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: spec.options.model,
        max_tokens: 8,
        messages: [{ role: "user", content: prompt }],
      }),
      timeout: 30000,
    });
    return probeResult(res, "anthropic");
  }
  const url = openaiChatUrl(base, spec.options?.chat_path);
  const cloudSpec = spec.meta?.providerId ? CLOUD[spec.meta.providerId] : null;
  const authHeaders =
    cloudSpec && spec.api_key
      ? chatHeaders(cloudSpec, spec.api_key)
      : spec.api_key
        ? { Authorization: `Bearer ${spec.api_key}` }
        : {};
  const payload = {
    model: spec.options.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 8,
  };
  const streamed = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ ...payload, stream: true }),
    timeout: 30000,
  });
  const streamText = extractChatText(streamed, spec.provider);
  if (streamed.ok && streamText) {
    return probeResult(streamed, spec.provider, { streamed: true });
  }
  const res = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(payload),
    timeout: 30000,
  });
  return probeResult(res, spec.provider, {
    streamed: false,
    streamError: streamed.ok
      ? "stream returned no usable assistant text"
      : describeFailure(streamed),
  });
}

const PROBE_TTL_MS = 30 * 60 * 1000;
const probeCache = new Map();

function probeCacheKey(providerId, modelId, key = "", accessScope = "auto") {
  const secretHash = key
    ? require("node:crypto").createHash("sha256").update(String(key)).digest("hex").slice(0, 16)
    : "no-key";
  return `${providerId}:${modelId}:${secretHash}:${accessScope || "auto"}`;
}

function cachedProbeRecord(providerId, modelId, key = "", accessScope = "auto") {
  const cached = probeCache.get(probeCacheKey(providerId, modelId, key, accessScope));
  if (!cached || Date.now() - cached.at >= PROBE_TTL_MS) return null;
  return cached.record || null;
}

function stampProbe(spec, record, result) {
  spec.meta = spec.meta || {};
  spec.options = spec.options || {};
  spec.meta.accessRecord = record;
  spec.meta.probe = result
    ? {
        ok: result.ok,
        status: result.status || 0,
        error: result.error || null,
        streamed: Boolean(result.streamed),
      }
    : spec.meta.probe;
  spec.options.accessRecord = record;
  spec.options.access = modelAccess.coarseAccess(record);
  spec.accessRecord = record;
  spec.access = modelAccess.coarseAccess(record);
}

async function probeAndStamp(spec) {
  if (!spec || spec.meta?.kind === "local" || spec.type === "local") return spec;
  const current = spec.meta?.accessRecord || spec.options?.accessRecord || spec.accessRecord;
  if (current?.verification === "VERIFIED") {
    const expires = Number(current.evidence?.expiresAt || 0);
    if (!expires || expires > Date.now()) return spec;
  }
  const cacheKey = probeCacheKey(
    spec.meta?.providerId || spec.provider,
    spec.meta?.modelName || spec.options?.model || spec.id,
    spec.api_key || "",
    spec.meta?.declaredAccess || "auto",
  );
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
    stampProbe(spec, cached.record, null);
    return spec;
  }
  const result = await probeModel(spec);
  const record = modelAccess.applyProbe(current, result);
  stampProbe(spec, record, result);
  probeCache.set(cacheKey, { at: Date.now(), record });
  return spec;
}

/**
 * Lazy live verification: classify from official evidence, then probe only the
 * highest-ranked free candidates the router is about to use. No global 3-model
 * discovery cap. Successful probes stay cached; the next candidate is probed
 * only when needed.
 */
async function lazyVerifyForRoute(models, options = {}) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return list;
  const {
    task = "chat",
    preferred = [],
    policy = "free-preferred",
    mode = "auto",
    offline = false,
    health = null,
    limit = 4,
    requirements = {},
    qualityTarget = null,
  } = options;
  if (offline) return list;
  const usage = modelRouter.normalisePolicy(policy);
  if (usage === "paid-only") return list;
  if (requirements?.privacy === "private" || qualityTarget === "private") return list;

  const ordered = modelRouter.selectVerificationCandidates(list, {
    task,
    preferred,
    policy: usage,
    mode,
    offline,
    health,
    requirements,
    qualityTarget,
  });

  let verified = 0;
  const want = Math.max(1, Number(limit) || 4);
  const needed = [];
  for (const spec of ordered) {
    if (verified + needed.length >= want) break;
    const current = spec.meta?.accessRecord || spec.options?.accessRecord;
    if (
      modelAccess.isVerifiedFree(current) ||
      modelAccess.effectiveStatus(current) === "FREE_RATE_LIMITED"
    ) {
      verified += 1;
    } else {
      needed.push(spec);
    }
  }
  if (needed.length) {
    await Promise.all(needed.map((spec) => probeAndStamp(spec)));
  }
  return list;
}

/** @deprecated numeric limit was a global 3-model cap — ignored. */
async function verifyRoutableFree(models, options = {}) {
  const opts = typeof options === "number" ? {} : options || {};
  return lazyVerifyForRoute(models, opts);
}

/* ------------------------------------------------------- online discovery */
/**
 * Real model discovery from official indexes.
 *  - Hugging Face public API (GGUF + safetensors repos, includes NVIDIA
 *    Nemotron and everything newly released).
 *  - The local Ollama library tags for anything already pullable.
 * Results are cached on disk so the list still works offline.
 */
let discoveryCache = { at: 0, query: "", items: [] };

function discoveryFile(root) {
  // Canonical: <FRIDAY_ROOT>\cache\model-discovery.json. No root, no disk cache.
  return root ? path.join(root, "cache", "model-discovery.json") : null;
}

function readDiscoveryCache(userData) {
  const source = discoveryFile(userData);
  if (!source) return { at: 0, query: "", items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
    if (Array.isArray(parsed.items)) return parsed;
  } catch {
    /* no cache yet */
  }
  return { at: 0, query: "", items: [] };
}

function writeDiscoveryCache(userData, payload) {
  const target = discoveryFile(userData);
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload), "utf8");
  } catch {
    /* cache is best-effort */
  }
}

function hfToSpec(m) {
  const id = String(m.modelId || m.id || "");
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const gguf = tags.includes("gguf");
  const vendor = id.split("/")[0] || "community";
  const name = id.split("/").slice(1).join("/") || id;
  const paramsHit = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(name);
  const category = /embed/i.test(name)
    ? "Embedding"
    : /whisper|speech|stt/i.test(name)
      ? "Speech to Text"
      : /vision|vl|llava/i.test(name)
        ? "Vision"
        : /coder|code/i.test(name)
          ? "Coding"
          : "Chat";
  return {
    id: `hf:${id}`,
    name,
    vendor,
    provider: gguf ? "ollama" : "transformers",
    kind: "local",
    category,
    format: gguf ? "GGUF" : "Safetensors",
    params: paramsHit ? `${paramsHit[1]}B` : "—",
    downloads: Number(m.downloads || 0),
    likes: Number(m.likes || 0),
    updatedAt: m.lastModified || null,
    url: `https://huggingface.co/${id}`,
    pullRef: gguf ? null : id,
    source: "huggingface.co",
    // Real, resolvable download routes for this repo — never a dead button.
    sources: gguf
      ? [
          {
            kind: "hf-gguf",
            repo: id,
            match: ["Q4_K_M", "Q4_K_S", "Q5_K_M", "Q8_0"],
            label: `Hugging Face · ${id}`,
          },
        ]
      : [{ kind: "hf-repo", repo: id, label: `Hugging Face · ${id}` }],
  };
}

async function searchOnlineModels(
  query = "",
  { userData = null, limit = 40, sort = "downloads" } = {},
) {
  const q = `${String(query || "").trim()}|${sort}`;
  const fresh = Date.now() - discoveryCache.at < 5 * 60_000 && discoveryCache.query === q;
  if (fresh && discoveryCache.items.length)
    return { at: discoveryCache.at, items: discoveryCache.items, cached: true };

  const params = new URLSearchParams({
    limit: String(limit),
    sort: sort === "latest" ? "lastModified" : "downloads",
    direction: "-1",
    full: "false",
  });
  const search = String(query || "").trim();
  if (search) params.set("search", search);
  else params.set("filter", "gguf");

  const res = await request(`https://huggingface.co/api/models?${params.toString()}`, {
    timeout: 12_000,
  });
  let items = [];
  if (res.ok && Array.isArray(res.body)) items = res.body.map(hfToSpec);

  // Anything the local Ollama daemon already knows about is pullable directly.
  try {
    const local = await ollamaModels();
    const localItems = (local || []).map((m) => ({
      id: `ollama:${m.name}`,
      name: m.name,
      vendor: "ollama",
      provider: "ollama",
      kind: "local",
      category: "Chat",
      format: "GGUF",
      params: m.details?.parameter_size || "—",
      downloads: 0,
      likes: 0,
      updatedAt: m.modified_at || null,
      url: `https://ollama.com/library/${String(m.name).split(":")[0]}`,
      pullRef: m.name,
      source: "ollama.com",
      sources: [{ kind: "ollama", ref: m.name, label: `Ollama registry · ${m.name}` }],
      installedLocally: true,
    }));
    const seen = new Set(items.map((i) => i.name.toLowerCase()));
    items = [...localItems.filter((i) => !seen.has(i.name.toLowerCase())), ...items];
  } catch {
    /* Ollama not running — HF results still stand */
  }

  if (items.length === 0) {
    const cached = readDiscoveryCache(userData);
    if (cached.items.length)
      return { at: cached.at, items: cached.items, cached: true, offline: true };
    return {
      at: Date.now(),
      items: [],
      cached: false,
      error: res.error || "discovery unavailable",
    };
  }

  discoveryCache = { at: Date.now(), query: q, items };
  writeDiscoveryCache(userData, discoveryCache);
  return { at: discoveryCache.at, items, cached: false };
}

/**
 * AI-assisted catalogue refresh.
 *
 * When the user has configured a cloud provider key, FRIDAY asks that model
 * which local models are current right now and where they live, then verifies
 * every suggestion against the real Hugging Face API before offering it. A
 * suggestion that cannot be resolved to a downloadable repo is dropped, so the
 * list never contains a model that cannot actually be installed.
 */
async function aiModelSuggestions({ userData = null, system = null, query = "" } = {}) {
  const order = ["openai", "groq", "openrouter", "deepseek", "mistral", "together", "xai"];
  let picked = null;
  for (const id of order) {
    const key = resolveKey(userData, id);
    if (key && CLOUD[id]?.chat) {
      picked = { id, key, cfg: CLOUD[id] };
      break;
    }
  }
  if (!picked)
    return {
      ok: false,
      items: [],
      error: "add a cloud provider API key to let FRIDAY refresh the catalogue with AI",
    };

  const profile = system
    ? `The PC has ${system.vramGb || 0} GB VRAM, ${system.ramGb || 0} GB RAM, GPU ${system.gpu || "unknown"}.`
    : "";
  const prompt = [
    "List the strongest currently-released open-weight local LLMs that can be downloaded today.",
    profile,
    query ? `Focus on: ${query}.` : "",
    'Reply with JSON only: {"models":[{"name":"","huggingfaceRepo":"owner/repo","ollamaTag":"","params":"","use":""}]}.',
    "huggingfaceRepo must be a real GGUF repository. Maximum 12 entries.",
  ]
    .filter(Boolean)
    .join(" ");

  const model =
    picked.id === "openai"
      ? "gpt-4o-mini"
      : picked.id === "groq"
        ? "llama-3.3-70b-versatile"
        : picked.id === "deepseek"
          ? "deepseek-chat"
          : picked.id === "mistral"
            ? "mistral-small-latest"
            : picked.id === "xai"
              ? "grok-2-latest"
              : "openai/gpt-4o-mini";

  const res = await request(`${picked.cfg.chat}/chat/completions`, {
    method: "POST",
    timeout: 30_000,
    headers: { "content-type": "application/json", ...chatHeaders(picked.cfg, picked.key) },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok)
    return { ok: false, items: [], error: res.error || `${picked.id} returned HTTP ${res.status}` };

  let parsed = null;
  try {
    parsed = JSON.parse(res.body?.choices?.[0]?.message?.content || "{}");
  } catch {
    parsed = null;
  }
  const raw = Array.isArray(parsed?.models) ? parsed.models.slice(0, 12) : [];
  if (!raw.length)
    return { ok: false, items: [], error: "the model returned no usable suggestions" };

  const download = require("./model-download.cjs");
  const items = [];
  for (const entry of raw) {
    const repo = String(entry.huggingfaceRepo || "").trim();
    if (!repo.includes("/")) continue;
    const listing = await download.hfFiles(repo);
    if (!listing.ok) continue; // unverifiable → not offered
    const file = download.pickGguf(listing.files, ["Q4_K_M", "Q5_K_M", "Q8_0"]);
    const sources = [];
    if (entry.ollamaTag)
      sources.push({
        kind: "ollama",
        ref: String(entry.ollamaTag),
        label: `Ollama registry · ${entry.ollamaTag}`,
      });
    sources.push(
      file
        ? {
            kind: "hf-gguf",
            repo,
            match: ["Q4_K_M", "Q5_K_M", "Q8_0"],
            label: `Hugging Face · ${repo}`,
          }
        : { kind: "hf-repo", repo, label: `Hugging Face · ${repo}` },
    );
    items.push({
      id: `ai:${repo}`,
      name: String(entry.name || repo.split("/").pop()),
      vendor: repo.split("/")[0],
      provider: file ? "ollama" : "transformers",
      kind: "local",
      category: /coder|code/i.test(entry.use || entry.name || "") ? "Coding" : "Chat",
      format: file ? "GGUF" : "Safetensors",
      params: String(entry.params || "—"),
      downloads: 0,
      likes: 0,
      updatedAt: null,
      url: `https://huggingface.co/${repo}`,
      pullRef: entry.ollamaTag || null,
      source: `AI suggestion · verified on huggingface.co`,
      note: String(entry.use || ""),
      sources,
    });
  }
  return {
    ok: items.length > 0,
    items,
    via: picked.id,
    error: items.length ? null : "no suggestion could be verified",
  };
}

module.exports = {
  OLLAMA,
  chatHeaders,
  providerMessage,
  describeFailure,
  migrateCredentials,
  searchOnlineModels,
  aiModelSuggestions,
  CLOUD,
  LOCAL_ENGINES,
  localEndpointCandidates,
  openaiChatUrl,
  inventory,
  testProvider,
  ollamaModels,
  ollamaShow,
  ollamaPull,
  ollamaDelete,
  ollamaProbeRun,
  ollamaUnload,
  ollamaRunning,
  localFolders,
  readKeys,
  writeKey,
  readEndpoints,
  writeEndpoint,
  resolveEndpoints,
  invalidateProviderCache,
  ACCESS_TIERS,
  looksFree,
  filterByTier,
  readAccessTiers,
  writeAccessTier,
  readOwnerDeclarations,
  writeOwnerDeclaration,
  testProviderChat,
  openAiChatUrl,
  startEngine,
  stopEngine,
  engineStatus,
  resolveEngineStart,
  ENGINE_CONTROL,
  routable,
  selectForTask,
  probeModel,
  probeAndStamp,
  lazyVerifyForRoute,
  verifyRoutableFree,
  parseOpenAiSse,
  extractChatText,
  inferRole,
};
