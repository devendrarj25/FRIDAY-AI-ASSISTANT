/**
 * Gemini, OpenRouter, Groq, NVIDIA and Hugging Face as they list their models:
 * every row gets a kind, a cost class and a decision (shown or hidden, and why)
 * the way the Models page and the router will see it. Realistic list payloads,
 * no network, no key.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
type Row = Record<string, unknown> & { id: string };
const models = require_("../../electron/models.cjs") as {
  CLOUD: Record<string, { list: (body: unknown) => string[] }>;
};
const access = require_("../../electron/model-access.cjs") as {
  classifyModel: (input: Record<string, unknown>) => Record<string, unknown>;
  coarseAccess: (record: unknown) => string;
};
const caps = require_("../../electron/model-capabilities.cjs") as {
  resolveCapabilities: (
    model: Record<string, unknown>,
  ) => Record<string, unknown> & { kind: string };
};
const router = require_("../../electron/model-router.cjs") as {
  modelAvailability: (
    model: unknown,
    policy: string,
    now: number,
    task: string,
  ) => { visibility: string; reason: string | null };
};

const now = Date.now();
function see(providerId: string, rows: Row[], ownerFree = false) {
  const spec = models.CLOUD[providerId]!;
  const out = new Map<string, { kind: string; access: string; free: string; paid: string }>();
  for (const id of spec.list({ data: rows })) {
    const raw = rows.find((row) => String(row.id).replace(/^models\//, "") === id) ?? { id };
    const catalogue = { ...raw, id, name: id };
    const record = access.classifyModel({
      providerId,
      modelId: id,
      kind: "cloud",
      catalogue,
      account: null,
      ...(ownerFree ? { ownerDeclaration: { providerFreeTier: true, model: null } } : {}),
      endpoint: "https://example.invalid",
    });
    const capabilities = caps.resolveCapabilities({
      id,
      meta: { catalogue, pipelineTag: raw["pipeline_tag"] },
    });
    const model = {
      id: `${providerId}:${id}`,
      type: "cloud",
      providerId,
      access: access.coarseAccess(record),
      accessRecord: record,
      capabilities,
      connected: true,
    };
    out.set(id, {
      kind: capabilities.kind,
      access: model.access,
      free: router.modelAvailability(model, "free-only", now, "chat").visibility,
      paid: router.modelAvailability(model, "allow-paid", now, "chat").visibility,
    });
  }
  return out;
}
const ids = (names: string[]): Row[] => names.map((id) => ({ id }));

describe("Google Gemini", () => {
  const view = see(
    "gemini",
    ids([
      "models/gemini-2.5-pro",
      "models/gemini-2.5-flash",
      "models/gemini-2.5-flash-preview-tts",
      "models/imagen-4.0-generate-001",
      "models/veo-3.0-generate-001",
      "models/text-embedding-004",
      "models/gemini-3-pro-preview",
    ]),
  );
  it("uses the free-tier families on the free plan", () => {
    expect(view.get("gemini-2.5-pro")).toMatchObject({
      kind: "Chat",
      access: "free",
      free: "show",
    });
    expect(view.get("gemini-2.5-flash")).toMatchObject({ access: "free", free: "show" });
  });
  it("never offers speech, image, video or embedding models as chat", () => {
    expect(view.get("gemini-2.5-flash-preview-tts")).toMatchObject({
      kind: "Text to Speech",
      paid: "hide",
    });
    expect(view.get("imagen-4.0-generate-001")).toMatchObject({ kind: "Image", paid: "hide" });
    expect(view.get("veo-3.0-generate-001")).toMatchObject({ kind: "Video", paid: "hide" });
    expect(view.get("text-embedding-004")).toMatchObject({ kind: "Embedding", paid: "hide" });
  });
  it("keeps a model with no free evidence hidden until paid access is on", () => {
    expect(view.get("gemini-3-pro-preview")).toMatchObject({ free: "hide", paid: "show" });
  });
});

describe("Groq", () => {
  const rows = ids([
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
    "meta-llama/llama-guard-4-12b",
    "groq/compound",
    "whisper-large-v3",
    "playai-tts",
  ]);
  it("knows research, speech and safety models for what they are", () => {
    const view = see("groq", rows);
    expect(view.get("groq/compound")?.kind).toBe("Research");
    expect(view.get("meta-llama/llama-guard-4-12b")).toMatchObject({ kind: "Other", paid: "hide" });
    expect(view.get("whisper-large-v3")).toMatchObject({ kind: "Speech to Text", paid: "hide" });
    expect(view.get("playai-tts")).toMatchObject({ kind: "Text to Speech", paid: "hide" });
  });
  it("hides chat models until the owner says the key is on the Free plan", () => {
    const before = see("groq", rows);
    expect(before.get("llama-3.3-70b-versatile")?.free).toBe("hide");
    expect(before.get("openai/gpt-oss-120b")?.free).toBe("hide");
  });
  it("uses every Groq chat model, priced ones too, once the owner says the key is free", () => {
    const after = see("groq", rows, true);
    expect(after.get("llama-3.3-70b-versatile")?.free).toBe("show");
    expect(after.get("openai/gpt-oss-120b")?.free).toBe("show");
    expect(after.get("groq/compound")?.free).toBe("show");
    expect(after.get("whisper-large-v3")?.free).toBe("hide");
  });
});

describe("NVIDIA", () => {
  const view = see(
    "nvidia",
    ids([
      "meta/llama-3.1-405b-instruct",
      "nvidia/nv-embedqa-e5-v5",
      "nvidia/nv-rerankqa-mistral-4b-v3",
      "nvidia/neva-22b",
      "meta/llama-3.2-90b-vision-instruct",
      "qwen/qwq-32b",
      "black-forest-labs/flux.1-dev",
      "nvidia/nemoguard-8b-content-safety",
    ]),
  );
  it("shows the free-trial chat, vision and reasoning models", () => {
    expect(view.get("meta/llama-3.1-405b-instruct")).toMatchObject({
      access: "free",
      free: "show",
    });
    expect(view.get("nvidia/neva-22b")).toMatchObject({ kind: "Vision", free: "show" });
    expect(view.get("meta/llama-3.2-90b-vision-instruct")?.kind).toBe("Vision");
    expect(view.get("qwen/qwq-32b")).toMatchObject({ kind: "Reasoning", free: "show" });
  });
  it("keeps embedding, reranking, image and safety models out of chat", () => {
    for (const id of [
      "nvidia/nv-embedqa-e5-v5",
      "nvidia/nv-rerankqa-mistral-4b-v3",
      "black-forest-labs/flux.1-dev",
      "nvidia/nemoguard-8b-content-safety",
    ]) {
      expect(view.get(id)?.free, id).toBe("hide");
      expect(view.get(id)?.paid, id).toBe("hide");
    }
    expect(view.get("nvidia/nv-rerankqa-mistral-4b-v3")?.kind).toBe("Embedding");
  });
});

describe("OpenRouter", () => {
  const priced = (prompt: string, completion: string, input: string[], output: string[]) => ({
    pricing: { prompt, completion },
    architecture: { input_modalities: input, output_modalities: output },
  });
  const view = see("openrouter", [
    { id: "deepseek/deepseek-r1:free", ...priced("0", "0", ["text"], ["text"]) },
    { id: "qwen/qwen2.5-vl-72b-instruct:free", ...priced("0", "0", ["text", "image"], ["text"]) },
    { id: "openai/gpt-4o", ...priced("0.0000025", "0.00001", ["text", "image"], ["text"]) },
    { id: "perplexity/sonar-deep-research", ...priced("0.000002", "0.000008", ["text"], ["text"]) },
    {
      id: "google/gemini-2.5-flash-image-preview",
      ...priced("0.0000003", "0.0000025", ["image", "text"], ["image", "text"]),
    },
    { id: "openai/gpt-4o-mini-tts", ...priced("0.0000006", "0.000012", ["text"], ["audio"]) },
  ]);
  it("shows zero-priced models on free-only and reads their modalities", () => {
    expect(view.get("deepseek/deepseek-r1:free")).toMatchObject({ access: "free", free: "show" });
    expect(view.get("qwen/qwen2.5-vl-72b-instruct:free")).toMatchObject({
      kind: "Vision",
      free: "show",
    });
  });
  it("keeps priced models for when paid access is on, with their kind", () => {
    expect(view.get("openai/gpt-4o")).toMatchObject({ access: "paid", free: "hide", paid: "show" });
    expect(view.get("perplexity/sonar-deep-research")).toMatchObject({
      kind: "Research",
      paid: "show",
    });
    expect(view.get("google/gemini-2.5-flash-image-preview")?.kind).toBe("Image");
    expect(view.get("openai/gpt-4o-mini-tts")).toMatchObject({
      kind: "Text to Speech",
      paid: "hide",
    });
  });
});

describe("Hugging Face", () => {
  const live = (provider: string, input: number, output: number) => [
    { provider, status: "live", pricing: { input, output } },
  ];
  const view = see("huggingface", [
    { id: "Qwen/Qwen3-235B-A22B", providers: live("cerebras", 0.6, 1.2) },
    {
      id: "Qwen/Qwen2.5-VL-7B-Instruct",
      providers: live("hyperbolic", 0.2, 0.2),
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    },
    {
      id: "black-forest-labs/FLUX.1-dev",
      providers: [{ provider: "fal-ai", status: "live" }],
      pipeline_tag: "text-to-image",
    },
    {
      id: "openai/whisper-large-v3",
      providers: [{ provider: "fal-ai", status: "live" }],
      pipeline_tag: "automatic-speech-recognition",
    },
    {
      id: "BAAI/bge-m3",
      providers: [{ provider: "hf-inference", status: "live" }],
      pipeline_tag: "feature-extraction",
    },
  ]);
  it("prices routed models from their provider rows", () => {
    expect(view.get("Qwen/Qwen3-235B-A22B")).toMatchObject({
      access: "paid",
      free: "hide",
      paid: "show",
    });
    expect(view.get("Qwen/Qwen2.5-VL-7B-Instruct")).toMatchObject({ kind: "Vision", paid: "show" });
  });
  it("labels image, speech and embedding tasks and keeps them out of chat", () => {
    expect(view.get("black-forest-labs/FLUX.1-dev")).toMatchObject({ kind: "Image", paid: "hide" });
    expect(view.get("openai/whisper-large-v3")).toMatchObject({
      kind: "Speech to Text",
      paid: "hide",
    });
    expect(view.get("BAAI/bge-m3")).toMatchObject({ kind: "Embedding", paid: "hide" });
  });
});
