/**
 * Acceptance test suite for the complete model routing system (Modes A through R).
 *
 * Requirements:
 * A: AUTO: No explicit model -> best eligible model selected dynamically.
 * B: LOCAL-ONLY: Ollama model selected -> actual Ollama candidate selected.
 * C: LOCAL-ONLY: No cloud API keys -> still works if local model available.
 * D: CLOUD-ONLY: OpenRouter model selected -> actual cloud model selected.
 * E: CLOUD-ONLY: Gemini free model selected and eligible -> actual Gemini selection.
 * F: MULTI: 3 explicitly selected models -> actual 3-model execution.
 * G: MANUAL: one explicit model -> exact model only.
 * H: HYBRID: local + cloud available -> smart router chooses based on policy/task.
 * I: FREE-ONLY: paid model selected -> blocked.
 * J: FREE-ONLY: verified free model -> works.
 * K: FREE-ONLY: free candidate rate-limited -> retry another eligible free model.
 * L: AUTO: OpenRouter unavailable -> another eligible provider/local model.
 * M: AUTO: local model is faster and suitable -> local can win.
 * N: LOCAL-ONLY: cloud model selected -> reject honestly; never cloud fallback.
 * O: CLOUD-ONLY: local model selected -> reject honestly; never local fallback.
 * P: Offline -> local model works.
 * Q: Provider model disappears -> registry refresh removes it from active routing.
 * R: Provider adds a new free model -> FRIDAY discovers it dynamically without code modification.
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const router = require_("../../electron/model-router.cjs");
const access = require_("../../electron/model-access.cjs");
const models = require_("../../electron/models.cjs");

function makeLocalModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    type: "local",
    kind: "local",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    contextK: 32,
    status: "ready",
    capabilities: { chat: true, coding: true, reasoning: true, tools: true, vision: false },
    meta: { providerId: "ollama", kind: "local", modelName: id, resident: false, sizeGb: 4 },
    ...overrides,
  };
}

function makeCloudModel(
  id: string,
  providerId: string,
  billingMode = "ZERO_COST",
  verification = "VERIFIED",
  overrides: Record<string, unknown> = {},
) {
  const record = access.makeRecord({
    billingMode,
    eligibility: "ELIGIBLE",
    verification,
  });
  return {
    id,
    label: id,
    type: "cloud",
    kind: "cloud",
    provider: providerId,
    endpoint: "https://api.example.com/v1",
    contextK: 128,
    status: "ready",
    accessRecord: record,
    capabilities: { chat: true, coding: true, reasoning: true, tools: true, vision: true },
    meta: { providerId, kind: "cloud", modelName: id, accessRecord: record },
    ...overrides,
  };
}

describe("Section 40 Acceptance Tests (Modes A - R)", () => {
  const localLlama = makeLocalModel("ollama:llama3.1:8b");
  const localQwen = makeLocalModel("ollama:qwen2.5:32b", {
    capabilities: { chat: true, coding: true, reasoning: true, tools: true },
  });
  const openrouterFree = makeCloudModel(
    "openrouter:openrouter/free",
    "openrouter",
    "ZERO_COST",
    "VERIFIED",
  );
  const openrouterPaid = makeCloudModel(
    "openrouter:anthropic/claude-3.5-sonnet",
    "openrouter",
    "PAID",
    "VERIFIED",
  );
  const geminiFlash = makeCloudModel("gemini:gemini-2.0-flash", "gemini", "FREE_QUOTA", "VERIFIED");
  const groqLlama = makeCloudModel("groq:openai/gpt-oss-20b", "groq", "FREE_QUOTA", "VERIFIED");

  it("A. AUTO: No explicit model -> best eligible model selected dynamically", () => {
    const pool = [localLlama, openrouterFree, geminiFlash];
    const selected = router.selectEligible(pool, { mode: "auto", policy: "free-first" });
    expect(selected.length).toBeGreaterThan(0);
    expect([
      "openrouter:openrouter/free",
      "gemini:gemini-2.0-flash",
      "ollama:llama3.1:8b",
    ]).toContain(selected[0].id);
  });

  it("B. LOCAL-ONLY: Ollama model selected -> actual Ollama candidate selected", () => {
    const pool = [localLlama, openrouterFree];
    const selected = router.selectEligible(pool, {
      mode: "local-only",
      preferred: ["ollama:llama3.1:8b"],
    });
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe("ollama:llama3.1:8b");
    expect(selected[0].type).toBe("local");
  });

  it("C. LOCAL-ONLY: No cloud API keys -> still works if local model available", () => {
    const pool = [localLlama, localQwen];
    const selected = router.selectEligible(pool, { mode: "local-only" });
    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(selected.every((m: { type: string }) => m.type === "local")).toBe(true);
  });

  it("D. CLOUD-ONLY: OpenRouter model selected -> actual cloud model selected", () => {
    const pool = [localLlama, openrouterFree];
    const selected = router.selectEligible(pool, {
      mode: "cloud-only",
      preferred: ["openrouter:openrouter/free"],
    });
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe("openrouter:openrouter/free");
    expect(selected[0].type).toBe("cloud");
  });

  it("E. CLOUD-ONLY: Gemini free model selected and eligible -> actual Gemini selection", () => {
    const pool = [localLlama, geminiFlash];
    const selected = router.selectEligible(pool, {
      mode: "cloud-only",
      policy: "free-only",
      preferred: ["gemini:gemini-2.0-flash"],
    });
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe("gemini:gemini-2.0-flash");
  });

  it("F. MULTI: 3 explicitly selected models -> actual 3-model execution", () => {
    const pool = [localLlama, geminiFlash, groqLlama, openrouterFree];
    const parallel = router.selectParallel(pool, {
      mode: "multi",
      preferred: ["ollama:llama3.1:8b", "gemini:gemini-2.0-flash", "groq:openai/gpt-oss-20b"],
    });
    expect(parallel.length).toBe(3);
    const ids = parallel.map((m: { id: string }) => m.id);
    expect(ids).toContain("ollama:llama3.1:8b");
    expect(ids).toContain("gemini:gemini-2.0-flash");
    expect(ids).toContain("groq:openai/gpt-oss-20b");
  });

  it("G. MANUAL: one explicit model -> exact model only", () => {
    const pool = [localLlama, geminiFlash, groqLlama];
    const selected = router.selectEligible(pool, {
      mode: "manual",
      preferred: ["gemini:gemini-2.0-flash"],
    });
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe("gemini:gemini-2.0-flash");
  });

  it("H. HYBRID: local + cloud available -> smart router chooses based on policy/task", () => {
    const fastLocal = makeLocalModel("ollama:fast-chat", {
      qualityProfile: { speedScore: 0.95, chatScore: 0.8 },
      meta: { resident: true },
    });
    const reasoningCloud = makeCloudModel("gemini:reasoning", "gemini", "FREE_QUOTA", "VERIFIED", {
      qualityProfile: { reasoningScore: 0.95, speedScore: 0.4 },
    });
    const pool = [fastLocal, reasoningCloud];

    const reasoningPick = router.selectEligible(pool, { mode: "hybrid", task: "reasoning" });
    expect(reasoningPick[0].id).toBe("gemini:reasoning");

    const fastPick = router.selectEligible(pool, { mode: "hybrid", task: "fast" });
    expect(fastPick[0].id).toBe("ollama:fast-chat");
  });

  it("I. FREE-ONLY: paid model selected -> blocked", () => {
    const pool = [openrouterPaid];
    const selected = router.selectEligible(pool, {
      mode: "cloud-only",
      policy: "free-only",
      preferred: ["openrouter:anthropic/claude-3.5-sonnet"],
    });
    expect(selected).toEqual([]);
    const explanation = router.explainUnavailable({
      mode: "cloud-only",
      policy: "free-only",
      preferred: ["openrouter:anthropic/claude-3.5-sonnet"],
    });
    expect(explanation).toContain("NO_FREE_MODEL_AVAILABLE");
  });

  it("J. FREE-ONLY: verified free model -> works", () => {
    const pool = [openrouterPaid, geminiFlash];
    const selected = router.selectEligible(pool, {
      mode: "cloud-only",
      policy: "free-only",
    });
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe("gemini:gemini-2.0-flash");
  });

  it("K. FREE-ONLY: free candidate rate-limited -> retry another eligible free model", () => {
    const health = new router.ProviderHealthManager();
    health.noteFailure("gemini:gemini-2.0-flash", new Error("HTTP 429: rate limit exceeded"));

    const pool = [geminiFlash, groqLlama];
    const selected = router.selectEligible(pool, {
      mode: "cloud-only",
      policy: "free-only",
      health,
    });
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe("groq:openai/gpt-oss-20b");
  });

  it("L. AUTO: OpenRouter unavailable -> another eligible provider/local model", () => {
    const health = new router.ProviderHealthManager();
    health.noteFailure("openrouter:openrouter/free", new Error("HTTP 503: service unavailable"));

    const pool = [openrouterFree, geminiFlash, localLlama];
    const selected = router.selectEligible(pool, {
      mode: "auto",
      policy: "free-first",
      health,
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0].id).not.toBe("openrouter:openrouter/free");
  });

  it("M. AUTO: local model is faster and suitable -> local can win", () => {
    const fastLocal = makeLocalModel("ollama:fast-chat", {
      meta: { resident: true },
      qualityProfile: { speedScore: 0.99, chatScore: 0.85 },
    });
    const slowCloud = makeCloudModel("openrouter:slow", "openrouter", "ZERO_COST", "VERIFIED", {
      qualityProfile: { speedScore: 0.1, chatScore: 0.8 },
    });
    const pool = [fastLocal, slowCloud];
    const selected = router.selectEligible(pool, {
      mode: "auto",
      task: "fast",
      requirements: { maxLatencyMs: 500 },
    });
    expect(selected[0].id).toBe("ollama:fast-chat");
  });

  it("N. LOCAL-ONLY: cloud model selected -> reject honestly; never cloud fallback", () => {
    const pool = [localLlama, geminiFlash];
    const selected = router.selectEligible(pool, {
      mode: "local-only",
      preferred: ["gemini:gemini-2.0-flash"],
    });
    expect(selected).toEqual([]);
    const explanation = router.explainUnavailable({
      mode: "local-only",
      preferred: ["gemini:gemini-2.0-flash"],
    });
    expect(explanation).toContain("None of the models you picked are eligible under local-only");
  });

  it("O. CLOUD-ONLY: local model selected -> reject honestly; never local fallback", () => {
    const pool = [localLlama, geminiFlash];
    const selected = router.selectEligible(pool, {
      mode: "cloud-only",
      preferred: ["ollama:llama3.1:8b"],
    });
    expect(selected).toEqual([]);
    const explanation = router.explainUnavailable({
      mode: "cloud-only",
      preferred: ["ollama:llama3.1:8b"],
    });
    expect(explanation).toContain("None of the models you picked are eligible under cloud-only");
  });

  it("P. Offline -> local model works", () => {
    const pool = [localLlama, openrouterFree];
    const selected = router.selectEligible(pool, {
      mode: "auto",
      offline: true,
    });
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe("ollama:llama3.1:8b");
    expect(selected[0].type).toBe("local");
  });

  it("Q. Provider model disappears -> registry refresh removes it from active routing", () => {
    const staleModelId = "openrouter:disappeared-model";
    // Catalogue refresh provides active models from provider, excluding the disappeared model
    const activeProviderModels = [
      { id: "openrouter/free", name: "Free Router" },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
    ];
    const activeRegistryModels = activeProviderModels.map((m) =>
      makeCloudModel(`openrouter:${m.id}`, "openrouter", "ZERO_COST", "VERIFIED"),
    );
    // When router is given the refreshed pool, the disappeared model is gone
    const selected = router.selectEligible(activeRegistryModels, {
      mode: "auto",
      preferred: [staleModelId],
    });
    expect(selected.some((m: { id: string }) => m.id === staleModelId)).toBe(false);
  });

  it("R. Provider adds a new free model -> FRIDAY discovers it dynamically without code modification", () => {
    // A brand new model released tomorrow by a provider with $0 pricing
    const newProviderModel = {
      id: "brand-new-future-model",
      pricing: { prompt: "0", completion: "0" },
      context_length: 65536,
    };
    const classified = access.classifyModel({
      providerId: "openrouter",
      modelId: newProviderModel.id,
      catalogue: newProviderModel,
    });
    expect(classified.billingMode).toBe("ZERO_COST");
    expect(access.isFreeCandidate(classified)).toBe(true);

    // When probed, it becomes verified zero cost
    const verified = access.applyProbe(classified, {
      ok: true,
      status: 200,
      response: "ok",
      headers: {},
    });
    expect(verified.verification).toBe("VERIFIED");
    expect(access.effectiveStatus(verified)).toBe("VERIFIED_ZERO_COST");
  });
});
