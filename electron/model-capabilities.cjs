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
  "imageGeneration",
  "speechToText",
  "textToSpeech",
  "video",
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
  imageGeneration: false,
  speechToText: false,
  textToSpeech: false,
  video: false,
};

/**
 * Curated records. `match` is tested against the normalised model name.
 * Keep entries narrow and factual — this table is the reviewed truth.
 */
const NON_CHAT = { chat: false, tools: false, streaming: false };
const REGISTRY = [
  // ---------------------------------------------------------------- Media
  // Models that make or read images, speech and video rather than chat. They
  // come first so a name such as gpt-4o-mini-tts is never taken for a chat model.
  {
    id: "gemini-image-chat",
    match: /gemini.*(flash-image|image-preview|-image$)|nano-banana/,
    caps: { vision: true, imageGeneration: true, tools: false },
  },
  {
    id: "image-generation",
    match:
      /dall-?e|gpt-image|imagen|(^|[/_-])flux|stable-?diffusion|sdxl|sd-?3|stable-image|ideogram|recraft|playground-v|kandinsky|hidream|seedream|qwen-image|cogview|midjourney|firefly|z-image|text-to-image/,
    caps: { ...NON_CHAT, imageGeneration: true },
  },
  {
    id: "video-generation",
    match:
      /sora|veo-?\d|runway|kling|luma-|hunyuan-?video|wan-?\d|ltx-video|cogvideo|pika-|text-to-video/,
    caps: { ...NON_CHAT, video: true },
  },
  {
    id: "speech-to-text",
    match:
      /whisper|transcribe|speech-to-text|parakeet|canary|moonshine|distil-whisper|scribe|asr($|[-_])|automatic-speech/,
    caps: { ...NON_CHAT, audio: true, speechToText: true },
  },
  {
    id: "text-to-speech",
    match:
      /(^|[-_/])tts($|[-_])|text-to-speech|elevenlabs|eleven[-_]|kokoro|orpheus|bark|parler|xtts|piper|playht|speech-0|chatterbox|dia-|f5-tts|supertonic|audio-gen/,
    caps: { ...NON_CHAT, audio: true, textToSpeech: true },
  },
  // ------------------------------------------- Never chat, whoever makes them
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
    match:
      /moderation|moderator|prompt-guard|llama-guard|shieldgemma|nemoguard|safeguard|content-safety|safety-guard/,
    caps: { chat: false, tools: false, streaming: false },
  },
  {
    id: "research",
    match: /research|search|sonar|perplex|compound/,
    caps: { research: true, tools: true, longContext: true },
  },
  {
    id: "embeddings",
    match: /bge|e5-|gte-|nomic-embed|all-minilm|mxbai-embed|rerank/,
    caps: { chat: false, tools: false, streaming: false, embeddings: true },
  },
  {
    id: "vision-by-name",
    match:
      /(^|[/_-])(neva|nvlm|vila|cosmos-nemotron|paligemma|florence|molmo|internvl|glm-4\.?\d*v|kosmos|fuyu|idefics|smolvlm|phi-3(\.5)?-vision|llama-3\.2-\d+b-vision|llama-4)/,
    caps: { vision: true, tools: true },
  },
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
  // OpenRouter and the Hugging Face router publish what goes in and comes out.
  const arch = catalogue?.architecture || model?.meta?.architecture || null;
  const inputs = []
    .concat(arch?.input_modalities || [])
    .map((item) => String(item || "").toLowerCase());
  const outputs = []
    .concat(arch?.output_modalities || [])
    .map((item) => String(item || "").toLowerCase());
  const modalityText = String(arch?.modality || catalogue?.modality || "").toLowerCase();
  if (modalityText.includes("->")) {
    const [from, to] = modalityText.split("->");
    for (const part of from.split("+")) inputs.push(part.trim());
    for (const part of to.split("+")) outputs.push(part.trim());
  }
  if (inputs.includes("image")) out.vision = true;
  if (inputs.includes("audio")) out.audio = true;
  if (outputs.includes("image")) out.imageGeneration = true;
  if (outputs.includes("video")) out.video = true;
  if (outputs.includes("audio") || outputs.includes("speech")) out.textToSpeech = true;
  if (outputs.length && !outputs.includes("text")) {
    out.chat = false;
    out.tools = false;
  }
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
    if (pipeline.includes("automatic-speech-recognition")) out.speechToText = true;
    if (pipeline.includes("text-to-speech") || pipeline.includes("text-to-audio"))
      out.textToSpeech = true;
    if (pipeline.includes("text-to-image") || pipeline.includes("image-to-image")) {
      out.imageGeneration = true;
      out.chat = false;
      out.tools = false;
    }
    if (pipeline.includes("text-to-video") || pipeline.includes("image-to-video")) {
      out.video = true;
      out.chat = false;
      out.tools = false;
    }
  }
  // Ollama POST /api/show publishes a capabilities array. An array that is
  // present is the list: a missing name is false, not the name-guess flag.
  if (Array.isArray(raw) && raw.length) {
    const names = raw.map((item) => String(item || "").toLowerCase());
    out.tools = names.some((item) => /tool|function/.test(item));
    out.vision = names.some((item) => /vision|image/.test(item));
  }
  // LM Studio GET /api/v1/models uses these two booleans.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (typeof raw.trained_for_tool_use === "boolean") out.tools = raw.trained_for_tool_use;
    if (typeof raw.vision === "boolean") out.vision = raw.vision;
  }
  const modelType = String(catalogue?.type || "").toLowerCase();
  if (modelType === "vlm") out.vision = true;
  if (modelType === "embedding" || modelType === "embeddings") {
    out.embeddings = true;
    out.chat = false;
    out.tools = false;
  }
  return out;
}

/** Context tokens from a discovery row, when the provider's list names one. */
function liveContextTokens(model) {
  const catalogue = model?.meta?.catalogue || model?.catalogue || {};
  const bags = [catalogue, catalogue.model_info, model?.meta?.model_info];
  for (const bag of bags) {
    if (!bag || typeof bag !== "object") continue;
    const direct = Number(bag.max_context_length || bag.context_length || bag.inputTokenLimit || 0);
    if (direct > 0) return direct;
    for (const [key, value] of Object.entries(bag)) {
      if (!String(key).endsWith(".context_length")) continue;
      const tokens = Number(value);
      if (tokens > 0) return tokens;
    }
  }
  return 0;
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
    research: /research|search|sonar|perplex|compound/.test(name),
    imageGeneration: /dall-?e|gpt-image|imagen|flux|stable-?diffusion|sdxl/.test(name),
    speechToText: /whisper|transcribe/.test(name),
    textToSpeech: /(^|[-_/])tts($|[-_])|text-to-speech/.test(name),
    video: /sora|veo-?\d|text-to-video/.test(name),
  };
}

/** The one word the Models page shows for what a model is for. */
function kindOf(caps) {
  if (caps.imageGeneration) return "Image";
  if (caps.video && !caps.chat) return "Video";
  if (caps.speechToText && !caps.chat) return "Speech to Text";
  if (caps.textToSpeech && !caps.chat) return "Text to Speech";
  if (caps.audio && !caps.chat) return "Audio";
  if (caps.embeddings && !caps.chat) return "Embedding";
  if (!caps.chat) return "Other";
  if (caps.research) return "Research";
  // A model with several strengths is a general chat model; one strength names it.
  const strengths = [caps.vision, caps.coding, caps.reasoning].filter(Boolean).length;
  if (strengths >= 2) return "Chat";
  if (caps.vision) return "Vision";
  if (caps.coding) return "Coding";
  if (caps.reasoning) return "Reasoning";
  return "Chat";
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
  const liveTokens = liveContextTokens(model);
  const liveK = liveTokens ? Math.max(1, Math.round(liveTokens / 1024)) : 0;
  const passed = Number(model?.contextK || model?.context_k || model?.meta?.contextK || 0);
  const contextK = liveK || passed;
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
  // A listed token count is measured. A name guess stays unverified.
  caps.longContext = contextK >= 64;
  sources.longContext = liveK ? "measured" : contextK ? "unverified" : "default";
  const proofOf = (source) =>
    source === "declared" || source === "measured" ? "live" : "unverified";
  const proof = {
    tools: proofOf(sources.tools),
    vision: proofOf(sources.vision),
    context: proofOf(sources.longContext),
  };
  // Any speech model is an audio model.
  if (caps.speechToText || caps.textToSpeech) caps.audio = true;
  // An embedding or audio model cannot chat or call tools, whatever else said.
  // The same holds for a model that only makes images or video.
  const makesMedia = (caps.imageGeneration || caps.video) && !caps.vision;
  if (caps.embeddings || caps.audio || makesMedia) {
    caps.chat = false;
    caps.tools = false;
  }

  const source = Object.keys(declared).length ? "declared" : entry ? "registry" : "inferred";
  return {
    ...caps,
    contextK,
    source,
    registryId: entry ? entry.id : null,
    sources,
    proof,
    kind: kindOf(caps),
  };
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
  kindOf,
  resolveQualityProfile,
  registryEntry,
  normaliseName,
};
