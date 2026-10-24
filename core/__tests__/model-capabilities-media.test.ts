/**
 * Cloud models are told apart by what they do, not only by "chat": a model that
 * draws, speaks, listens or films is never sent a chat turn, and a model that
 * sees images is known to. Names, provider modalities and Hugging Face
 * pipeline tags each decide it, in that order of trust.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { capabilityLine, cloudKindOf, countKinds } from "../../src/lib/friday/model-sections";

const caps = createRequire(import.meta.url)("../../electron/model-capabilities.cjs") as {
  resolveCapabilities: (m: Record<string, unknown>) => Record<string, unknown>;
};
const of = (id: string, extra: Record<string, unknown> = {}) =>
  caps.resolveCapabilities({ id, ...extra });

describe("kinds of cloud model", () => {
  it.each([
    ["dall-e-3", "Image"],
    ["gpt-image-1", "Image"],
    ["imagen-4.0-generate-001", "Image"],
    ["black-forest-labs/FLUX.1-dev", "Image"],
    ["gemini-2.5-flash-image", "Image"],
    ["veo-3.0-generate", "Video"],
    ["whisper-large-v3", "Speech to Text"],
    ["gpt-4o-transcribe", "Speech to Text"],
    ["gpt-4o-mini-tts", "Text to Speech"],
    ["eleven_multilingual_v2", "Text to Speech"],
    ["text-embedding-3-small", "Embedding"],
    ["sonar-pro", "Research"],
    ["qwen2.5-coder-7b", "Coding"],
    ["llama-3.3-70b", "Chat"],
  ])("%s is %s", (id, kind) => {
    expect(of(id)["kind"]).toBe(kind);
  });

  it("never sends a chat turn to a model that does not chat", () => {
    for (const id of ["dall-e-3", "whisper-large-v3", "gpt-4o-mini-tts", "veo-3.0-generate"]) {
      const c = of(id);
      expect(c["chat"], id).toBe(false);
      expect(c["tools"], id).toBe(false);
    }
  });

  it("keeps real chat models chatting, with vision where it exists", () => {
    expect(of("gpt-4o")).toMatchObject({ chat: true, vision: true, tools: true });
    expect(of("claude-sonnet-4")).toMatchObject({ chat: true, vision: true });
    expect(of("gemini-2.5-pro")).toMatchObject({ chat: true, vision: true });
  });
});

describe("what the provider says it takes in and gives out", () => {
  const withArch = (input: string[], output: string[]) =>
    of("vendor/some-model", {
      meta: { catalogue: { architecture: { input_modalities: input, output_modalities: output } } },
    });

  it("reads image input as vision", () => {
    expect(withArch(["text", "image"], ["text"])).toMatchObject({ vision: true, chat: true });
  });

  it("treats a model that only outputs images as an image maker, not a chat model", () => {
    expect(withArch(["text"], ["image"])).toMatchObject({
      imageGeneration: true,
      chat: false,
      kind: "Image",
    });
  });

  it("reads the combined modality text of OpenRouter rows", () => {
    const row = of("vendor/m", {
      meta: { catalogue: { architecture: { modality: "text+image->text" } } },
    });
    expect(row["vision"]).toBe(true);
  });

  it("reads Hugging Face pipeline tags", () => {
    expect(of("org/m", { meta: { pipelineTag: "text-to-image" } })["kind"]).toBe("Image");
    expect(of("org/m", { meta: { pipelineTag: "automatic-speech-recognition" } })["kind"]).toBe(
      "Speech to Text",
    );
    expect(of("org/m", { meta: { pipelineTag: "text-to-video" } })["kind"]).toBe("Video");
  });
});

describe("how the Models page shows it", () => {
  it("names the kind and the facts", () => {
    const c = of("gpt-4o");
    expect(cloudKindOf(c)).toBe("Chat");
    expect(capabilityLine(c)).toMatch(/sees images/);
    expect(capabilityLine(of("dall-e-3"))).toBe("makes images");
  });

  it("counts cloud models per kind", () => {
    const counts = countKinds([
      { type: "cloud", capabilities: of("dall-e-3") },
      { type: "cloud", capabilities: of("gpt-4o") },
      { type: "cloud", capabilities: of("llama-3.3-70b") },
      { type: "local", capabilities: of("llama-3.3-70b") },
    ]);
    expect(counts.get("Image")).toBe(1);
    expect(counts.get("Chat")).toBe(2);
  });
});
