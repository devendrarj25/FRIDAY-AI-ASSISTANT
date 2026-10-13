/**
 * Router upgrade: one model's failure stays on that model, free proof stays
 * fail-closed, and a local id that is not loaded is not routed.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const access = require_("../../electron/model-access.cjs");
const router = require_("../../electron/model-router.cjs");
const models = require_("../../electron/models.cjs");

const cloud = (providerId: string, modelId: string, extra: Record<string, unknown> = {}) => ({
  id: `${providerId}:${modelId}`,
  type: "cloud" as const,
  contextK: 8,
  providerId,
  providerModelId: modelId,
  meta: {
    providerId,
    kind: "cloud",
    modelName: modelId,
    connected: true,
    ...extra,
  },
});

const local = (id: string, extra: Record<string, unknown> = {}, status?: string) => ({
  id,
  type: "local" as const,
  contextK: 8,
  status,
  meta: {
    providerId: "ollama",
    kind: "local",
    modelName: id.split(":")[1] || id,
    connected: true,
    ...extra,
  },
});

describe("provider errors stay on the model that failed", () => {
  const sibling = cloud("groq", "other-model");
  const other = cloud("gemini", "gemini-2.5-flash");
  const resident = local("ollama:llama3.2");
  const failed = cloud("groq", "openai/gpt-oss-20b");

  it("does not treat a 403 as a dead key", () => {
    const denied = router.classifyError({
      status: 403,
      message: "this key does not have access to this model",
    });
    expect(denied.category).toBe("model_access");
    expect(denied.retryable).toBe(false);
    expect(denied.cooldownMs).toBe(15 * 60_000);
    expect(denied.nextStep).toMatch(/other models on this provider/i);
    expect(router.classifyError({ status: 401, message: "invalid api key" }).category).toBe(
      "invalid_key",
    );
    expect(
      router.classifyError({ status: 403, message: "not available in your region" }).category,
    ).toBe("region_block");
    expect(router.classifyError({ status: 402, message: "payment required" }).category).toBe(
      "billing_required",
    );
    expect(
      router.classifyError({ status: 403, message: "free tier is not enabled" }).category,
    ).toBe("model_access");
  });

  it("splits a daily cap from a burst and honours Retry-After", () => {
    const daily = router.classifyError({
      status: 429,
      message: "rate limit",
      headers: { "x-ratelimit-remaining-requests": "0" },
      retryAfter: 120,
    });
    expect(daily.category).toBe("daily_limit");
    expect(daily.cooldownMs).toBe(120_000);
    const words = router.classifyError({ status: 429, message: "free-models-per-day exceeded" });
    expect(words.category).toBe("daily_limit");
    expect(words.cooldownMs).toBe(60 * 60_000);
    const burst = router.classifyError({
      status: 429,
      message: "rate limit",
      headers: { "x-ratelimit-remaining-requests": "10" },
    });
    expect(burst.category).toBe("rate_limited");
    expect(burst.cooldownMs).toBe(60_000);
  });

  it("keeps a sibling eligible after one model's paid or access refusal", () => {
    expect(router.fallbackAdvances("billing_required")).toBe(true);
    expect(router.fallbackAdvances("model_access")).toBe(true);
    expect(router.fallbackAdvances("invalid_key")).toBe(true);
    const paid = router.orderFallbacks([sibling, other, resident], failed, "billing_required");
    expect(paid.map((model: { id: string }) => model.id)[0]).toBe(sibling.id);
    const accessDenied = router.orderFallbacks([sibling, other, resident], failed, "model_access");
    expect(accessDenied.map((model: { id: string }) => model.id)).toContain(sibling.id);
    const key = router.orderFallbacks([sibling, other, resident], failed, "invalid_key");
    expect(key.map((model: { id: string }) => model.id)).not.toContain(sibling.id);
    expect(key.map((model: { id: string }) => model.id)).toContain(other.id);
    const text = router.explainFailure({
      failures: [
        { label: "Groq · openai/gpt-oss-20b", category: "billing_required" },
        { label: "Groq · other-model", category: "model_access" },
      ],
    });
    expect(text).toContain("Groq · openai/gpt-oss-20b");
    expect(text).toContain("needs paid access");
    expect(text).toContain("Other models on this provider are still eligible");
    expect(text).not.toMatch(/sk-[a-z0-9]/i);
  });
});

describe("free proof and the firewall", () => {
  it("does not probe or route a priced or unknown model in free-only", () => {
    const priced = cloud("groq", "openai/gpt-oss-20b");
    const unknown = cloud("groq", "llama-3.3-70b-versatile");
    const free = cloud("gemini", "gemini-2.5-flash");
    const plan = router.planRoute([priced, unknown, free, local("ollama:llama3.2")], {
      mode: "auto",
      policy: "free-only",
      limit: 10,
    });
    expect(plan.candidates).not.toContain(priced.id);
    expect(plan.candidates).not.toContain(unknown.id);
    expect(plan.candidates).toContain(free.id);
    const probes = router.selectVerificationCandidates([priced, unknown, free], {
      policy: "free-preferred",
    });
    expect(probes.map((model: { id: string }) => model.id)).toEqual([free.id]);
    const record = access.classifyModel({ providerId: "groq", modelId: "openai/gpt-oss-20b" });
    expect(record.billingMode).toBe("PAID");
    expect(access.isFreeCandidate(record)).toBe(false);
  });

  it("keeps a private turn on local models", () => {
    const plan = router.planRoute([cloud("gemini", "gemini-2.5-flash"), local("ollama:llama3.2")], {
      requirements: { privacy: "private" },
      policy: "free-preferred",
    });
    expect(plan.candidates).toEqual(["ollama:llama3.2"]);
    expect(plan.rejected).toContainEqual({
      id: "gemini:gemini-2.5-flash",
      reason: "privacy",
    });
    expect(plan.whyThisModel).toMatch(/local/);
  });
});

describe("per-model breaker and score", () => {
  it("opens, half-opens, and closes from the cooldown clock", () => {
    const health = new router.ProviderHealthManager();
    const now = 1_700_000_000_000;
    const id = "gemini:gemini-2.5-flash";
    health.noteFailure(id, { status: 500, message: "provider error" }, now);
    health.noteFailure(id, { status: 500, message: "provider error" }, now + 1);
    health.noteFailure(id, { status: 500, message: "provider error" }, now + 2);
    expect(health.breakerState(id, now + 2)).toBe("OPEN");
    expect(health.isCoolingDown(id, now + 2)).toBe(true);
    const until = health.get(id).cooldownUntil as number;
    expect(health.breakerState(id, until)).toBe("HALF-OPEN");
    expect(health.isCoolingDown(id, until)).toBe(false);
    health.noteSuccess(id, 80);
    expect(health.breakerState(id, until + 1)).toBe("CLOSED");
    const again = health.exportState();
    const restored = new router.ProviderHealthManager();
    restored.importState(again);
    expect(restored.breakerState(id, until + 1)).toBe("CLOSED");
  });

  it("redacts a key from the health record and the debug report", () => {
    const health = new router.ProviderHealthManager();
    const secret = "sk-abcdefghij123456";
    health.noteFailure(
      "gemini:gemini-2.5-flash",
      { status: 401, message: `invalid api key ${secret} api_key=supersecretvalue` },
      1_700_000_000_000,
    );
    health.noteDecision({
      modelId: "gemini:gemini-2.5-flash",
      why: `bearer ${secret}`,
      outcome: "invalid_key",
    });
    const dumped = JSON.stringify({
      entry: health.get("gemini:gemini-2.5-flash"),
      report: health.debugReport(1_700_000_000_000),
    });
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toContain("supersecretvalue");
    expect(dumped).toContain("secret");
  });

  it("picks the same model for the same pool, and skips a model that lacks the task", () => {
    const blind = local("ollama:blind", { capabilities: { vision: false, chat: true } });
    const eyes = local("ollama:eyes", { capabilities: { vision: true, chat: true } });
    const options = { task: "vision", policy: "free-preferred", limit: 5, now: 1_700_000_000_000 };
    const first = router.planRoute([blind, eyes], options);
    const second = router.planRoute([blind, eyes], options);
    expect(first.candidates).toEqual(["ollama:eyes"]);
    expect(second.candidates).toEqual(first.candidates);
    expect(second.whyThisModel).toBe(first.whyThisModel);
    expect(first.whyThisModel).toMatch(/vision/);
    expect(first.rejected).toContainEqual({ id: "ollama:blind", reason: "capability" });
    expect(router.scoreModel(router.describe(eyes), options)).toBe(
      router.scoreModel(router.describe(eyes), options),
    );
  });
});

describe("local discovery", () => {
  it("routes only a loaded LM Studio model", () => {
    const native = models.lmStudioCatalog(
      {
        models: [
          { key: "loaded-one", loaded_instances: [{ id: "loaded-one" }] },
          { key: "sitting", loaded_instances: [] },
        ],
      },
      "v1",
    );
    expect(native.find((row: { id: string }) => row.id === "loaded-one").loaded).toBe(true);
    expect(native.find((row: { id: string }) => row.id === "sitting").loaded).toBe(false);
    const running = models.lmStudioResult("http://127.0.0.1:1234", native, 12);
    expect(running.models.map((row: { id: string }) => row.id)).toEqual(["loaded-one"]);
    expect(running.error).toBeNull();
    const empty = models.lmStudioResult(
      "http://127.0.0.1:1234",
      native.filter((row: { loaded: boolean }) => !row.loaded),
      4,
    );
    expect(empty.models).toEqual([]);
    expect(empty.error).toBe("LM Studio running, no model loaded");
    const legacy = models.lmStudioCatalog(
      {
        data: [
          { id: "old", state: "loaded" },
          { id: "idle", state: "not-loaded" },
        ],
      },
      "v0",
    );
    expect(legacy.map((row: { id: string; loaded: boolean }) => [row.id, row.loaded])).toEqual([
      ["old", true],
      ["idle", false],
    ]);
    const compat = models.lmStudioCatalog({ data: [{ id: "download-only" }] }, "openai");
    expect(compat[0].loaded).toBe(false);
    expect(models.lmStudioResult("http://127.0.0.1:1234", compat, 1).models).toEqual([]);
  });

  it("says when Ollama is down and does not route a stale id", () => {
    expect(models.ollamaListError({ ok: false, status: 0, error: "connect ECONNREFUSED" })).toBe(
      "Ollama not running",
    );
    expect(models.ollamaListError({ ok: false, status: 500, error: "HTTP 500" })).toBe("HTTP 500");
    expect(models.ollamaListError({ ok: true, status: 200 })).toBeNull();
    const stale = local("ollama:coder-ds", { loaded: false }, "unavailable");
    const plan = router.planRoute([stale, local("ollama:llama3.2")], {
      policy: "free-preferred",
    });
    expect(plan.candidates).toEqual(["ollama:llama3.2"]);
    expect(plan.rejected).toContainEqual({ id: "ollama:coder-ds", reason: "unavailable" });
    const view = router.usableModels([stale], { policy: "free-preferred", task: "chat" });
    expect(view.rows[0].visibility).toBe("disabled");
    expect(view.rows[0].disabledReason).toBe("Not available locally");
    const removed = router.classifyError({ status: 404, message: "model 'coder-ds' not found" });
    expect(removed.category).toBe("model_unavailable");
    expect(removed.delist).toBe(true);
  });
});
