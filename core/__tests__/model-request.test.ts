/**
 * "Use this model" / "that provider se" in the owner's words routes the turn;
 * a bare mention does not.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseModelRequest } from "../../src/lib/friday/brain/model-request";

const models = [
  { id: "ollama:qwen2.5:1.5b", providerId: "ollama", names: ["qwen2.5:1.5b", "Qwen2.5 1.5B"] },
  { id: "openai:gpt-4o-mini", providerId: "openai", names: ["gpt-4o-mini", "GPT-4o mini"] },
  { id: "groq:llama-3.1-8b-instant", providerId: "groq", names: ["llama-3.1-8b-instant"] },
];
const providers = [
  { id: "openai", names: ["openai", "OpenAI"] },
  { id: "gemini", names: ["gemini", "Google Gemini"] },
  { id: "groq", names: ["groq", "Groq"] },
  { id: "anthropic", names: ["anthropic", "Anthropic"] },
];
const parse = (prompt: string) => parseModelRequest(prompt, models, providers);

describe("model and provider requests in a prompt", () => {
  it("routes a named model in English and Hinglish", () => {
    expect(parse("use gpt-4o-mini to summarise this file")).toMatchObject({
      kind: "model",
      modelId: "openai:gpt-4o-mini",
    });
    expect(parse("qwen2.5 1.5b se ye email likho")).toMatchObject({
      kind: "model",
      modelId: "ollama:qwen2.5:1.5b",
    });
    expect(parse("Answer with the model llama-3.1-8b-instant please")).toMatchObject({
      modelId: "groq:llama-3.1-8b-instant",
    });
  });

  it("routes a named provider, including everyday names", () => {
    expect(parse("gemini se pucho ki kal mausam kaisa hoga")).toMatchObject({
      kind: "provider",
      providerId: "gemini",
    });
    expect(parse("ask claude to review this code")).toMatchObject({ providerId: "anthropic" });
    expect(parse("is sawal ko groq models se karo")).toMatchObject({ providerId: "groq" });
    expect(parse("use chatgpt for this")).toMatchObject({ providerId: "openai" });
  });

  it("a model beats its provider and the longest name wins", () => {
    expect(parse("use openai gpt-4o-mini for this")).toMatchObject({ kind: "model" });
  });

  it("a bare mention is not a request", () => {
    expect(parse("what is OpenAI and who owns it?")).toBeNull();
    expect(parse("tell me about gemini the zodiac sign")).toBeNull();
    expect(parse("hi")).toBeNull();
    expect(parse("use a bigger font")).toBeNull();
  });

  it("is wired into send() before the registry defaults, and the router keeps the firewalls", () => {
    const brain = readFileSync(
      path.resolve(import.meta.dirname, "../../src/lib/friday/brain-engine.ts"),
      "utf8",
    );
    expect(brain).toContain("const named = promptRouting(prompt, rawOptions);");
    expect(brain).toContain("selectedProviderIds: options.providerIds || []");
    const router = readFileSync(
      path.resolve(import.meta.dirname, "../../electron/model-router.cjs"),
      "utf8",
    );
    expect(router).toContain('if (ctx.privateRoute && m.type !== "local") return "privacy";');
  });
});
