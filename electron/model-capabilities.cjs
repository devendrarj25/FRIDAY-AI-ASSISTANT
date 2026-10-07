/**
 * FRIDAY · authoritative model capability registry.
 *
 * Routing decisions (vision task, tool calling, long context, embeddings)
 * must not rest on guessing from a model's name. This module resolves a
 * capability record in a fixed order of trust:
 *
 *   1. DECLARED BY THE SOURCE — whatever the provider/engine or the owner
 *      attached to the model (`meta.capabilities`, Ollama `families`, Hugging
 *      Face `pipeline_tag`/`tags`). Real metadata, so it wins.
 *   2. THE CURATED REGISTRY — hand-maintained records for the model families
 *      FRIDAY ships support for. Explicit data, reviewed, versioned here.
 *   3. HEURISTICS — the old name-pattern guess, used only when nothing above
 *      knows the model. Always reported as such so the UI can say "inferred".
 *
 * Every record carries `source` so the Models page can show where a capability
 * claim came from instead of pretending all of them are equally certain.
 *
 * Pure logic (no I/O) so it is unit-testable and safe to import anywhere.
 */

/** The capability keys FRIDAY routes on. */
const CAPABILITY_KEYS = [
  "chat",
  "streaming",
  "vision",
  "tools",
  "embeddings",
  "coding",
  "reasoning",
  "audio",
  "research",
  "longContext",
];

const BASE = {
  chat: true,
  streaming: true,
  vision: false,
  tools: true,
  embeddings: false,
  coding: false,
  reasoning: false,
  audio: false,
  research: false,
  longContext: false,
};

/**
 * Curated records. `match` is tested against the normalised model name.
 * Keep entries narrow and factual — this table is the reviewed truth.
 */
const REGISTRY = [
  // ---------------------------------------------------------------- OpenAI
  {
    id: "openai-o-series",
    match: /^(o[134])(-|$)|^gpt-5/,
    caps: { vision: true, tools: true, reasoning: true, coding: true, longContext: true },
  },
  {
    id: "openai-gpt-4o",
    match: /gpt-4o|gpt-4\.1|omni/,
    caps: { vision: true, tools: true, coding: true, longContext: true },
  },
  { id: "openai-gpt-4", match: /^gpt-4(?!o)/, caps: { tools: true, coding: true } },
  { id: "openai-gpt-3", match: /^gpt-3\.5/, caps: { tools: true } },
  {
    id: "openai-embeddings",
    match: /text-embedding|^embed/,
    caps: { chat: false, tools: false, embeddings: true, streaming: false },
  },
  {
    id: "openai-audio",
    match: /whisper|tts-1|gpt-4o-(mini-)?(tts|transcribe)|realtime|orpheus/,
    caps: { chat: false, tools: false, audio: true, streaming: false },
  },
  {
    id: "prompt-guard",
    match: /prompt-guard/,
    caps: { chat: false, tools: false, streaming: false },
  },
  // ------------------------------------------------------------- Anthropic
  {
    id: "anthropic-claude",
    match: /claude/,
    caps: { vision: true, tools: true, coding: true, reasoning: true, longContext: true },
  },
  // ---------------------------------------------------------------- Google
  {
    id: "google-gemini",
    match: /gemini/,
    caps: { vision: true, tools: true, coding: true, reasoning: true, longContext: true },
  },
  { id: "google-gemma", match: /gemma/, caps: { tools: true, coding: true } },
  // ----------------------------------------------------------------- Meta
  { id: "meta-llama-vision", match: /llama.*(vision|-vl)/, caps: { vision: true, tools: true } },
  { id: "meta-codellama", match: /codellama|llama.*code/, caps: { tools: true, coding: true } },
  { id: "meta-llama", match: /llama/, caps: { tools: true } },
  // ------------------------------------------------------------- DeepSeek
  {
    id: "deepseek-reasoner",
    match: /deepseek-(r1|reasoner)|^r1(-|$)/,
    caps: { reasoning: true, coding: true, tools: false, longContext: true },
  },
  { id: "deepseek-coder", match: /deepseek.*cod/, caps: { coding: true, tools: true } },
  { id: "deepseek", match: /deepseek/, caps: { coding: true, tools: true, reasoning: true } },
  // ----------------------------------------------------------------- Qwen
  { id: "qwen-vl", match: /qwen.*(vl|vision)/, caps: { vision: true, tools: true } },
  { id: "qwen-coder", match: /qwen.*cod/, caps: { coding: true, tools: true } },
  { id: "qwq", match: /qwq|qwen.*think/, caps: { reasoning: true, tools: true } },
  { id: "qwen", match: /qwen/, caps: { tools: true, coding: true, longContext: true } },
  // -------------------------------------------------------------- Mistral
  { id: "pixtral", match: /pixtral/, caps: { vision: true, tools: true } },
  {
    id: "non-chat-safety",
    match: /moderation|moderator|prompt-guard|safeguard|content-safety/,
    caps: { chat: false, tools: false, streaming: false },
  },
  {
    id: "mistral",
    match: /mistral|mixtral|devstral|codestral/,
    caps: { tools: true, coding: true },
  },
  // ---------------------------------------------------------------- Other
  {
    id: "llava",
    match: /llava|moondream|bakllava|minicpm-v/,
    caps: { vision: true, tools: false },
  },
  { id: "phi", match: /phi-?[34]/, caps: { tools: true, coding: true, reasoning: true } },
  { id: "starcoder", match: /starcoder|granite-code|codegemma/, caps: { coding: true } },
  {
    id: "research",
    match: /research|search|sonar|perplex/,
    caps: { research: true, tools: true, longContext: true },
  },
  {
    id: "embeddings",
    match: /bge|e5-|gte-|nomic-embed|all-minilm|mxbai-embed|rerank/,
    caps: { chat: false, tools: false, streaming: false, embeddings: true },
  },
  {
    id: "audio",
    match:
      /whisper|piper|xtts|bark|parler|orpheus|kokoro|silero|supertonic|moonshine|smart-turn|rnnoise/,
    caps: { chat: false, tools: false, audio: true },
  },
];

function normaliseName(model) {
  return String(model?.meta?.modelName || model?.options?.model || model?.id || "")
    .toLowerCase()
    .trim();
}

/** Capabilities the provider or engine itself declared, if any. */
function declaredCapabilities(model) {
  const out = {};
  const catalogue = model?.meta?.catalogue || model?.catalogue || {};
  const raw = model?.meta?.capabilities || model?.capabilities || catalogue?.capabilities;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of CAPABILITY_KEYS) {
      if (typeof raw[key] === "boolean") out[key] = raw[key];
    }
  }
  const declaredNames = []
    .concat(
      Array.isArray(raw) ? raw : [],
      catalogue?.supported_capabilities || [],
      catalogue?.supported_parameters || [],
      catalogue?.features || [],
    )
    .map((item) => String(item || "").toLowerCase());
  if (declaredNames.some((item) => /tool|function/.test(item))) out.tools = true;
  if (declaredNames.some((item) => /vision|image/.test(item))) out.vision = true;
  if (declaredNames.some((item) => /reason/.test(item))) out.reasoning = true;
  if (declaredNames.some((item) => /embed/.test(item))) out.embeddings = true;
  if (declaredNames.some((item) => /audio|speech/.test(item))) out.audio = true;
  if (declaredNames.some((item) => /stream/.test(item))) out.streaming = true;
  const routeType = String(
    catalogue?.type || catalogue?.task || catalogue?.pipeline_tag || catalogue?.pipelineTag || "",
  ).toLowerCase();
  if (/embedding|rerank|moderation|classification|guard|image|audio|speech/.test(routeType)) {
    out.chat = false;
    out.tools = false;
  } else if (/chat|language|text-generation|conversational|code/.test(routeType)) {
    out.chat = true;
  }
  if (/embedding|feature-extraction|sentence-similarity/.test(routeType)) out.embeddings = true;
  if (/audio|speech|automatic-speech-recognition|text-to-speech/.test(routeType)) out.audio = true;
  const endpoints = Array.isArray(catalogue?.endpoints)
    ? catalogue.endpoints.map((item) => String(item || "").toLowerCase())
    : [];
  if (endpoints.length && !endpoints.some((item) => /chat|generate/.test(item))) {
    out.chat = false;
    out.tools = false;
  }
  // Ollama `/api/show` reports model families; a "clip"/"mllama" family means
  // the weights really do carry a vision tower.
  const families = []
    .concat(
      model?.meta?.families || [],
      model?.meta?.family || [],
      catalogue?.families || [],
      catalogue?.family || [],
    )
    .map((f) => String(f).toLowerCase());
  if (families.some((f) => /clip|mllama|vision|llava/.test(f))) out.vision = true;
  if (families.some((f) => /bert|embed/.test(f))) {
    out.embeddings = true;
    out.chat = false;
  }
  // Hugging Face metadata.
  const pipeline = String(
    model?.meta?.pipelineTag ||
      model?.meta?.pipeline_tag ||
      catalogue?.pipelineTag ||
      catalogue?.pipeline_tag ||
      "",
  ).toLowerCase();
  if (pipeline) {
    if (pipeline.includes("feature-extraction") || pipeline.includes("sentence-similarity")) {
      out.embeddings = true;
      out.chat = false;
    }
    if (pipeline.includes("image-text-to-text") || pipeline.includes("visual-question"))
      out.vision = true;
    if (pipeline.includes("automatic-speech-recognition") || pipeline.includes("text-to-speech")) {
      out.audio = true;
      out.chat = false;
    }
  }
  return out;
}

/** The registry record for a model name, or null when nothing matches. */
function registryEntry(name) {
  if (!name) return null;
  return REGISTRY.find((entry) => entry.match.test(name)) || null;
}

/** Last resort: the historical name-pattern guess. */
function inferredCapabilities(name) {
  return {
    vision: /vision|llava|-vl|multimodal|omni|pixtral/.test(name),
    tools: !/embed|whisper|tts|bge|rerank/.test(name),
    embeddings: /embed|bge|e5-|gte-/.test(name),
    coding: /cod(er|e)|starcoder|devstral/.test(name),
    reasoning: /(^|[-_])r1($|[-_])|reason|think|qwq/.test(name),
    audio:
      /whisper|tts|piper|xtts|bark|orpheus|kokoro|silero|supertonic|moonshine|smart-turn|rnnoise/.test(
        name,
      ),
    research: /research|search|sonar|perplex/.test(name),
  };
}

/**
 * Resolve one model's capabilities.
 * @returns {{chat:boolean,streaming:boolean,vision:boolean,tools:boolean,
 *   embeddings:boolean,coding:boolean,reasoning:boolean,audio:boolean,
 *   research:boolean,longContext:boolean,source:string,registryId:string|null,
 *   sources:Record<string,string>}}
 */
function resolveCapabilities(model) {
  const name = normaliseName(model);
  const contextK = Number(model?.contextK || model?.context_k || model?.meta?.contextK || 0);
  const entry = registryEntry(name);
  const declared = declaredCapabilities(model);
  const inferred = inferredCapabilities(name);

  const caps = { ...BASE };
  const sources = {};
  for (const key of CAPABILITY_KEYS) {
    if (key === "longContext") continue;
    if (key in declared) {
      caps[key] = declared[key];
      sources[key] = "declared";
    } else if (entry && key in entry.caps) {
      caps[key] = Boolean(entry.caps[key]);
      sources[key] = "registry";
    } else if (key in inferred) {
      caps[key] = inferred[key];
      sources[key] = entry ? "registry-default" : "inferred";
    } else {
      sources[key] = "default";
    }
  }
  // Context length is a measured number, never a guess.
  caps.longContext = contextK >= 64;
  sources.longContext = contextK ? "measured" : "default";
  // An embedding or audio model cannot chat or call tools, whatever else said.
  if (caps.embeddings || caps.audio) {
    caps.chat = false;
    caps.tools = false;
  }

  const source = Object.keys(declared).length ? "declared" : entry ? "registry" : "inferred";
  return { ...caps, contextK, source, registryId: entry ? entry.id : null, sources };
}

/**
 * Normalized quality profile for a model (0.0 to 1.0 scale).
 * Based on verified declarations, benchmark metadata, and runtime telemetry.
 * If no evidence exists, uses neutral score (0.5), so speculative scores never dominate.
 */
function resolveQualityProfile(model, capabilities = null, telemetry = {}) {
  const caps = capabilities || resolveCapabilities(model);
  const name = normaliseName(model);
  const contextK = Number(caps.contextK || model?.contextK || 0);

  const profile = {
    reasoningScore: 0.5,
    codingScore: 0.5,
    chatScore: caps.chat ? 0.7 : 0.0,
    visionScore: caps.vision ? 0.8 : 0.0,
    toolScore: caps.tools ? 0.75 : 0.0,
    structuredOutputScore: caps.tools ? 0.7 : 0.5,
    speedScore: 0.5,
    contextScore: Math.min(1.0, Math.max(0.1, (contextK || 8) / 128)),
    reliabilityScore: 0.5,
  };

  if (/^(o[134])(-|$)|^gpt-5|r1|reasoner|qwq/i.test(name)) {
    profile.reasoningScore = 0.95;
    profile.codingScore = Math.max(profile.codingScore, 0.9);
  } else if (caps.reasoning) {
    profile.reasoningScore = 0.8;
  }

  if (/cod(er|e)|starcoder|devstral/i.test(name)) {
    profile.codingScore = 0.95;
  } else if (caps.coding) {
    profile.codingScore = 0.8;
  }

  if (/mini|flash|small|fast|turbo|8b|7b/i.test(name)) {
    profile.speedScore = 0.85;
  }

  if (telemetry.latencyMs && telemetry.latencyMs > 0) {
    profile.speedScore = Math.max(0.1, Math.min(1.0, 1.0 - telemetry.latencyMs / 4000));
  }
  if (telemetry.failures !== undefined) {
    const fails = Number(telemetry.failures || 0);
    profile.reliabilityScore = Math.max(0.1, Math.min(1.0, 1.0 - fails * 0.2));
  }

  if (model?.qualityProfile && typeof model.qualityProfile === "object") {
    return { ...profile, ...model.qualityProfile };
  }

  return profile;
}

module.exports = {
  CAPABILITY_KEYS,
  REGISTRY,
  resolveCapabilities,
  resolveQualityProfile,
  registryEntry,
  normaliseName,
};
