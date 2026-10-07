/**
 * Route plan: hard reasons, quality targets, and non-retryable 400s.
 * The default score (no quality target, or balanced) stays today's order.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  createRoutingContract,
  normaliseQualityTarget,
  validateRoutingContract,
} from "../../src/lib/friday/model-routing-contract";

const require_ = createRequire(import.meta.url);
const router = require_("../../electron/model-router.cjs");
const access = require_("../../electron/model-access.cjs");

function localModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    type: "local",
    kind: "local",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    contextK: 32,
    status: "ready",
    role: "brain",
    capabilities: { chat: true, coding: true, reasoning: true, tools: true, vision: false },
    meta: { providerId: "ollama", kind: "local", modelName: id, resident: false, sizeGb: 4 },
    ...overrides,
  };
}

function cloudModel(
  id: string,
  providerId: string,
  billingMode = "ZERO_COST",
  overrides: Record<string, unknown> = {},
) {
  const record = access.makeRecord({
    billingMode,
    eligibility: "ELIGIBLE",
    verification: "VERIFIED",
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
    role: "brain",
    accessRecord: record,
    capabilities: { chat: true, coding: true, reasoning: true, tools: true, vision: true },
    meta: { providerId, kind: "cloud", modelName: id, accessRecord: record },
    ...overrides,
  };
}

describe("route plan", () => {
  const local = localModel("ollama:llama3.1");
  const cloud = cloudModel("groq:llama-fast", "groq");
  const pool = [local, cloud];

  it("rejects a cloud model under local-only for mode and never returns it", () => {
    const options = { mode: "local-only", policy: "free-preferred", now: 1_700_000_000_000 };
    const plan = router.planRoute(pool, options);
    const selected = router.selectEligible(pool, options);
    expect(selected.map((model: { id: string }) => model.id)).toEqual(["ollama:llama3.1"]);
    expect(plan.candidates).toEqual(selected.map((model: { id: string }) => model.id));
    expect(plan.rejected).toContainEqual({ id: "groq:llama-fast", reason: "mode" });
    expect(plan.candidates).not.toContain("groq:llama-fast");
  });

  it("drops a model that cannot call tools and does not fall back to it", () => {
    const plain = cloudModel("custom:plain-chat", "custom", "ZERO_COST", {
      capabilities: { chat: true, tools: false, vision: false, coding: true, reasoning: true },
    });
    const tooled = cloudModel("groq:tool-chat", "groq");
    const options = {
      mode: "cloud-only",
      policy: "free-preferred",
      requirements: { tools: true },
      now: 1_700_000_000_000,
    };
    const plan = router.planRoute([plain, tooled, local], options);
    expect(plan.candidates).toEqual(["groq:tool-chat"]);
    expect(plan.rejected).toContainEqual({ id: "custom:plain-chat", reason: "tools" });
    expect(plan.candidates).not.toContain("custom:plain-chat");
  });

  it("keeps a private request on this PC", () => {
    const options = {
      mode: "auto",
      policy: "free-preferred",
      requirements: { privacy: "private" },
      now: 1_700_000_000_000,
    };
    const plan = router.planRoute(pool, options);
    expect(plan.candidates).toEqual(["ollama:llama3.1"]);
    expect(plan.rejected).toContainEqual({ id: "groq:llama-fast", reason: "privacy" });
    expect(plan.constraints.privacy).toBe("private");
  });

  it("stays empty when private and cloud-only are both set", () => {
    const options = {
      mode: "cloud-only",
      policy: "free-preferred",
      requirements: { privacy: "private" },
      now: 1_700_000_000_000,
    };
    const plan = router.planRoute(pool, options);
    expect(plan.planType).toBe("none");
    expect(plan.candidates).toEqual([]);
    expect(plan.selected).toBeNull();
    expect(plan.why).toMatch(/private/i);
    expect(plan.why).toMatch(/cloud-only/i);
    expect(router.selectEligible(pool, options)).toEqual([]);
  });

  it("uses the same candidate ids as selectEligible", () => {
    const options = { mode: "auto", policy: "free-preferred", now: 1_700_000_000_000 };
    const plan = router.planRoute(pool, options);
    const selected = router.selectEligible(pool, options);
    expect(plan.candidates).toEqual(selected.map((model: { id: string }) => model.id));
    expect(plan.planType).toBe("primary-fallback");
  });

  it("does not change order when qualityTarget is omitted or balanced", () => {
    const options = { mode: "auto", policy: "free-preferred", now: 1_700_000_000_000 };
    const plain = router.selectEligible(pool, options).map((model: { id: string }) => model.id);
    const balanced = router
      .selectEligible(pool, { ...options, qualityTarget: "balanced" })
      .map((model: { id: string }) => model.id);
    expect(balanced).toEqual(plain);
    expect(plain.length).toBeGreaterThan(0);
  });

  it("lets fastest prefer the lower-latency model without moving the balanced order", () => {
    const slow = {
      id: "slow",
      role: "brain",
      type: "local",
      access: "free",
      accessRecord: {},
      capabilities: { chat: true },
      qualityProfile: { chatScore: 0.95, speedScore: 0.2, reasoningScore: 0.5, codingScore: 0.5 },
      contextK: 32,
      health: "available",
      latencyMs: 800,
      failures: 0,
      coolingDown: false,
      lastFailureAt: 0,
    };
    const fast = {
      ...slow,
      id: "fast",
      qualityProfile: { chatScore: 0.4, speedScore: 0.95, reasoningScore: 0.5, codingScore: 0.5 },
      latencyMs: 200,
    };
    const base = { task: "chat", policy: "free-preferred", now: 1 };
    expect(router.scoreModel(slow, base)).toBeGreaterThan(router.scoreModel(fast, base));
    expect(router.scoreModel(slow, { ...base, qualityTarget: "balanced" })).toBe(
      router.scoreModel(slow, base),
    );
    expect(router.scoreModel(fast, { ...base, qualityTarget: "fastest" })).toBeGreaterThan(
      router.scoreModel(slow, { ...base, qualityTarget: "fastest" }),
    );
  });

  it("moves cheapest, best-quality, and reliable only when that target is set", () => {
    const rich = {
      id: "rich",
      role: "brain",
      type: "cloud",
      access: "paid",
      accessRecord: {},
      capabilities: { chat: true, reasoning: true, coding: true },
      qualityProfile: { chatScore: 0.95, reasoningScore: 0.99, codingScore: 0.99, speedScore: 0.4 },
      contextK: 128,
      health: "available",
      latencyMs: 400,
      failures: 0,
      coolingDown: false,
      lastFailureAt: 0,
    };
    const bargain = {
      ...rich,
      id: "bargain",
      type: "local",
      access: "free",
      contextK: 8,
      qualityProfile: { chatScore: 0.4, reasoningScore: 0.35, codingScore: 0.35, speedScore: 0.5 },
    };
    const reasoning = { task: "reasoning", policy: "allow-paid", now: 1 };
    expect(router.scoreModel(rich, reasoning)).toBeGreaterThan(
      router.scoreModel(bargain, reasoning),
    );
    expect(router.scoreModel(bargain, { ...reasoning, qualityTarget: "cheapest" })).toBeGreaterThan(
      router.scoreModel(rich, { ...reasoning, qualityTarget: "cheapest" }),
    );
    const balancedGap = router.scoreModel(rich, reasoning) - router.scoreModel(bargain, reasoning);
    const qualityGap =
      router.scoreModel(rich, { ...reasoning, qualityTarget: "best-quality" }) -
      router.scoreModel(bargain, { ...reasoning, qualityTarget: "best-quality" });
    expect(qualityGap).toBeGreaterThan(balancedGap);

    const sharp = {
      id: "sharp",
      role: "brain",
      type: "local",
      access: "free",
      accessRecord: {},
      capabilities: { chat: true },
      qualityProfile: { chatScore: 0.99, speedScore: 0.5, reasoningScore: 0.5, codingScore: 0.5 },
      contextK: 32,
      health: "unknown",
      failures: 1,
      coolingDown: false,
      lastFailureAt: 0,
      latencyMs: null,
    };
    const steady = {
      ...sharp,
      id: "steady",
      failures: 0,
      qualityProfile: { chatScore: 0.4, speedScore: 0.5, reasoningScore: 0.5, codingScore: 0.5 },
    };
    const chat = { task: "chat", policy: "free-preferred", now: 1 };
    expect(router.scoreModel(sharp, chat)).toBeGreaterThan(router.scoreModel(steady, chat));
    expect(router.scoreModel(steady, { ...chat, qualityTarget: "reliable" })).toBeGreaterThan(
      router.scoreModel(sharp, { ...chat, qualityTarget: "reliable" }),
    );
  });

  it("does not probe cloud models for a private turn", () => {
    expect(
      router.selectVerificationCandidates(pool, {
        requirements: { privacy: "private" },
        policy: "free-preferred",
      }),
    ).toEqual([]);
    expect(
      router.selectVerificationCandidates(pool, {
        qualityTarget: "private",
        policy: "free-preferred",
      }),
    ).toEqual([]);
  });

  it("rejects name-only vision evidence and a retired model", () => {
    const named = {
      id: "ollama:mystery-vision-x",
      label: "mystery-vision-x",
      type: "local",
      kind: "local",
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      contextK: 8,
      status: "ready",
      role: "brain",
      meta: { providerId: "ollama", kind: "local", modelName: "mystery-vision-x", sizeGb: 4 },
    };
    const declared = localModel("ollama:eye", {
      capabilities: { chat: true, vision: true, tools: false, coding: false, reasoning: false },
    });
    const retired = localModel("ollama:old", { lifecycle: "retired" });
    const options = {
      task: "vision",
      mode: "local-only",
      policy: "free-preferred",
      now: 1_700_000_000_000,
    };
    const plan = router.planRoute([named, declared, retired], options);
    expect(plan.rejected).toContainEqual({ id: "ollama:mystery-vision-x", reason: "evidence" });
    expect(plan.rejected).toContainEqual({ id: "ollama:old", reason: "retired" });
    expect(plan.candidates).toContain("ollama:eye");
    const allowed = router.planRoute([named, declared], {
      ...options,
      requirements: { allowInferred: true },
    });
    expect(allowed.candidates).toContain("ollama:mystery-vision-x");
  });

  it("assigns critic, judge, and pipeline roles and keeps a stable plan id", () => {
    const local = { id: "a", type: "local", provider: "ollama", meta: { providerId: "ollama" } };
    const same = { id: "b", type: "local", provider: "ollama", meta: { providerId: "ollama" } };
    const cloud = { id: "c", type: "cloud", provider: "groq", meta: { providerId: "groq" } };
    expect(router.assignSteps([local, cloud], "primary-critic")).toEqual([
      { modelEndpointId: "a", role: "primary" },
      { modelEndpointId: "c", role: "critic" },
    ]);
    const judged = router.assignSteps([local, same, cloud], "candidate-judge");
    expect(judged.at(-1)).toEqual({ modelEndpointId: "c", role: "judge" });
    expect(
      router
        .assignSteps([local, same, cloud], "pipeline")
        .map((step: { role: string }) => step.role),
    ).toEqual(["planner", "specialist", "synthesizer"]);
    const turn = router.compileRoleTurn({
      strategy: "primary-critic",
      role: "critic",
      prompt: "Check the dates",
      drafts: [{ modelId: "a", text: "Tuesday" }],
    });
    expect(turn).toContain("Check the dates");
    expect(turn).toContain("Tuesday");
    expect(turn).toContain("concrete errors");
    const plan = router.planRoute(pool, {
      mode: "multi",
      preferred: ["ollama:llama3.1", "groq:llama-fast"],
      strategy: "primary-verifier",
      policy: "free-preferred",
      now: 1_700_000_000_000,
    });
    expect(plan.strategy).toBe("primary-verifier");
    expect(plan.steps.map((step: { role: string }) => step.role)).toEqual(["primary", "verifier"]);
    expect(plan.planId).toMatch(/^route-/);
    expect(plan.explanation[0]).toMatch(/primary-verifier/);
    expect(plan.trace.map((row: { stage: string }) => row.stage)).toEqual([
      "filter",
      "score",
      "plan",
    ]);
    expect(plan.budgets.concurrency).toBe(1);
  });

  it("interleaves model families when the quality target is diverse", () => {
    const family = (id: string, name: string) =>
      localModel(id, {
        meta: {
          providerId: "ollama",
          kind: "local",
          modelName: id,
          resident: false,
          sizeGb: 4,
          family: name,
        },
      });
    const alphaA = family("ollama:a", "alpha");
    const alphaB = family("ollama:b", "alpha");
    const beta = family("ollama:c", "beta");
    const options = {
      mode: "local-only",
      policy: "free-preferred",
      limit: 3,
      now: 1_700_000_000_000,
    };
    expect(
      router
        .selectEligible([alphaA, alphaB, beta], options)
        .map((model: { id: string }) => model.id),
    ).toEqual(["ollama:a", "ollama:b", "ollama:c"]);
    expect(
      router
        .selectEligible([alphaA, alphaB, beta], { ...options, qualityTarget: "diverse" })
        .map((model: { id: string }) => model.id),
    ).toEqual(["ollama:a", "ollama:c", "ollama:b"]);
  });

  it("honours Retry-After on a 429 and keeps the default cooldown otherwise", () => {
    expect(
      router.classifyError({ status: 429, message: "rate limit", retryAfter: 2 }).cooldownMs,
    ).toBe(2000);
    expect(router.classifyError("HTTP 429: rate limit exceeded").cooldownMs).toBe(60_000);
  });

  it("plans a parallel run only for multi with at least two candidates", () => {
    const plan = router.planRoute(pool, {
      mode: "multi",
      preferred: ["ollama:llama3.1", "groq:llama-fast"],
      policy: "free-preferred",
      now: 1_700_000_000_000,
    });
    expect(plan.planType).toBe("parallel");
    expect(plan.candidates).toEqual(["ollama:llama3.1", "groq:llama-fast"]);
  });

  it("mirrors qualityTarget on the TypeScript contract and rejects an unknown one", () => {
    const contract = createRoutingContract({ routeMode: "auto" });
    expect(contract.qualityTarget).toBe("balanced");
    expect(normaliseQualityTarget("fastest")).toBe("fastest");
    expect(normaliseQualityTarget("nope")).toBe("balanced");
    const desktop = router.createRoutingContract({ routeMode: "auto", qualityTarget: "reliable" });
    expect(desktop.qualityTarget).toBe("reliable");
    expect(validateRoutingContract({ ...contract, qualityTarget: "sideways" }).ok).toBe(false);
    expect(router.validateRoutingContract({ ...desktop, qualityTarget: "sideways" }).ok).toBe(
      false,
    );
  });
});

describe("deterministic request errors", () => {
  it("does not retry or cool down HTTP 400 or 422", () => {
    for (const sample of [
      "HTTP 400: malformed request",
      { status: 422, message: "invalid request" },
    ]) {
      const classified = router.classifyError(sample);
      expect(classified.category).toBe("invalid_request");
      expect(classified.retryable).toBe(false);
      expect(classified.cooldownMs).toBe(0);
    }
    const health = new router.ProviderHealthManager();
    const now = 1_700_000_000_000;
    const noted = health.noteFailure("ollama:llama3.1", "HTTP 400: unsupported parameter", now);
    expect(noted.category).toBe("invalid_request");
    expect(noted.cooldownMs).toBe(0);
    expect(health.isCoolingDown("ollama:llama3.1", now)).toBe(false);
    expect(health.isCoolingDown("ollama:llama3.1", now + 60_000)).toBe(false);
  });

  it("still retries a provider 500 and still refuses a bad key", () => {
    const outage = router.classifyError("HTTP 500: provider error");
    expect(outage.category).toBe("provider_error");
    expect(outage.retryable).toBe(true);
    expect(outage.cooldownMs).toBeGreaterThan(0);
    const key = router.classifyError({ status: 401, message: "invalid api key" });
    expect(key.category).toBe("invalid_key");
    expect(key.retryable).toBe(false);
    const overflow = router.classifyError("HTTP 400: context length exceeded");
    expect(overflow.category).toBe("context_overflow");
    expect(overflow.retryable).toBe(false);
  });

  it("scores a model from recorded outcomes and keeps a private cascade local", () => {
    const weak = localModel("ollama:weak", {
      outcomes: { trials: 10, successes: 2, meanLatencyMs: 1500 },
    });
    const strong = localModel("ollama:strong", {
      outcomes: { trials: 10, successes: 9, meanLatencyMs: 400, ownerUp: 1 },
    });
    const now = 1_700_000_000_000;
    const health = new router.ProviderHealthManager();
    expect(router.scoreModel(router.describe(strong, health, now), { now })).toBeGreaterThan(
      router.scoreModel(router.describe(weak, health, now), { now }),
    );
    const paid = { ...cloudModel("openai:paid", "openai", "PAID"), access: "paid" };
    const plan = router.planRoute([paid, localModel("ollama:llama3.1")], {
      strategy: "cascade",
      requirements: { privacy: "private" },
      now,
    });
    expect(plan.candidates).toEqual(["ollama:llama3.1"]);
    expect(plan.rejected).toContainEqual({ id: "openai:paid", reason: "privacy" });
    expect(router.cascadeAccepts("short")).toBe(false);
    expect(router.cascadeAccepts("This answer is long enough to keep.")).toBe(true);
    expect(router.cascadeAccepts("I don't know how to finish this sentence at all.")).toBe(false);
  });

  it("assigns cascade and race roles without a second router", () => {
    const cheap = { ...localModel("ollama:cheap"), access: "free" };
    const strong = { ...cloudModel("openai:strong", "openai", "PAID"), access: "paid" };
    expect(
      router.assignSteps([strong, cheap], "cascade").map((step: { role: string }) => step.role),
    ).toEqual(["cheap", "strong"]);
    expect(
      router
        .assignSteps([strong, cheap], "cascade")
        .map((step: { modelEndpointId: string }) => step.modelEndpointId),
    ).toEqual(["ollama:cheap", "openai:strong"]);
    const other = localModel("ollama:other");
    const raced = router.planRoute([cheap, other], { strategy: "race", now: 1 });
    expect(raced.strategy).toBe("race");
    expect(raced.budgets.concurrency).toBe(2);
    expect(raced.steps.every((step: { role: string }) => step.role === "racer")).toBe(true);
    const judged = router.classifyTask("fix this typescript bug");
    expect(judged.task).toBe("coding");
    expect(judged.source).toBe("rules");
    const preview = router.previewRoute([cheap], "summarise the notes", { now: 1 });
    expect(preview.judged.preset).toBe("summarization");
    expect(preview.plan.candidates).toEqual(["ollama:cheap"]);
  });
});
