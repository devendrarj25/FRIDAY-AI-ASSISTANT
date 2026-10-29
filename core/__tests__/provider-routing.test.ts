/**
 * Provider routing contract.
 *
 * A hosted model is addressed by the provider's own id, not by FRIDAY's short
 * catalog handle. These tests keep that translation honest so Hugging Face,
 * NVIDIA NIM and every other provider keep receiving ids they accept.
 */
import { describe, expect, it } from "vitest";
import {
  apiIdFor,
  modelById,
  modelCatalog,
  providerById,
  registryTag,
  routeRefs,
} from "../../src/lib/friday/model-catalog";

describe("provider routing", () => {
  it("gives every hosted model a provider-side id", () => {
    const hosted = modelCatalog.filter((m) => m.kind === "cloud");
    expect(hosted.length).toBeGreaterThan(20);
    for (const model of hosted) {
      const apiId = apiIdFor(model);
      expect(apiId.length).toBeGreaterThan(0);
      expect(apiId).not.toMatch(/\s/);
    }
  });

  it("maps Hugging Face router models to real repository ids", () => {
    const hf = modelCatalog.filter((m) => m.provider === "huggingface");
    expect(hf.length).toBeGreaterThanOrEqual(6);
    for (const model of hf) expect(apiIdFor(model)).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it("maps NVIDIA NIM models to build.nvidia.com ids", () => {
    const nim = modelCatalog.filter((m) => m.provider === "nvidia" && m.kind === "cloud");
    expect(nim.length).toBeGreaterThanOrEqual(8);
    for (const model of nim) expect(apiIdFor(model)).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it("sends the provider id first and the catalog id as a fallback", () => {
    const refs = routeRefs(["hf-router-qwen3-coder", "nvidia-llama3.3-70b"]);
    expect(refs[0]).toBe("Qwen/Qwen3-Coder-480B-A35B-Instruct");
    expect(refs).toContain("meta/llama-3.3-70b-instruct");
    expect(refs).toContain("hf-router-qwen3-coder");
  });

  it("routes local models by their real registry tag", () => {
    const local = modelById.get("llama3.1-8b");
    expect(local).toBeTruthy();
    const refs = routeRefs(["llama3.1-8b"]);
    expect(refs[0]).toBe(registryTag(local!));
  });

  it("passes unknown ids straight through", () => {
    expect(routeRefs(["ollama:custom-model"])).toEqual(["ollama:custom-model"]);
  });

  it("keeps every catalog model pointing at a registered provider", () => {
    for (const model of modelCatalog) expect(providerById.has(model.provider)).toBe(true);
  });
});
